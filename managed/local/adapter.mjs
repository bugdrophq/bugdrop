import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createServer } from 'node:http';
import { lookup } from 'node:dns';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let dispatcherUsers = 0;
let originalDispatcher;
let localDispatcher;
function acquireLoopback() {
  if (dispatcherUsers++ === 0) {
    originalDispatcher = getGlobalDispatcher();
    localDispatcher = new Agent({
      connect: {
        lookup(host, options, callback) {
          if (host === 'bugdrop-managed.localhost') {
            if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
            else callback(null, '127.0.0.1', 4);
          } else lookup(host, options, callback);
        },
      },
    });
    setGlobalDispatcher({
      dispatch(options, handler) {
        if (new URL(String(options.origin)).hostname === 'bugdrop-managed.localhost') {
          return localDispatcher.dispatch(options, handler);
        }
        return originalDispatcher.dispatch(options, handler);
      },
    });
  }
}
async function releaseLoopback() {
  if (--dispatcherUsers === 0) {
    setGlobalDispatcher(originalDispatcher);
    await localDispatcher.close();
  }
}
const normalized = outcome => ({ schemaVersion: 1, outcome });
const acceptedOutcomes = new Set([
  'delivered',
  'delivering',
  'indeterminate',
  'failed_before_delivery',
  'rejected',
]);

/** Local test seam only. Fixtures and ephemeral authority never become deployable configuration. */
export async function start({ fixtures }) {
  const directory = await mkdtemp(join(tmpdir(), 'bugdrop-managed-local-'));
  let runtime;
  let server;
  let registered = false;
  let closed = false;
  const held = new Set();
  try {
    for (const role of ['ingress', 'delivery', 'protocol', 'uninstall']) {
      await build({
        entryPoints: [join(root, 'src/managed/local', `${role}.ts`)],
        outfile: join(directory, `${role}.mjs`),
        bundle: true,
        format: 'esm',
        platform: 'node',
        external: ['cloudflare:workers'],
        logLevel: 'silent',
      });
    }
    const protocol = await import(pathToFileURL(join(directory, 'protocol.mjs')).href);
    const { authorizedUninstall } = await import(
      pathToFileURL(join(directory, 'uninstall.mjs')).href
    );
    const webhookSecret = randomBytes(32).toString('base64url');
    const credential = fixtures['api-key-credential.v1.json'];
    const derived = await protocol.derive(credential.apiKey);
    const pepper = randomBytes(32).toString('base64url');
    const receiptKey = randomBytes(32).toString('base64url');
    const verifier = await protocol.hmac(pepper, protocol.bearer(derived.authorization).authSecret);
    const origin = 'https://example.com';
    let offset = 0;
    let frozenAge = null;
    let mode = 'delivered';
    let canary = '';
    let attempts = 0;
    const outcomes = [];
    const submissionResponses = [];
    const evidenceRequests = [];
    const logs = [];
    const networkRequests = [];
    const fakeGithubAttempts = [];
    class CaptureLog extends Log {
      logWithLevel(_level, message) {
        logs.push(String(message));
      }
      logReady() {}
    }
    const denyOutbound = () => {
      networkRequests.push({ kind: 'unexpected_network' });
      return new Response(null, { status: 503 });
    };
    const sdkVersions = new Set();
    const receiptNames = new Set();
    const projection = {
      tenantId: 'local-tenant',
      applicationId: 'local-application',
      destinationId: 'local-destination',
      installationId: '42',
      configurationVersion: 1,
      authorizationVersion: 1,
      origin,
      keyId: derived.keyId,
      verifier,
      credentialActive: true,
      applicationActive: true,
      installationActive: true,
      tenantActive: true,
      observedAt: Date.now(),
    };
    const now = () => Date.now() + offset;
    let signingKid = 'local-key-1';
    const signingKeys = [];
    async function addKey(kid) {
      const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
      signingKeys.push({
        kid,
        privateKey: await webcrypto.subtle.exportKey('jwk', key.privateKey),
        publicKey: await webcrypto.subtle.exportKey('jwk', key.publicKey),
        notBefore: now(),
        verifyUntil: now() + 86_400_000,
      });
    }
    await addKey(signingKid);
    // A harness-owned source simulates periodic projection acknowledgement. Expiry freezes it.
    const snapshot = signer => {
      if (frozenAge === null) projection.observedAt = now();
      return {
        now: now(),
        projection: { ...projection },
        pepper,
        receiptKey,
        signingKid,
        signingKeys: signingKeys.map(k => (signer ? { ...k } : { ...k, privateKey: undefined })),
      };
    };
    const fake = async () => {
      attempts++;
      const attemptMode = mode;
      fakeGithubAttempts.push({ attempt: attempts, mode: attemptMode });
      if (attemptMode === 'hold' || attemptMode === 'timeout') {
        await new Promise(resolve => {
          held.add(resolve);
        });
      }
      return Response.json({
        outcome: attemptMode === 'delivered' ? 'delivered' : 'indeterminate',
        discarded: canary,
      });
    };
    const collectSubmission = text => {
      submissionResponses.push(text);
      return JSON.parse(text);
    };
    async function collectEvidence(request) {
      const text = await request.text();
      const allowed = {
        'content-type': 'text/plain;charset=UTF-8',
        'content-length': '5',
        host: 'evidence.bugdrop.localhost',
      };
      const headers = {};
      let unexpectedHeaders = false;
      for (const [name, value] of request.headers) {
        if (!(name in allowed)) {
          unexpectedHeaders = true;
          continue;
        }
        headers[name] = value === allowed[name] ? allowed[name] : 'unexpected';
        if (value !== allowed[name]) unexpectedHeaders = true;
      }
      // Test observer only: unknown raw header names/values are never copied into evidence.
      evidenceRequests.push({ body: text, headers, unexpectedHeaders });
      if (text === '0.1.0') sdkVersions.add('0.1.0');
      return new Response(null, { status: 204 });
    }
    async function boot() {
      const ingressConfig = JSON.parse(
        await readFile(join(root, 'managed/local/ingress.json'), 'utf8')
      );
      const deliveryConfig = JSON.parse(
        await readFile(join(root, 'managed/local/delivery.json'), 'utf8')
      );
      runtime = new Miniflare({
        // Only the internal bind address is numeric; every exposed URL uses the named local host.
        host: '127.0.0.1',
        log: new CaptureLog(LogLevel.INFO),
        durableObjectsPersist: join(directory, 'state'),
        workers: [
          {
            name: ingressConfig.name,
            outboundService: denyOutbound,
            modules: true,
            modulesRoot: directory,
            scriptPath: join(directory, 'ingress.mjs'),
            compatibilityDate: ingressConfig.compatibility_date,
            compatibilityFlags: ingressConfig.compatibility_flags,
            serviceBindings: {
              LOCAL_AUTHORITY: () => Response.json(snapshot(true)),
              LOCAL_DELIVERY: deliveryConfig.name,
              LOCAL_EVIDENCE: collectEvidence,
            },
          },
          {
            name: deliveryConfig.name,
            outboundService: denyOutbound,
            modules: true,
            modulesRoot: directory,
            scriptPath: join(directory, 'delivery.mjs'),
            compatibilityDate: deliveryConfig.compatibility_date,
            compatibilityFlags: deliveryConfig.compatibility_flags,
            serviceBindings: {
              LOCAL_AUTHORITY: () => Response.json(snapshot(false)),
              LOCAL_FAKE_GITHUB: fake,
            },
            durableObjects: {
              LOCAL_RECEIPTS: { className: 'LocalManagedReceipt', useSQLite: true },
            },
          },
        ],
      });
      await runtime.ready;
    }
    await boot();
    server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/submission-capabilities')
          throw new Error('rejected');
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65536) throw new Error('rejected');
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const name of [
          'authorization',
          'content-type',
          'accept',
          'x-bugdrop-contract-version',
          'x-bugdrop-sdk-version',
        ]) {
          if (typeof request.headers[name] === 'string') headers.set(name, request.headers[name]);
        }
        const worker = await runtime.getWorker('bugdrop-managed-harness-ingress');
        const result = await worker.fetch(
          'http://bugdrop-managed.localhost/v1/submission-capabilities',
          { method: 'POST', headers, body: Buffer.concat(chunks) }
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end('{"error":"managed_request_rejected"}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    acquireLoopback();
    registered = true;
    const endpoint = `http://bugdrop-managed.localhost:${server.address().port}/v1/submission-capabilities`;
    async function inspectReceipt(bound) {
      const name = await protocol.hmac(
        receiptKey,
        protocol.utf8(JSON.stringify([projection.applicationId, bound.submissionId]))
      );
      const ns = await runtime.getDurableObjectNamespace(
        'LOCAL_RECEIPTS',
        'bugdrop-managed-harness-delivery'
      );
      return (
        await ns.get(ns.idFromName(name)).fetch('http://receipt.bugdrop.localhost/_local/state')
      ).json();
    }
    return {
      endpoint,
      origin,
      async submit({ capability, binding, requestBody, origin: suppliedOrigin = origin }) {
        let outcome = 'rejected';
        try {
          const raw =
            typeof requestBody === 'string' ? Buffer.from(requestBody) : Buffer.from(requestBody);
          const name = await protocol.hmac(
            receiptKey,
            protocol.utf8(JSON.stringify([projection.applicationId, binding.submissionId]))
          );
          receiptNames.add(name);
          const worker = await runtime.getWorker('bugdrop-managed-harness-ingress');
          const reply = await worker.fetch('http://bugdrop-managed.localhost/_local/submit', {
            method: 'POST',
            body: JSON.stringify({
              token: capability.token,
              origin: suppliedOrigin,
              binding,
              body: raw.toString('base64url'),
            }),
          });
          const text = await reply.text();
          const value = collectSubmission(text);
          if (acceptedOutcomes.has(value.outcome)) outcome = value.outcome;
        } catch {
          outcome = 'rejected';
        }
        const value = normalized(outcome);
        outcomes.push(value);
        return value;
      },
      async uninstall({
        validSignature = true,
        installationId = 42,
        action = 'deleted',
        event = 'installation',
        tamperBody = false,
      } = {}) {
        const raw = protocol.utf8(JSON.stringify({ action, installation: { id: installationId } }));
        const mac = await protocol.hmac(webhookSecret, raw);
        const signature = 'sha256=' + Buffer.from(mac, 'base64url').toString('hex');
        const accepted = await authorizedUninstall(
          tamperBody
            ? protocol.utf8(
                JSON.stringify({ action: 'created', installation: { id: installationId } })
              )
            : raw,
          validSignature ? signature : 'sha256=' + '0'.repeat(64),
          event,
          projection.installationId,
          webhookSecret
        );
        if (accepted && projection.installationActive) {
          projection.installationActive = false;
          projection.authorizationVersion++;
        }
        return { accepted };
      },
      revoke({ scope = 'credential' } = {}) {
        if (!['credential', 'application', 'installation', 'tenant'].includes(scope))
          throw new Error('invalid_test_control');
        projection[`${scope}Active`] = false;
        projection.authorizationVersion++;
      },
      async probeCapture({ submissionResponse, sdkReport } = {}) {
        if (submissionResponse !== undefined)
          collectSubmission(
            typeof submissionResponse === 'string'
              ? submissionResponse
              : JSON.stringify(submissionResponse)
          );
        if (sdkReport !== undefined)
          await collectEvidence(
            new Request('http://evidence.bugdrop.localhost/sdk', {
              method: 'POST',
              body: String(sdkReport),
            })
          );
      },
      replaceAuthorizationContext(changes) {
        for (const [key, value] of Object.entries(changes)) {
          if (
            !['tenantId', 'applicationId', 'destinationId'].includes(key) ||
            typeof value !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(value)
          )
            throw new Error('invalid_test_control');
          projection[key] = value;
        }
      },
      expireAuthorizationState() {
        projection.observedAt = now() - 30_001;
        frozenAge = true;
      },
      refreshAuthorizationState() {
        projection.observedAt = now();
        frozenAge = null;
      },
      advanceClock(ms) {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid_test_control');
        offset += ms;
      },
      setDeliveryIndeterminate() {
        mode = 'indeterminate';
      },
      setDeliveryMode(value, options = {}) {
        if (!['delivered', 'indeterminate', 'timeout', 'hold'].includes(value))
          throw new Error('invalid_test_control');
        mode = value;
        canary = options.canary ?? '';
      },
      releaseDelivery() {
        for (const release of held) release();
        held.clear();
      },
      async rotateSigningKey({ retirePrevious = false } = {}) {
        if (retirePrevious) for (const key of signingKeys) key.verifyUntil = now();
        signingKid = `local-key-${signingKeys.length + 1}`;
        await addKey(signingKid);
      },
      async restart() {
        await runtime.dispose();
        for (const release of held) release();
        held.clear();
        await boot();
      },
      inspectReceipt,
      async evidence() {
        const ns = await runtime.getDurableObjectNamespace(
          'LOCAL_RECEIPTS',
          'bugdrop-managed-harness-delivery'
        );
        const receipts = [];
        for (const name of receiptNames) {
          const value = await (
            await ns.get(ns.idFromName(name)).fetch('http://receipt.bugdrop.localhost/_local/state')
          ).json();
          if (value) receipts.push(value);
        }
        return structuredClone({
          attempts,
          outcomes,
          submissionResponses,
          evidenceRequests,
          receipts,
          logs,
          networkRequests,
          fakeGithubAttempts,
          capabilities: {
            queues: 'absent-no-binding',
            analytics: 'absent-no-binding',
            logs: 'captured',
            outbound: 'denied-and-captured',
          },
          sdkVersions: [...sdkVersions],
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        for (const release of held) release();
        held.clear();
        await runtime.dispose();
        if (registered) await releaseLoopback();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch {
    server?.closeAllConnections();
    server?.close();
    for (const release of held) release();
    await runtime?.dispose();
    if (registered) await releaseLoopback();
    await rm(directory, { recursive: true, force: true });
    throw new Error('local_service_start_failed');
  }
}
