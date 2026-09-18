import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile } from 'node:fs/promises';
let runtime: Miniflare;
const calls: string[] = [];
const logs: string[] = [];
const endpoint = 'https://issuance.example.test/v1/submission-capabilities';
const headers = {
  'Content-Type': 'application/json',
  Host: 'issuance.example.test',
  Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
  'X-BugDrop-Contract-Version': '1',
  'X-BugDrop-SDK-Version': '0.1.0',
};
beforeAll(async () => {
  const bundle = async (file: string) =>
    (
      await build({
        entryPoints: [file],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        external: ['cloudflare:workers'],
        logLevel: 'silent',
      })
    ).outputFiles[0].text;
  // Miniflare's transport rewrites Host to its local socket; the fixture restores the URL host.
  // Direct unit tests separately verify rejection of conflicting caller-visible Host headers.
  const [gateway, ingress] = await Promise.all([
    build({
      stdin: {
        contents:
          "import gateway from './src/managed/staging/https-gateway.ts'; export default {fetch(request,env){const headers=new Headers(request.headers); headers.set('Host',new URL(request.url).host); return gateway.fetch(new Request(request,{headers}),env)}}",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    }).then(result => result.outputFiles[0].text),
    bundle('src/managed/staging/ingress.ts'),
  ]);
  class Capture extends Log {
    logWithLevel(_level: LogLevel, message: string) {
      logs.push(message);
    }
    logReady() {}
  }
  runtime = new Miniflare({
    host: 'gateway.bugdrop.localhost',
    log: new Capture(LogLevel.NONE),
    workers: [
      {
        name: 'gateway',
        modules: true,
        script: gateway,
        compatibilityDate: '2026-06-10',
        bindings: {
          ENVIRONMENT: 'staging',
          GATEWAY_ENABLED: 'true',
          GATEWAY_ORIGIN: 'https://issuance.example.test',
        },
        serviceBindings: {
          STAGING_CAPABILITY_INGRESS: async request => {
            calls.push(request.url);
            return (await runtime.getWorker('closed-ingress')).fetch(request);
          },
        },
        outboundService: () => {
          throw new Error('network_forbidden');
        },
      },
      {
        name: 'closed-ingress',
        modules: true,
        script: ingress,
        compatibilityDate: '2026-06-10',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          ENVIRONMENT: 'staging',
          STAGING_ENABLED: 'false',
          STAGING_OBSERVATION_ENABLED: 'false',
        },
        outboundService: () => {
          throw new Error('network_forbidden');
        },
      },
    ],
  });
  await runtime.ready;
}, 30000);
afterAll(async () => {
  await runtime?.dispose();
});
it('preserves actual closed ingress rejection through the runtime binding', async () => {
  calls.length = 0;
  const response = await (
    await runtime.getWorker('gateway')
  ).fetch(endpoint, {
    method: 'POST',
    headers,
    body: '{}',
    redirect: 'error',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'managed_request_rejected' });
  expect(calls).toEqual([endpoint]);
});
it('never invokes the binding for webhook or encoded unknown paths in workerd', async () => {
  for (const path of [
    '/github/staging/webhook',
    '/github%2fstaging%2fwebhook',
    '/%2567ithub/staging/webhook',
    '//github/staging/webhook',
    '/v1/submission-capabilities?canary=PRIVATE_QUERY',
    '/v1/submission-capabilities/',
    '/v1/%73ubmission-capabilities',
  ]) {
    calls.length = 0;
    const response = await (
      await runtime.getWorker('gateway')
    ).fetch('https://issuance.example.test' + path, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  }
  expect(logs.join('')).not.toContain('PRIVATE_QUERY');
});
it('records normalized dot segments honestly: only the fixed issuance destination is possible', async () => {
  for (const path of [
    '/other/../v1/submission-capabilities',
    '/%2e/v1/submission-capabilities',
    '/v1/./submission-capabilities',
  ]) {
    calls.length = 0;
    const response = await (
      await runtime.getWorker('gateway')
    ).fetch('https://issuance.example.test' + path, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([endpoint]);
  }
});
it('keeps checked-in gateway deployment configuration disabled and unexposed', async () => {
  const config = JSON.parse(await readFile('managed/staging/https-gateway.json', 'utf8'));
  expect(config).toMatchObject({
    account_id: 'STAGING_ACCOUNT_NOT_APPROVED',
    workers_dev: false,
    preview_urls: false,
    routes: [],
    vars: { ENVIRONMENT: 'staging', GATEWAY_ENABLED: 'false', GATEWAY_ORIGIN: 'UNAPPROVED' },
    observability: { enabled: false },
    logpush: false,
    tail_consumers: [],
  });
  expect(config.services).toEqual([
    { binding: 'STAGING_CAPABILITY_INGRESS', service: 'bugdrop-managed-ingress-staging' },
  ]);
  for (const field of ['secrets', 'durable_objects', 'hyperdrive', 'queues', 'assets', 'env'])
    expect(config).not.toHaveProperty(field);
});
