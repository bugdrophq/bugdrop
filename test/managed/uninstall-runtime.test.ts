import { afterEach, describe, expect, it } from 'vitest';
import { start } from '../../managed/uninstall/test-adapter.mjs';
import { config, installation } from './github-staging-fixtures';
let service: Awaited<ReturnType<typeof start>>;
afterEach(async () => {
  await service?.close();
});
describe('actual SQLite uninstall coordinator with synthetic side transports', () => {
  it('verifies the original webhook then ignores private payload and changed delivery metadata', async () => {
    service = await start({ config });
    const canary = 'private-webhook-canary';
    const raw = JSON.stringify({
      action: 'deleted',
      installation,
      sender: { email: canary },
      token: canary,
    });
    expect((await service.webhook(raw, {}, true)).status).toBe(403);
    expect(await service.storage()).toEqual({ work: [], fence: [] });
    expect(
      (await service.webhook(raw, { 'X-GitHub-Delivery': 'first', Authorization: canary })).status
    ).toBe(200);
    const first = await service.status();
    await service.restart(2000);
    expect(
      (
        await service.webhook(
          JSON.stringify({
            installation,
            action: 'deleted',
            sender: { email: `${canary}-changed` },
          }),
          { 'X-GitHub-Delivery': 'different' }
        )
      ).status
    ).toBe(200);
    expect(await service.status()).toEqual(first);
    expect(JSON.stringify(await service.storage())).not.toContain(canary);
    expect(JSON.stringify(service.evidence())).not.toContain(canary);
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
  });
  it.each([1, 2, 3])(
    'recovers a real DO abort after durable sync %s without new intake',
    async point => {
      service = await start({ config });
      service.setFault(point, 'crash');
      try {
        expect((await service.request('/intake')).status).not.toBe(200);
      } catch (error) {
        expect(String(error)).toContain('injected_uninstall_post_sync_crash');
      }
      await service.restart(2000);
      await service.alarm();
      expect((await service.status()).state).toBe('complete');
      expect(service.calls).toEqual({ edge: 1, sql: 1 });
    }
  );
  it('never acknowledges intake when durable sync fails', async () => {
    service = await start({ config });
    service.setFault(1, 'sync-failure');
    expect((await service.request('/intake')).status).toBe(503);
    expect(service.calls).toEqual({ edge: 0, sql: 0 });
    await service.restart();
    await service.request('/intake');
    expect((await service.status()).state).toBe('complete');
  });
  it('durably admits one tuple and completes only both independent acknowledgements', async () => {
    service = await start({ config });
    expect((await service.request('/intake')).status).toBe(200);
    const first = await service.status();
    expect(first.state).toBe('complete');
    expect(first.work).toMatchObject({
      edgeAcknowledged: true,
      sqlAcknowledged: true,
      attempts: 1,
    });
    await service.restart();
    await Promise.all(Array.from({ length: 8 }, () => service.request('/intake')));
    expect(await service.status()).toEqual(first);
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
  });
  it.each(['edge', 'sql'] as const)(
    'retains %s-down work through restart and resolves lost acknowledgement',
    async side => {
      service = await start({ config });
      service.modes[side] = 'lost';
      await service.request('/intake');
      const before = await service.status();
      expect(before.state).toBe('pending');
      expect(before.work[side === 'edge' ? 'edgeAcknowledged' : 'sqlAcknowledged']).toBe(false);
      expect(before.work[side === 'edge' ? 'sqlAcknowledged' : 'edgeAcknowledged']).toBe(true);
      await service.restart(2000);
      service.modes[side] = 'ok';
      await service.alarm();
      const after = await service.status();
      expect(after.state).toBe('complete');
      for (const field of ['eventHash', 'installationHash', 'occurredAt', 'requestId'])
        expect(after.work[field]).toBe(before.work[field]);
      expect(service.calls[side]).toBe(2);
      expect(service.calls[side === 'edge' ? 'sql' : 'edge']).toBe(1);
    }
  );
  it.each(['401', '404', '500', '503', 'generic', 'forged'])(
    'does not count %s as SQL completion',
    async mode => {
      service = await start({ config });
      service.modes.sql = mode;
      await service.request('/intake');
      expect(await service.status()).toMatchObject({
        state: 'pending',
        work: { edgeAcknowledged: true, sqlAcknowledged: false },
      });
    }
  );
  it('quarantines a verified missing mapping and only retries it after private resume', async () => {
    service = await start({ config });
    service.modes.sql = 'missing';
    await service.request('/intake');
    expect((await service.status()).state).toBe('quarantined');
    await service.restart(86_400_000);
    await service.alarm();
    expect(service.calls.sql).toBe(1);
    service.modes.sql = 'ok';
    await service.request('/resume');
    expect((await service.status()).state).toBe('complete');
  });
  it('bounds automatic retries, retains unfinished work and permits authenticated recovery', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    for (let i = 0; i < 10; i++) {
      await service.restart(86_400_000);
      await service.alarm();
    }
    expect(service.calls.sql).toBe(8);
    expect((await service.status()).state).toBe('pending');
    service.modes.sql = 'ok';
    await service.request('/resume');
    expect((await service.status()).state).toBe('complete');
  });
  it('deletes expired completed details while preserving a permanent replay tombstone', async () => {
    service = await start({ config });
    await service.request('/intake');
    await service.restart(29 * 86_400_000);
    await service.alarm();
    expect((await service.status()).state).toBe('complete');
    await service.restart(86_400_001);
    await service.alarm();
    expect((await service.status()).state).toBe('retired');
    expect(await service.storage()).toEqual({ work: [], fence: [{ id: 1 }] });
    await service.request('/intake');
    await service.alarm();
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
  });
  it('rejects extra private fields before durable admission and emits no private canary', async () => {
    service = await start({ config });
    const canary = 'private-canary-never-store';
    expect(
      (await service.request('/intake', { ...service.identity, payload: canary })).status
    ).toBe(503);
    expect((await service.rawRequest('/intake', { method: 'POST', body: canary })).status).toBe(
      503
    );
    expect(await service.storage()).toEqual({ work: [], fence: [] });
    expect(JSON.stringify(service.evidence())).not.toContain(canary);
  });
});
