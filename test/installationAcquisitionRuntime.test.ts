import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

let runtime: Miniflare;
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { FeedbackCounter } from './src/lib/feedback-counter';
        export class TestCounter extends FeedbackCounter {
          constructor(state, env) { super(state, env); this.testState = state; }
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/test/alarm') { await this.alarm(); return new Response('ok'); }
            if (path === '/test/state') return Response.json([...await this.testState.storage.list()]);
            return super.fetch(request);
          }
        }
        export default { async fetch(request, env) {
          const id = env.COUNTER.idFromName('installation-acquisition-test');
          return env.COUNTER.get(id).fetch(request);
        }};
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  runtime = new Miniflare({
    host: 'acquisition.bugdrop.localhost',
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: '2026-06-10',
    durableObjects: { COUNTER: { className: 'TestCounter', useSQLite: true } },
    kvNamespaces: ['INSTALLATION_ANALYTICS'],
    log: new Log(LogLevel.NONE),
  });
});
afterAll(async () => {
  await runtime?.dispose();
});

it('atomically counts concurrent duplicate and distinct deliveries in the Workers runtime', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const coverageStartedAt = `${day}T00:00:00.000Z`;
  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      runtime.dispatchFetch('https://acquisition.bugdrop.localhost/acquisition/increment', {
        method: 'POST',
        body: JSON.stringify({ day, coverageStartedAt, receipt: String(index % 10).repeat(64) }),
      })
    )
  );
  expect(responses.map(response => response.status)).toEqual(Array(30).fill(204));
  expect(
    (await runtime.dispatchFetch('https://acquisition.bugdrop.localhost/test/alarm')).status
  ).toBe(200);
  const state = (await (
    await runtime.dispatchFetch('https://acquisition.bugdrop.localhost/test/state')
  ).json()) as Array<[string, unknown]>;
  expect(new Map(state).get('acquisitionTotal')).toBe(10);
  expect(state.filter(([key]) => key.startsWith('acquisitionReceipt:'))).toHaveLength(10);
  const kv = await runtime.getKVNamespace('INSTALLATION_ANALYTICS');
  expect(await kv.get(`acquisition:daily:${day}`, 'json')).toEqual({
    schemaVersion: 1,
    date: day,
    installations: 10,
    coverageStartedAt,
    updatedAt: expect.any(String),
  });
}, 30_000);
