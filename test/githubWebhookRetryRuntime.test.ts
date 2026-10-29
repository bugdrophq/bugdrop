import { afterAll, beforeAll, expect, it } from 'vitest';
import { acquisitionReceipt, payload, retryFixture } from './helpers/github-webhook-retry-fixture';

let f: Awaited<ReturnType<typeof retryFixture>>;
const at = '2026-10-27T10:00:00.000Z',
  now = Date.parse('2026-10-27T12:00:00.000Z');
beforeAll(async () => {
  f = await retryFixture();
});
afterAll(async () => {
  await f?.runtime.dispose();
});

it('counts concurrent identical signed created payloads once using the native acquisition transaction', async () => {
  await f.config({ now });
  const body = payload('created', 3001, at);
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) => f.send(body, 'concurrent-' + i))
  );
  expect(results.map(r => r.status)).toEqual(Array(24).fill(201));
  const state = await f.state('installation-acquisition:2026-10-27');
  expect(state.get('acquisitionTotal')).toBe(1);
  expect([...state.keys()].filter(k => k.startsWith('acquisitionReceipt:'))).toEqual([
    'acquisitionReceipt:' + acquisitionReceipt(3001),
  ]);
  expect(JSON.parse((await f.kv.get('installation:3001'))!)).toEqual({
    schemaVersion: 1,
    installationId: 3001,
    installedAt: at,
    account: {
      login: 'retry-org',
      type: 'Organization',
      profileUrl: 'https://github.com/retry-org',
    },
  });
  expect((await f.send(payload('created', 3002, at))).status).toBe(201);
  const distinct = await f.state('installation-acquisition:2026-10-27');
  expect(distinct.get('acquisitionTotal')).toBe(2);
  expect(distinct.get('acquisitionReceipt:' + acquisitionReceipt(3002))).toBe(true);
});

it('keeps original creation day across midnight and closes acceptance after receipt expiry', async () => {
  const original = '2026-10-26T23:59:00.000Z',
    day = 'installation-acquisition:2026-10-26';
  const body = payload('created', 3101, original);
  await f.config({ now: Date.parse('2026-10-26T23:59:30.000Z') });
  expect((await f.send(body)).status).toBe(201);
  const record = await f.kv.get('installation:3101');
  const acquired = await f.state(day);
  const nextDay = await f.state('installation-acquisition:2026-10-27');
  expect(acquired.get('acquisitionTotal')).toBe(1);
  await f.config({ now: Date.parse('2026-10-27T00:01:00.000Z') });
  expect((await f.send(body, 'after-midnight')).status).toBe(201);
  expect(await f.state(day)).toEqual(acquired);
  expect(await f.state('installation-acquisition:2026-10-27')).toEqual(nextDay);
  expect(await f.kv.get('installation:3101')).toBe(record);
  await f.config({ now: Date.parse('2026-11-27T00:01:00.000Z') });
  expect((await f.counter(day, 'alarm')).status).toBe(204);
  const expired = await f.state(day);
  expect([...expired.keys()].some(k => k.startsWith('acquisitionReceipt:'))).toBe(false);
  expect(expired.get('acquisitionTotal')).toBe(1);
  expect((await f.send(body, 'after-receipt-expiry')).status).toBe(201);
  expect(await f.state(day)).toEqual(expired);
  expect(await f.state('installation-acquisition:2026-11-27')).toEqual(new Map());
  expect(await f.kv.get('installation:3101')).toBe(record);
});

// Assumption: the controlled provider eventually reports a removed installation inactive.
// No immediate-consistency guarantee is inferred for GitHub or distributed KV.
it('cleans a created write when removal becomes observable between its two provider checks', async () => {
  await f.config({ now, inactiveAfter: 2 });
  expect((await f.send(payload('created', 3201, at))).status).toBe(202);
  expect((await f.operations()).checks).toBe(2);
  expect(await f.kv.get('installation:3201')).toBeNull();
  expect(await f.kv.get('installation-usage:3201')).toBeNull();
  expect((await f.state('installation-feedback:3201')).has('total')).toBe(false);
});

it('does not resurrect an installation when a created write races with authenticated deletion', async () => {
  await f.config({ now });
  expect((await f.send(payload('created', 3302, at))).status).toBe(201);
  const replacement = await f.kv.get('installation:3302');
  await f.config({ now, block: 'before:put:installation:3301' });
  const created = f.send(payload('created', 3301, at));
  await f.waitBlocked();
  await f.config({ now, inactive: true });
  expect((await f.send(payload('deleted', 3301, at))).status).toBe(200);
  f.release();
  expect((await created).status).toBe(202);
  expect(await f.kv.get('installation:3301')).toBeNull();
  expect(await f.kv.get('installation-usage:3301')).toBeNull();
  const acquired = await f.state('installation-acquisition:2026-10-27');
  expect((await f.send(payload('created', 3301, at), 'old-created-redelivery')).status).toBe(202);
  expect(await f.state('installation-acquisition:2026-10-27')).toEqual(acquired);
  expect(await f.kv.get('installation:3301')).toBeNull();
  expect(await f.kv.get('installation:3302')).toBe(replacement);
});

it('repeated deletion may refresh guards but cannot restore allowance or acquisition', async () => {
  const id = 3401;
  await f.config({ now });
  expect((await f.send(payload('created', id, at))).status).toBe(201);
  await f.counter('installation-feedback:' + id, 'seed', [
    ['total', 9],
    ['installationId', id],
  ]);
  await f.kv.put('installation-usage:' + id, 'prior feedback usage');
  expect((await f.send(payload('deleted', id, at))).status).toBe(200);
  const prior = await f.state('installation-feedback:' + id);
  const acquired = await f.state('installation-acquisition:2026-10-27');
  await f.config({ now: now + 60_000, inactive: true });
  expect((await f.send(payload('deleted', id, at), 'repeat')).status).toBe(200);
  const repeat = await f.state('installation-feedback:' + id);
  expect(Number(repeat.get('deletedUntil'))).toBeGreaterThan(Number(prior.get('deletedUntil')));
  expect([...repeat.keys()]).toEqual(['deletedUntil']);
  expect(await f.kv.get('installation:' + id)).toBeNull();
  expect(await f.kv.get('installation-usage:' + id)).toBeNull();
  expect(await f.state('installation-acquisition:2026-10-27')).toEqual(acquired);
});
