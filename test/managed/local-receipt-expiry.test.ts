import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps the live receipt schema usable after an expiry alarm', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { LocalManagedReceipt } from './src/managed/local/receipt';
        export class ExpiryProbe extends LocalManagedReceipt {
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/seed') {
              this.ctx.storage.sql.exec("INSERT INTO receipt VALUES (1, 'opaque', 'delivered', 1)");
              return new Response(null, {status: 204});
            }
            if (path === '/extend') {
              this.ctx.storage.sql.exec('UPDATE receipt SET expiresAt = ?', Date.now() + 86400000);
              return new Response(null, {status: 204});
            }
            if (path === '/alarm') {
              await this.alarm();
              return new Response(null, {status: 204});
            }
            return super.fetch(request);
          }
        }
        export default {fetch(request, env) {
          return env.RECEIPTS.get(env.RECEIPTS.idFromName('expiry-probe')).fetch(request);
        }};
      `,
      resolveDir: resolve('.'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    external: ['cloudflare:workers'],
  });
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    scriptPath: resolve('test/managed/expiry-probe.mjs'),
    compatibilityDate: '2026-06-10',
    compatibilityFlags: ['nodejs_compat'],
    log: new Log(LogLevel.NONE),
    durableObjects: { RECEIPTS: { className: 'ExpiryProbe', useSQLite: true } },
  });
  try {
    const request = (path: string) =>
      runtime.dispatchFetch(`http://receipt.bugdrop.localhost${path}`);
    expect((await request('/seed')).status).toBe(204);
    expect((await (await request('/_local/state')).json()).state).toBe('delivered');
    expect((await request('/alarm')).status).toBe(204);
    const expired = await request('/_local/state');
    expect(expired.status).toBe(200);
    expect(await expired.json()).toBeNull();
    // A live instance must still have its schema, including on repeated alarms.
    expect((await request('/alarm')).status).toBe(204);
    expect((await request('/seed')).status).toBe(204);
    expect((await request('/extend')).status).toBe(204);
    expect((await request('/alarm')).status).toBe(204);
    expect((await (await request('/_local/state')).json()).state).toBe('delivered');
  } finally {
    await runtime.dispose();
  }
}, 30000);
