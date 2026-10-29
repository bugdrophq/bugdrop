import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { payload, retryFixture, sourceRevision } from './helpers/github-webhook-retry-fixture';

let f: Awaited<ReturnType<typeof retryFixture>>;
const at = '2026-10-27T10:00:00.000Z';
const now = Date.parse('2026-10-27T12:00:00.000Z');
const day = 'installation-acquisition:2026-10-27';
let installation = 1000;
beforeAll(async () => {
  f = await retryFixture();
});
afterAll(async () => {
  await f?.runtime.dispose();
});

it('exercises exact deployed effect source and independently verifies the production mount', () => {
  for (const path of [
    'src/index.ts',
    'src/routes/github-webhook.ts',
    'src/lib/installation-analytics.ts',
    'src/lib/installation-retention.ts',
    'src/lib/installation-acquisition.ts',
    'src/lib/installation-acquisition-counter.ts',
    'src/lib/installation-feedback-counter.ts',
    'src/lib/installation-usage.ts',
  ]) {
    expect(readFileSync(path, 'utf8')).toBe(
      execFileSync('git', ['show', `${sourceRevision}:${path}`], { encoding: 'utf8' })
    );
  }
  const index = readFileSync('src/index.ts', 'utf8');
  expect(index).toContain("import githubWebhook from './routes/github-webhook'");
  expect(index).toContain("app.route('/api', githubWebhook)");
});

it('authenticates original bytes before any real effect', async () => {
  await f.config({ now });
  const before = await f.state(day);
  const body = payload('created', ++installation, at);
  expect((await f.send(body, 'invalid', 'sha256=' + '0'.repeat(64))).status).toBe(401);
  expect(await f.kv.get(`installation:${installation}`)).toBeNull();
  expect(await f.state(day)).toEqual(before);
  expect((await f.operations()).checks).toBe(0);
});

it('safely retries a lost created acknowledgement with the same or a different delivery header', async () => {
  await f.config({ now });
  const id = ++installation,
    body = payload('created', id, at);
  const before = Number((await f.state(day)).get('acquisitionTotal') ?? 0);
  const first = await f.send(body);
  expect(first.status).toBe(201);
  await first.arrayBuffer(); // Receiver applied effects; gateway never records this acknowledgement.
  const identity = await f.kv.get(`installation:${id}`);
  const acquired = await f.state(day);
  for (const delivery of ['retry-delivery', 'different-delivery']) {
    expect((await f.send(body, delivery)).status).toBe(201);
    expect(await f.kv.get(`installation:${id}`)).toBe(identity);
    expect(await f.state(day)).toEqual(acquired);
  }
  expect(acquired.get('acquisitionTotal')).toBe(before + 1);
  expect(JSON.parse(identity!)).toMatchObject({ installedAt: at, account: { login: 'retry-org' } });
  expect(await f.kv.get(`installation-usage:${id}`)).toBeNull();
  expect(await f.state(`installation-feedback:${id}`)).toEqual(new Map());
  expect(await f.state('global-feedback-issues-created')).toEqual(new Map());
});

for (const usage of [true, false]) {
  const boundaries = [
    ...(usage ? ['put:installation-usage-deleted:ID'] : []),
    'counter:/installation/' + (usage ? 'delete' : 'purge'),
    'delete:installation-usage:ID',
    'delete:installation:ID',
  ];
  for (const operation of boundaries)
    for (const stage of ['before', 'after']) {
      it(`retries ${usage ? 'guarded deletion' : 'disabled-usage purge'} after ${stage}:${operation}`, async () => {
        const id = ++installation,
          other = ++installation;
        await f.config({ now, usage });
        expect((await f.send(payload('created', id, at))).status).toBe(201);
        expect((await f.send(payload('created', other, at))).status).toBe(201);
        await f.kv.put(`installation-usage:${id}`, 'target usage');
        await f.kv.put(`installation-usage:${other}`, 'unrelated usage');
        await f.counter(`installation-feedback:${id}`, 'seed', [
          ['total', 7],
          ['installationId', id],
        ]);
        await f.counter(`installation-feedback:${other}`, 'seed', [
          ['total', 11],
          ['installationId', other],
        ]);
        await f.counter('global-feedback-issues-created', 'seed', [['total', 500]]);
        const aggregate = await f.state(day);
        const unrelated = await f.kv.get(`installation:${other}`);
        const otherCounter = await f.state(`installation-feedback:${other}`);
        const body = payload('deleted', id, at);
        await f.config({ now, usage, fault: `${stage}:${operation.replace('ID', String(id))}` });
        expect((await f.send(body)).status).toBe(500);
        expect((await f.operations()).operations).toContain(
          `${stage}:${operation.replace('ID', String(id))}`
        );
        expect((await f.send(body)).status).toBe(200);
        expect((await f.send(body, 'lost-delete-response')).status).toBe(200);
        expect(await f.kv.get(`installation:${id}`)).toBeNull();
        expect(await f.kv.get(`installation-usage:${id}`)).toBeNull();
        const cleaned = await f.state(`installation-feedback:${id}`);
        expect(cleaned.has('total')).toBe(false);
        expect(cleaned.has('installationId')).toBe(false);
        expect(cleaned.has('deletedUntil')).toBe(usage);
        expect(await f.kv.get(`installation-usage-deleted:${id}`)).toBe(usage ? '1' : null);
        expect(await f.kv.get(`installation:${other}`)).toBe(unrelated);
        expect(await f.kv.get(`installation-usage:${other}`)).toBe('unrelated usage');
        expect(await f.state(`installation-feedback:${other}`)).toEqual(otherCounter);
        expect(await f.state(day)).toEqual(aggregate);
        expect(await f.state('global-feedback-issues-created')).toEqual(new Map([['total', 500]]));
      });
    }
}

it('never acknowledges deletion while its counter cleanup is blocked', async () => {
  const id = ++installation;
  await f.config({ now });
  expect((await f.send(payload('created', id, at))).status).toBe(201);
  await f.config({ now, block: 'before:counter:/installation/delete' });
  let completed = false;
  const pending = f.send(payload('deleted', id, at)).then(r => {
    completed = true;
    return r;
  });
  await f.waitBlocked();
  expect(completed).toBe(false);
  expect(await f.kv.get(`installation:${id}`)).not.toBeNull();
  f.release();
  expect((await pending).status).toBe(200);
  expect(await f.kv.get(`installation:${id}`)).toBeNull();
});

it('concurrent duplicate deletions preserve cleanup and unrelated replacement state', async () => {
  const id = ++installation,
    replacement = ++installation;
  await f.config({ now });
  await f.send(payload('created', id, at));
  await f.send(payload('created', replacement, at));
  const replacementRecord = await f.kv.get(`installation:${replacement}`);
  const aggregate = await f.state(day);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.send(payload('deleted', id, at)))
  );
  expect(results.map(r => r.status)).toEqual(Array(8).fill(200));
  expect(await f.kv.get(`installation:${id}`)).toBeNull();
  expect(await f.kv.get(`installation:${replacement}`)).toBe(replacementRecord);
  expect(await f.state(day)).toEqual(aggregate);
});
