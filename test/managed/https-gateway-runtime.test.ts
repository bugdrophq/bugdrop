import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile } from 'node:fs/promises';
let runtime: Miniflare;
const calls: string[] = [];
const logs: string[] = [];
const v2Captured: { url: string; headers: Record<string, string>; body: string }[] = [];
// Synthetic e263209 contract vectors; binding is a transport fixture, not P5 issuance.
const v2Body =
  '{"schemaVersion":2,"intent":{"attemptId":"11111111-1111-4111-8111-111111111111","issuedAt":1800000000000,"expiresAt":1800000060000,"submissionId":"fixture-submission","payloadDigest":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","applicationId":"app_fixture","credentialId":"22222222-2222-4222-8222-222222222222","keyId":"ICEiIyQlJicoKSorLC0uLw","installationGeneration":"33333333-3333-4333-8333-333333333333","endpoint":"https://issuance.example.test/v2/submission-capabilities","deploymentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","catalogDigest":"d3ac8a92c537d29b53f4d4fe6a8a73a5358997cda02ab25b76f61fa4304e6995","origin":"https://customer.example.test","serverSdkVersion":"0.1.0","browserSdkVersion":"0.2.0","normalizedVersions":{"sdkVersion":"0.1.0","browserSdkVersion":"0.2.0","widgetVersion":null,"protocolVersion":2}}}';
const v2Response =
  '{"schemaVersion":2,"capability":{"schemaVersion":1,"token":"eyJhbGciOiJFUzI1NiIsImtpZCI6ImNhcC12Mi1maXh0dXJlIiwidHlwIjoiYnVnZHJvcC1tYW5hZ2VkLWNhcGFiaWxpdHktdjIifQ.eyJwcm90b2NvbFZlcnNpb24iOjIsImlzcyI6ImJ1Z2Ryb3AtbWFuYWdlZC1zdGFnaW5nLXYyIiwiYXVkIjoiYnVnZHJvcC1tYW5hZ2VkLXN0YWdpbmctaW5ncmVzcy12MiIsInB1YmxpY0FwcGxpY2F0aW9uSWQiOiJhcHBfZml4dHVyZSIsImp0aSI6Ijg4ODg4ODg4LTg4ODgtNDg4OC04ODg4LTg4ODg4ODg4ODg4OCIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMzAwfQ.1EdercTG-1vM0nRoVneDcfoFbu0xId_oKZjMfYInCZna6GwuRlEW_a72O4baekU-yneOUPoA7w67lAvCiftTaw","expiresAt":"2027-01-15T08:05:00.000Z"},"confirmation":{"schemaVersion":2,"kid":"fixture-confirmation","intentDigest":"c3e655f1b1171a2ed53c49bf7417eb9bed4ed9bebfa8848273e4c3d29515a3c3","capabilityDigest":"a35e2871234d980498d80ff91d454ec513b603a48448e55eda189aa16f3301c7","reservedAt":1800000000000,"retentionDeadline":1802592000000,"admittedAt":1800000001000,"expiresAt":1800000060000,"signature":"Y8iloxQP-ixoCp6V4yLxjpuMDh9TfcolJLLkl-hUYGUjlbkkt7FhpXt7R2IX3c2r8gZ4ACLbRpzDV7hl4Rk7pA"}}';
const v2Headers = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.bugdrop.submission-capability.v2+json',
  'X-BugDrop-Contract-Version': '2',
  'X-BugDrop-SDK-Version': '0.1.0',
  Authorization:
    'Bearer bd_auth_v2.ICEiIyQlJicoKSorLC0uLw.zZHyKjQ-My1Nmh-tdSR33HBJdkvYVaojdWtsWJEpJOA',
  'X-BugDrop-Intent-Signature': 'XTeYYCdWY7TrPy9kwUNzVdRP_qXpGSsCLT5Rn4rUW_Y',
};
const v2Endpoint = 'https://issuance.example.test/v2/submission-capabilities';
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
            if (request.url === v2Endpoint) {
              v2Captured.push({
                url: request.url,
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
              });
              return new Response(v2Response, {
                headers: {
                  'Content-Type': v2Headers.Accept,
                  'Cache-Control': 'no-store',
                  'X-Private': 'PRIVATE_RESPONSE_CANARY',
                },
              });
            }
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

it('forwards frozen V2 bytes and allowlisted headers through the actual workerd binding', async () => {
  calls.length = 0;
  v2Captured.length = 0;
  const response = await (
    await runtime.getWorker('gateway')
  ).fetch(v2Endpoint, {
    method: 'POST',
    headers: {
      ...v2Headers,
      Cookie: 'PRIVATE_COOKIE_CANARY',
      'X-BugDrop-Control-Signature': 'PRIVATE_CONTROL_CANARY',
    },
    body: v2Body,
    redirect: 'error',
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(v2Response);
  expect(calls).toEqual([v2Endpoint]);
  expect(v2Captured).toEqual([
    {
      url: v2Endpoint,
      // workerd's binding transport generates Host/Content-Length after gateway filtering.
      headers: {
        ...Object.fromEntries(new Headers(v2Headers)),
        host: 'issuance.example.test',
        'content-length': String(new TextEncoder().encode(v2Body).length),
      },
      body: v2Body,
    },
  ]);
  expect([...response.headers.keys()].sort()).toEqual([
    'cache-control',
    'content-length',
    'content-type',
  ]);
  expect(response.headers.get('Content-Length')).toBe(
    String(new TextEncoder().encode(v2Response).length)
  );
  expect(logs.join('')).not.toMatch(/PRIVATE_(COOKIE|CONTROL|RESPONSE)_CANARY/);
});
it('rejects stripped, mixed, oversized and duplicate-visible V2 requests before workerd binding', async () => {
  for (const patch of [
    { headers: { ...v2Headers, 'X-BugDrop-Intent-Signature': '' } },
    {
      headers: {
        ...v2Headers,
        'X-BugDrop-Intent-Signature':
          v2Headers['X-BugDrop-Intent-Signature'] + ', ' + v2Headers['X-BugDrop-Intent-Signature'],
      },
    },
    { headers: { ...v2Headers, 'X-BugDrop-Contract-Version': '1' } },
    { body: v2Body + ' '.repeat(32769) },
    { body: v2Body.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2') },
  ]) {
    calls.length = 0;
    const response = await (
      await runtime.getWorker('gateway')
    ).fetch(v2Endpoint, { method: 'POST', headers: v2Headers, body: v2Body, ...patch });
    expect([404, 502]).toContain(response.status);
    expect(calls).toEqual([]);
  }
  // These are Worker-visible/coalesced duplicates; hidden raw multiplicity is unqualified.
});
it('qualifies only locally observed generated HTTP response headers', async () => {
  const response = await runtime.dispatchFetch(v2Endpoint, {
    method: 'POST',
    headers: v2Headers,
    body: v2Body,
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(v2Response);
  expect(response.headers.get('Content-Type')).toBe(v2Headers.Accept);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.has('X-Private')).toBe(false);
  // Local workerd transport evidence is not a deployed edge/CDN header guarantee.
  expect([...response.headers.keys()].sort()).toEqual([
    'cache-control',
    'content-length',
    'content-type',
  ]);
  expect(response.headers.get('Content-Length')).toBe(
    String(new TextEncoder().encode(v2Response).length)
  );
});
