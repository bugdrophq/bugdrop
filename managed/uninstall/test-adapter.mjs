// Local-only SQLite DO fixture. The default SQL adapter below is synthetic;
// cross-plane tests inject the data owner's actual Postgres adapter explicitly.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** @param {{config: import('../../src/managed/github-staging/config').StagingGitHubConfig, sqlApply?: (value: import('../../src/managed/uninstall/reconciliation').ReconciliationCommand) => unknown, controlRoot?: string, applicationId?: string, recovery?: boolean}} options */
export async function start({
  config,
  sqlApply,
  controlRoot,
  applicationId = 'app-test',
  recovery = false,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'bugdrop-uninstall-'));
  const key = randomBytes(32).toString('base64url');
  const edgeKey = randomBytes(32).toString('base64url');
  const sqlKey = randomBytes(32).toString('base64url');
  const recoveryKey = randomBytes(32).toString('base64url');
  /** @type {{calls: number, mode: string, hook?: (proof: Record<string, unknown>) => Promise<Record<string, unknown>>}} */
  const recoveryFixture = { calls: 0, mode: 'ok', hook: undefined };
  const controlKey = randomBytes(32).toString('base64url');
  const webhookSecret = randomBytes(32).toString('base64url');
  const mac = (secret, text, encoding = 'base64url') =>
    createHmac('sha256', Buffer.from(secret, 'base64url')).update(text).digest(encoding);
  const scope = JSON.stringify([config.appId, config.installationId]);
  const identity = {
    schemaVersion: 1,
    eventHash: mac(key, `bugdrop:uninstall:deleted:v1\0${scope}`, 'hex'),
    installationHash: mac(key, `bugdrop:uninstall:installation:v1\0${scope}`, 'hex'),
  };
  let runtime,
    now = Date.now() + (sqlApply ? 0 : 3_600_000);
  const modes = { edge: 'ok', sql: 'ok' };
  const calls = { edge: 0, sql: 0 };
  /** @type {{hook?: (side: string) => Promise<void>}} */
  const transportFixture = {};
  const logs = [];
  const ledger = [];
  let syncCount = 0;
  let fault = { at: 0, action: 'ok' };
  let edgeLatched = false;
  const sqlReceipts = new Map();
  class CaptureLog extends Log {
    logWithLevel(_level, message) {
      logs.push(message);
    }
    logReady() {}
  }
  await build({
    entryPoints: [resolve('managed/uninstall/fault-worker.mjs')],
    outfile: join(directory, 'worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['cloudflare:workers'],
    logLevel: 'silent',
  });
  await build({
    entryPoints: ['src/managed/uninstall/reconciliation.ts'],
    outfile: join(directory, 'reconciliation.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { reconcileVerifiedUninstall } = await import(
    pathToFileURL(join(directory, 'reconciliation.mjs')).href
  );
  if (controlRoot)
    await build({
      stdin: {
        contents: `
      import { StagingAuthorization } from ${JSON.stringify(join(controlRoot, 'src/managed/staging/authorization.ts'))};
      export class TestAuthorization extends StagingAuthorization {
        async fetch(request) {
          if(new URL(request.url).pathname === '/_test/storage') return Response.json({
            revocation:this.ctx.storage.sql.exec('SELECT * FROM revocation').toArray(),
            authorization:this.ctx.storage.sql.exec('SELECT * FROM authorization').toArray()
          });
          return super.fetch(request);
        }
      }
      export default {fetch(request,env) { return env.STAGING_AUTHORIZATIONS.get(env.STAGING_AUTHORIZATIONS.idFromName(env.STAGING_APPLICATION_ID)).fetch(request); }};
    `,
        resolveDir: process.cwd(),
      },
      outfile: join(directory, 'authority.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      external: ['cloudflare:workers'],
      logLevel: 'silent',
    });
  async function transport(side, request) {
    if (new URL(request.url).pathname === '/_test/warm-binding') return new Response('warm');
    const entry = { side, settled: false, status: null, startedAt: Date.now(), finishedAt: null };
    ledger.push(entry);
    try {
      const response = await exchangeTransport(side, request);
      entry.status = response.status;
      return response;
    } finally {
      entry.settled = true;
      entry.finishedAt = Date.now();
    }
  }
  async function exchangeTransport(side, request) {
    calls[side]++;
    const scopedInstallationId = String(config.installationId);
    const scopedApplicationId = applicationId;
    await transportFixture.hook?.(side);
    const raw = await request.text();
    const secret = side === 'edge' ? edgeKey : sqlKey;
    const signed = side === 'edge' ? raw : `bugdrop:uninstall:sql-request:v1\0${raw}`;
    if (request.headers.get('X-BugDrop-Control-Signature') !== mac(secret, signed))
      return new Response(null, { status: 401 });
    const mode = modes[side];
    if (['401', '404', '500', '503'].includes(mode))
      return new Response(null, { status: Number(mode) });
    if (mode === 'generic') return Response.json({ schemaVersion: 1, accepted: true });
    if (side === 'sql') {
      const response = await reconcileVerifiedUninstall(
        new Request(request.url, {
          method: 'POST',
          body: raw,
          headers: Object.fromEntries(request.headers),
        }),
        { installationId: scopedInstallationId, key: sqlKey },
        async input => {
          if (mode === 'missing') return { state: 'quarantined', reason: 'mapping_missing' };
          if (sqlApply) return sqlApply(input);
          if (!sqlReceipts.has(input.eventHash))
            sqlReceipts.set(input.eventHash, { ...input, sqlApplied: true });
          return sqlReceipts.get(input.eventHash);
        }
      );
      if (mode === 'lost') {
        await response.body?.cancel();
        return new Response(null, { status: 503 });
      }
      if (mode === 'forged') response.headers.set('X-BugDrop-Uninstall-Receipt-Signature', 'bad');
      return response;
    }
    if (side === 'edge' && controlRoot) {
      const response = await (
        await runtime.getWorker('authority')
      ).fetch(request.url, {
        method: 'POST',
        body: raw,
        headers: Object.fromEntries(request.headers),
      });
      if (mode === 'lost') {
        await response.body?.cancel();
        return new Response(null, { status: 503 });
      }
      if (mode === 'forged') response.headers.set('X-BugDrop-Uninstall-Receipt-Signature', 'bad');
      return response;
    }
    edgeLatched = true;
    const receipt = {
      schemaVersion: 1,
      accepted: true,
      applicationId: scopedApplicationId,
      installationId: scopedInstallationId,
      revoked: true,
    };
    if (mode === 'lost') return new Response(null, { status: 503 });
    const response = JSON.stringify(receipt);
    return new Response(response, {
      headers: {
        'Content-Type': 'application/json',
        'X-BugDrop-Uninstall-Receipt-Signature':
          mode === 'forged'
            ? 'bad'
            : mac(
                secret,
                `bugdrop:uninstall:${side === 'edge' ? 'edge' : 'sql'}-receipt:v1\0${response}`
              ),
      },
    });
  }
  async function boot() {
    const common = {
      modules: true,
      modulesRoot: directory,
      compatibilityDate: '2026-06-10',
      compatibilityFlags: ['nodejs_compat'],
      outboundService: () => {
        throw new Error('unexpected_local_outbound');
      },
    };
    runtime = new Miniflare({
      host: 'uninstall.bugdrop.localhost',
      durableObjectsPersist: join(directory, 'state'),
      log: new CaptureLog(LogLevel.INFO),
      workers: [
        {
          ...common,
          name: 'probe',
          scriptPath: join(directory, 'probe.mjs'),
          script: `export default {fetch(request,env) {const u=new URL(request.url);if(u.pathname==='/github/staging/webhook') return env.WEBHOOK.fetch(request);if(u.pathname.startsWith('/_control/')) {u.pathname=u.pathname.slice(9);return env.CONTROL.fetch(new Request(u,request));}return env.COORDINATOR.fetch(request);}}`,
          serviceBindings: {
            WEBHOOK: { name: 'coordinator', entrypoint: 'GithubWebhook' },
            CONTROL: { name: 'coordinator', entrypoint: 'UninstallControl' },
            COORDINATOR: 'coordinator',
          },
        },
        {
          ...common,
          name: 'coordinator',
          scriptPath: join(directory, 'worker.mjs'),
          durableObjects: { STAGING_UNINSTALLS: { className: 'TestUninstall', useSQLite: true } },
          bindings: {
            ENVIRONMENT: 'staging',
            STAGING_ENABLED: 'true',
            STAGING_APPLICATION_ID: applicationId,
            STAGING_GITHUB_WEBHOOK_SECRET: webhookSecret,
            FIXTURE_OBJECT_NAME: identity.installationHash,
            STAGING_GITHUB_TARGET_JSON: JSON.stringify(config),
            STAGING_UNINSTALL_COMMITMENT_KEY: key,
            STAGING_UNINSTALL_HMAC_KEY: edgeKey,
            STAGING_RECONCILIATION_HMAC_KEY: sqlKey,
            FIXTURE_NOW: String(now),
            ...(recovery ? { STAGING_UNINSTALL_RECOVERY_HMAC_KEY: recoveryKey } : {}),
          },
          serviceBindings: {
            ...(recovery
              ? {
                  STAGING_UNINSTALL_RECOVERY: async request => {
                    if (new URL(request.url).pathname === '/_test/warm-binding')
                      return new Response('warm');
                    recoveryFixture.calls++;
                    const raw = await request.text();
                    if (
                      request.headers.get('X-BugDrop-Recovery-Signature') !==
                      mac(recoveryKey, `bugdrop:uninstall:recovery-request:v1\0${raw}`)
                    )
                      return new Response(null, { status: 401 });
                    const command = JSON.parse(raw);
                    let proof = {
                      ...command,
                      verifiedAt: now,
                      providerRemoved: true,
                      mappingConfirmed: true,
                      internalMapping: {
                        applicationId,
                        installationId: '11111111-1111-4111-8111-111111111111',
                      },
                    };
                    if (recoveryFixture.hook) proof = await recoveryFixture.hook(proof);
                    const response = JSON.stringify(proof);
                    return new Response(response, {
                      headers: {
                        'X-BugDrop-Recovery-Signature':
                          recoveryFixture.mode === 'forged'
                            ? 'invalid'
                            : mac(
                                recoveryKey,
                                `bugdrop:uninstall:recovery-receipt:v1\0${response}`
                              ),
                      },
                    });
                  },
                }
              : {}),
            TEST_UNINSTALL_SYNC: () => new Response(++syncCount === fault.at ? fault.action : 'ok'),
            STAGING_CONTROL: request => transport('edge', request),
            STAGING_RECONCILIATION: request => transport('sql', request),
          },
        },
        ...(controlRoot
          ? [
              {
                ...common,
                name: 'authority',
                scriptPath: join(directory, 'authority.mjs'),
                bindings: {
                  ENVIRONMENT: 'staging',
                  STAGING_ENABLED: 'true',
                  STAGING_APPLICATION_ID: applicationId,
                  STAGING_INSTALLATION_ID: String(config.installationId),
                  STAGING_UNINSTALL_HMAC_KEY: edgeKey,
                  STAGING_CONTROL_HMAC_KEY: controlKey,
                },
                durableObjects: {
                  STAGING_AUTHORIZATIONS: { className: 'TestAuthorization', useSQLite: true },
                },
              },
            ]
          : []),
      ],
    });
    await runtime.ready;
  }
  try {
    await boot();
  } catch (error) {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const rawRequest = (path, init) =>
    runtime.dispatchFetch(`http://uninstall.bugdrop.localhost${path}`, init);
  const request = (path, altered) => {
    const body = JSON.stringify(altered ?? identity);
    return rawRequest(path, {
      method: 'POST',
      body,
      headers: {
        'X-BugDrop-Uninstall-Signature': mac(key, `bugdrop:uninstall:${path.slice(1)}:v1\0${body}`),
      },
    });
  };
  return {
    calls,
    async prewarm() {
      const response = await rawRequest('/_test/prewarm');
      if (response.status !== 200) throw new Error('uninstall_test_prewarm_failed');
      await response.text();
    },
    async changeScope(change) {
      if (change.applicationId !== undefined) applicationId = change.applicationId;
      for (const field of ['appId', 'installationId'])
        if (change[field] !== undefined) config[field] = change[field];
      await rawRequest('/_test/scope', {
        method: 'POST',
        body: JSON.stringify({ config, applicationId }),
      });
    },
    recovery: recoveryFixture,
    transport: transportFixture,
    async advance(advance) {
      now += advance;
      await rawRequest('/_test/clock', { method: 'POST', body: String(now) });
    },
    failTransaction: () => rawRequest('/_test/fail-transaction', { method: 'POST' }),
    deleteAlarm: () => rawRequest('/_test/delete-alarm', { method: 'POST' }),
    alarmTime: async () => (await rawRequest('/_test/alarm-time')).json(),
    setFault(at, action) {
      fault = { at: syncCount + at, action };
    },
    modes,
    identity,
    request,
    rawRequest,
    webhook(body, headers = {}, tamper = false) {
      return rawRequest('/github/staging/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-GitHub-Event': 'installation',
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', webhookSecret)
            .update(tamper ? body + ' ' : body)
            .digest('hex')}`,
          ...headers,
        },
      });
    },
    status: async () => (await request('/status')).json(),
    storage: async () => (await rawRequest('/_test/storage')).json(),
    alarm: () => rawRequest('/_test/alarm', { method: 'POST' }),
    evidence: () => ({ edgeLatched, sqlReceipts: [...sqlReceipts.values()], logs }),
    async settled(response) {
      const intake = { status: response.status, body: await response.text() };
      const barrier = await rawRequest('/_test/settled', {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      if (barrier.status !== 200) throw new Error('uninstall_test_completion_barrier_failed');
      await barrier.text();
      return {
        intake,
        state: await (await request('/status')).json(),
        storage: await (await rawRequest('/_test/storage')).json(),
        alarm: await (await rawRequest('/_test/alarm-time')).json(),
        calls: { ...calls },
        recoveryCalls: recoveryFixture.calls,
        ledger: [...ledger],
        logs: [...logs],
        transportTrace: await (await rawRequest('/_test/trace')).json(),
      };
    },
    async edgeStorage() {
      if (!controlRoot) throw new Error('actual_edge_unavailable');
      return (
        await (
          await runtime.getWorker('authority')
        ).fetch('http://uninstall.bugdrop.localhost/_test/storage')
      ).json();
    },
    async projection(body) {
      if (!controlRoot) throw new Error('actual_edge_unavailable');
      const raw = JSON.stringify(body);
      return (await runtime.getWorker('authority')).fetch(
        'http://uninstall.bugdrop.localhost/projection',
        {
          method: 'POST',
          body: raw,
          headers: { 'X-BugDrop-Control-Signature': mac(controlKey, raw) },
        }
      );
    },
    async restart(advance = 0) {
      await runtime.dispose();
      now += advance;
      await boot();
    },
    async close() {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
