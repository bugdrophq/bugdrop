// Local-only black-box fixture. This is not the remote SDK conformance provider.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, webcrypto } from 'node:crypto';
export async function start({
  pepper,
  verifier,
  keyset,
  applicationId = 'app-test',
  installationId = '42',
  deliveryEnabled = true,
  github,
  enableControlFaults = false,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'bugdrop-staging-test-'));
  const controlKey = randomBytes(32).toString('base64url');
  const uninstallKey = randomBytes(32).toString('base64url');
  const uninstallCommitmentKey = randomBytes(32).toString('base64url');
  const reconciliationKey = randomBytes(32).toString('base64url');
  const receiptKey = randomBytes(32).toString('base64url');
  let runtime,
    attempts = 0;
  let deliveryDelay = 0;
  let controlFault = '';
  const logs = [],
    network = [];
  class CaptureLog extends Log {
    logWithLevel(_level, message) {
      logs.push(message);
    }
    logReady() {}
  }
  const authority = {
    ENVIRONMENT: 'staging',
    STAGING_ENABLED: 'true',
    STAGING_APPLICATION_ID: applicationId,
    STAGING_INSTALLATION_ID: installationId,
    STAGING_CONTROL_HMAC_KEY: controlKey,
    STAGING_UNINSTALL_HMAC_KEY: uninstallKey,
    STAGING_AUTH_PEPPER: pepper,
    STAGING_AUTH_VERIFIER: verifier,
    STAGING_RECEIPT_HMAC_KEY: receiptKey,
    STAGING_SIGNING_KEYSET: JSON.stringify(keyset),
  };
  try {
    for (const role of ['authority', 'ingress', 'delivery', 'github'])
      await build({
        entryPoints: [
          role === 'authority' && enableControlFaults
            ? 'managed/staging/control-fault-worker.mjs'
            : `src/managed/staging/${role}.ts`,
        ],
        outfile: join(directory, `${role}.mjs`),
        bundle: true,
        format: 'esm',
        platform: 'node',
        external: ['cloudflare:workers'],
        logLevel: 'silent',
      });
    const common = {
      modules: true,
      modulesRoot: directory,
      compatibilityDate: '2026-06-10',
      compatibilityFlags: ['nodejs_compat'],
      outboundService: () => {
        network.push('denied');
        return new Response(null, { status: 403 });
      },
    };
    async function boot() {
      runtime = new Miniflare({
        host: 'staging.bugdrop.localhost',
        log: new CaptureLog(LogLevel.INFO),
        durableObjectsPersist: join(directory, 'state'),
        workers: [
          {
            ...common,
            name: 'probe',
            script: `export default {fetch(request,env){const url=new URL(request.url);const name=url.pathname.split('/')[1];url.pathname=url.pathname.slice(name.length+1);return env[name].fetch(new Request(url,request));}}`,
            scriptPath: join(directory, 'probe.mjs'),
            serviceBindings: {
              public: 'ingress',
              control: { name: 'authority', entrypoint: 'StagingControl' },
              issuer: { name: 'authority', entrypoint: 'IssuerAuthority' },
              reader: { name: 'authority', entrypoint: 'DeliveryAuthority' },
              submit: { name: 'ingress', entrypoint: 'StagingSubmission' },
              github: 'github',
            },
          },
          {
            ...common,
            name: 'authority',
            scriptPath: join(directory, 'authority.mjs'),
            bindings: { ...authority, STAGING_TEST_ROLLBACK: String(controlFault === 'rollback') },
            ...(enableControlFaults
              ? {
                  serviceBindings: {
                    TEST_CONTROL_SYNC: async () => {
                      const action = controlFault;
                      controlFault = '';
                      return new Response(action);
                    },
                  },
                }
              : {}),
            durableObjects: {
              STAGING_AUTHORIZATIONS: { className: 'StagingAuthorization', useSQLite: true },
            },
          },
          {
            ...common,
            name: 'ingress',
            scriptPath: join(directory, 'ingress.mjs'),
            bindings: { ENVIRONMENT: 'staging', STAGING_ENABLED: 'true' },
            serviceBindings: {
              STAGING_AUTHORITY: { name: 'authority', entrypoint: 'IssuerAuthority' },
              STAGING_DELIVERY: { name: 'delivery', entrypoint: 'StagingDelivery' },
              STAGING_GITHUB_WEBHOOK: { name: 'github', entrypoint: 'GithubWebhook' },
            },
          },
          {
            ...common,
            name: 'github',
            scriptPath: join(directory, 'github.mjs'),
            bindings: {
              ENVIRONMENT: 'staging',
              STAGING_ENABLED: 'true',
              STAGING_DELIVERY_ENABLED: String(deliveryEnabled),
              STAGING_GITHUB_TARGET_JSON: JSON.stringify(github?.config ?? {}),
              STAGING_APPLICATION_ID: applicationId,
              STAGING_DESTINATION_ID: 'destination-test',
              STAGING_GITHUB_PRIVATE_KEY: github?.privateKey ?? '',
              STAGING_GITHUB_WEBHOOK_SECRET: github?.webhookSecret ?? '',
              STAGING_UNINSTALL_HMAC_KEY: uninstallKey,
              STAGING_UNINSTALL_COMMITMENT_KEY: uninstallCommitmentKey,
              STAGING_RECONCILIATION_HMAC_KEY: reconciliationKey,
            },
            serviceBindings: {
              STAGING_AUTHORITY: { name: 'authority', entrypoint: 'DeliveryAuthority' },
              STAGING_CONTROL: { name: 'authority', entrypoint: 'StagingControl' },
              STAGING_RECONCILIATION: () => new Response(null, { status: 503 }),
            },
            durableObjects: {
              STAGING_UNINSTALLS: { className: 'StagingUninstall', useSQLite: true },
            },
            ...(github ? { outboundService: github.transport } : {}),
          },
          {
            ...common,
            name: 'delivery',
            scriptPath: join(directory, 'delivery.mjs'),
            bindings: {
              ENVIRONMENT: 'staging',
              STAGING_ENABLED: 'true',
              STAGING_DELIVERY_ENABLED: String(deliveryEnabled),
            },
            serviceBindings: {
              STAGING_AUTHORITY: { name: 'authority', entrypoint: 'DeliveryAuthority' },
              STAGING_GITHUB: github
                ? async request => {
                    await github.beforeAdapter?.();
                    return (await runtime.getWorker('github')).fetch(request);
                  }
                : async () => {
                    attempts++;
                    if (deliveryDelay)
                      await new Promise(resolve => setTimeout(resolve, deliveryDelay));
                    return Response.json({ outcome: 'delivered' });
                  },
            },
            durableObjects: { STAGING_RECEIPTS: { className: 'StagingReceipt', useSQLite: true } },
          },
        ],
      });
      await runtime.ready;
    }
    await boot();
    const request = (path, init) =>
      runtime.dispatchFetch(`http://staging.bugdrop.localhost${path}`, init);
    return {
      async control(path, body, { tamper = false, useProjectionKey = false, rawBody } = {}) {
        const raw = rawBody ?? JSON.stringify(body);
        const key = await webcrypto.subtle.importKey(
          'raw',
          Buffer.from(
            path === '/revoke-installation' && !useProjectionKey ? uninstallKey : controlKey,
            'base64url'
          ),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signature = Buffer.from(
          await webcrypto.subtle.sign(
            'HMAC',
            key,
            Buffer.from(
              path === '/projection-status' ? 'bugdrop:staging:control-status:v1\n' + raw : raw
            )
          )
        ).toString('base64url');
        return request(`/control${path}`, {
          method: 'POST',
          body: tamper ? raw + ' ' : raw,
          headers: { 'X-BugDrop-Control-Signature': signature },
        });
      },
      async receipt(response, uninstall = false) {
        const raw = await response.text();
        const key = await webcrypto.subtle.importKey(
          'raw',
          Buffer.from(uninstall ? uninstallKey : controlKey, 'base64url'),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify']
        );
        const signature = response.headers.get(
          uninstall
            ? 'X-BugDrop-Uninstall-Receipt-Signature'
            : 'X-BugDrop-Control-Receipt-Signature'
        );
        const valid =
          signature !== null &&
          (await webcrypto.subtle.verify(
            'HMAC',
            key,
            Buffer.from(signature, 'base64url'),
            Buffer.from(
              (uninstall
                ? 'bugdrop:uninstall:edge-receipt:v1\0'
                : 'bugdrop:staging:control-receipt:v1\n') + raw
            )
          ));
        return { status: response.status, valid, raw, body: JSON.parse(raw) };
      },
      request,
      async publicRequest(path, init) {
        return request(`/public${path}`, init);
      },
      async setControlFault(mode) {
        if (!enableControlFaults) throw new Error('test_control_faults_disabled');
        controlFault = mode;
        await runtime.dispose();
        await boot();
      },
      setDeliveryDelay(ms) {
        deliveryDelay = ms;
      },
      async disableDelivery() {
        deliveryEnabled = false;
        await runtime.dispose();
        await boot();
      },
      async restart() {
        await runtime.dispose();
        await boot();
      },
      evidence() {
        return { attempts, logs, network };
      },
      async close() {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
