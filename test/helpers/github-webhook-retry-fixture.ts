import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { createHmac } from 'node:crypto';

export const webhookSecret = 'synthetic-local-webhook-secret-32-bytes';
export const acquisitionSecret = 'synthetic-local-acquisition-secret-32-bytes';
export const origin = 'https://webhook-retry.bugdrop.localhost';
export const sourceRevision = '4fb8c1766533d76b039fae8b85ee008854f96a9e';
export function payload(action: 'created' | 'deleted', id: number, at: string): string {
  return JSON.stringify({
    action,
    installation: {
      id,
      app_id: 2508027,
      created_at: at,
      account: {
        login: 'retry-org',
        type: 'Organization',
        html_url: 'https://github.com/retry-org',
      },
    },
  });
}
export function acquisitionReceipt(id: number): string {
  return createHmac('sha256', acquisitionSecret)
    .update(`installation-created:v1:2508027:${id}`)
    .digest('hex');
}

// Only local transport/storage controls are injected. Every effect below calls deployed source.
const fixtureSource = `
import { Hono } from 'hono';
import { createGitHubWebhook } from './src/routes/github-webhook';
import { FeedbackCounter } from './src/lib/feedback-counter';
const OriginalDate = Date;
let clock = null, fault = null, block = null, operations = [];
let inactive = false, checks = 0, inactiveAfter = null;
globalThis.Date = class extends OriginalDate {
 constructor(...args) { super(...(args.length ? args : [clock ?? OriginalDate.now()])); }
 static now() { return clock ?? OriginalDate.now(); }
};
async function boundary(operation, stage) {
 operations.push(stage + ':' + operation);
 if (block === stage + ':' + operation) {
  block = null;
  const waited = await fetch('https://webhook-retry.bugdrop.localhost/__test/barrier');
  if (!waited.ok) throw new Error('Local barrier unavailable');
 }
 if (fault === stage + ':' + operation) {
  fault = null;
  throw new Error('Injected local boundary failure: ' + stage + ':' + operation);
 }
}
function wrappedEnv(env) {
 const kv = env.INSTALLATION_ANALYTICS;
 const store = {
  get: kv.get.bind(kv), list: kv.list.bind(kv), getWithMetadata: kv.getWithMetadata.bind(kv),
  async put(key, ...args) {
   await boundary('put:' + key, 'before');
   await kv.put(key, ...args);
   await boundary('put:' + key, 'after');
  },
  async delete(key) {
   await boundary('delete:' + key, 'before');
   await kv.delete(key);
   await boundary('delete:' + key, 'after');
  }
 };
 const namespace = env.FEEDBACK_COUNTER;
 return { ...env, INSTALLATION_ANALYTICS: store, FEEDBACK_COUNTER: {
  idFromName: namespace.idFromName.bind(namespace),
  get(id) {
   const stub = namespace.get(id);
   return { async fetch(resource, init) {
    const request = new Request(resource, init);
    const operation = 'counter:' + new URL(request.url).pathname;
    await boundary(operation, 'before');
    const response = await stub.fetch(request);
    await boundary(operation, 'after');
    return response;
   }};
  }
 }};
}
export class TestCounter extends FeedbackCounter {
 constructor(state, env) { super(state, env); this.testState = state; }
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__test/state') return Response.json([...await this.testState.storage.list()]);
  if (path === '/__test/seed') {
   const entries = await request.json();
   for (const [key, value] of entries) await this.testState.storage.put(key, value);
   return new Response(null, {status:204});
  }
  if (path === '/__test/alarm') { await this.alarm(); return new Response(null, {status:204}); }
  return super.fetch(request);
 }
}
const app = new Hono().route('/api', createGitHubWebhook({
 async confirmInstallationIsInactive() {
  checks++;
  return inactive || (inactiveAfter !== null && checks >= inactiveAfter);
 }
}));
export default { async fetch(request, env) {
 const url = new URL(request.url);
 if (url.pathname === '/__test/config') {
  const input = await request.json();
  clock = input.now ?? null; fault = input.fault ?? null; block = input.block ?? null;
  inactive = input.inactive ?? false; inactiveAfter = input.inactiveAfter ?? null;
  checks = 0; operations = [];
  env.INSTALLATION_USAGE_ENABLED = input.usage === false ? 'false' : 'true';
  globalThis.testUsage = env.INSTALLATION_USAGE_ENABLED;
  return new Response(null, {status:204});
 }
 if (url.pathname === '/__test/operations') return Response.json({operations, checks});
 if (url.pathname.startsWith('/__test/counter/')) {
  const name = url.searchParams.get('name');
  const stub = env.FEEDBACK_COUNTER.get(env.FEEDBACK_COUNTER.idFromName(name));
  url.pathname = '/__test/' + url.pathname.split('/').at(-1);
  return stub.fetch(new Request(url, request));
 }
 return app.fetch(request, wrappedEnv({ ...env,
  INSTALLATION_USAGE_ENABLED: globalThis.testUsage ?? 'true'
 }));
}};
`;

export async function retryFixture() {
  let releaseBarrier: (() => void) | undefined;
  const built = await build({
    stdin: { contents: fixtureSource, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  const runtime = new Miniflare({
    host: 'webhook-retry.bugdrop.localhost',
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2026-06-10',
    durableObjects: { FEEDBACK_COUNTER: { className: 'TestCounter', useSQLite: true } },
    kvNamespaces: ['INSTALLATION_ANALYTICS'],
    bindings: {
      GITHUB_APP_ID: '2508027',
      GITHUB_WEBHOOK_SECRET: webhookSecret,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ACQUISITION_STARTED_AT: '2026-01-01T00:00:00.000Z',
      INSTALLATION_ACQUISITION_HMAC_SECRET: acquisitionSecret,
    },
    outboundService: request => {
      if (request.method === 'GET' && request.url === origin + '/__test/barrier') {
        if (releaseBarrier) throw new Error('Unexpected overlapping fixture barrier');
        return new Promise<Response>(resolve => {
          releaseBarrier = () => {
            releaseBarrier = undefined;
            resolve(new Response(null, { status: 204 }));
          };
        });
      }
      throw new Error('No external request is permitted in receiver retry proof');
    },
    log: new Log(LogLevel.NONE),
  });
  const kv = await runtime.getKVNamespace('INSTALLATION_ANALYTICS');
  async function config(input: Record<string, unknown> = {}) {
    return runtime.dispatchFetch(origin + '/__test/config', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  async function send(body: string, delivery = 'retry-delivery', signature?: string) {
    return runtime.dispatchFetch(origin + '/api/github/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'installation',
        'x-github-delivery': delivery,
        'x-hub-signature-256':
          signature ?? 'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex'),
      },
    });
  }
  async function counter(name: string, action: string, entries?: Array<[string, unknown]>) {
    return runtime.dispatchFetch(
      origin + '/__test/counter/' + action + '?name=' + encodeURIComponent(name),
      entries ? { method: 'POST', body: JSON.stringify(entries) } : {}
    );
  }
  async function state(name: string) {
    const result = await counter(name, 'state');
    if (!result.ok) throw new Error('Counter state unavailable');
    return new Map((await result.json()) as Array<[string, unknown]>);
  }
  async function operations() {
    return (await (await runtime.dispatchFetch(origin + '/__test/operations')).json()) as {
      operations: string[];
      checks: number;
    };
  }
  async function waitBlocked() {
    const deadline = Date.now() + 5_000;
    while (!releaseBarrier) {
      if (Date.now() > deadline) throw new Error('Expected deterministic barrier was not reached');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  function release() {
    if (!releaseBarrier) throw new Error('Expected active local transport barrier');
    releaseBarrier();
  }
  return { runtime, kv, config, send, counter, state, operations, waitBlocked, release };
}
