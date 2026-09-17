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
      await service.prewarm();
      const observed = await service.settled(await service.request('/intake'));
      const diagnostic = JSON.stringify(observed);
      expect(observed.intake.status, diagnostic).toBe(200);
      expect(observed.state, diagnostic).toMatchObject({
        state: 'pending',
        work: { edgeAcknowledged: true, sqlAcknowledged: false },
      });
      expect(observed.ledger, diagnostic).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: 'edge', settled: true, status: 200 }),
        ])
      );
    }
  );
  it('keeps a timed-out edge acknowledgement pending independently of SQL500 and recovers', async () => {
    service = await start({ config });
    await service.prewarm();
    service.modes.sql = '500';
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    service.transport.hook = async side => {
      if (side === 'edge') {
        entered();
        await held;
      }
    };
    const began = performance.now();
    const intake = service.request('/intake');
    await started;
    const observed = await service.settled(await intake);
    const diagnostic = JSON.stringify(observed);
    expect(performance.now() - began, diagnostic).toBeGreaterThanOrEqual(1900);
    expect(observed.intake.status, diagnostic).toBe(200);
    expect(observed.state, diagnostic).toMatchObject({
      state: 'pending',
      work: { edgeAcknowledged: false, sqlAcknowledged: false },
    });
    expect(observed.calls, diagnostic).toEqual({ edge: 1, sql: 1 });
    release();
    service.transport.hook = undefined;
    const recovered = await service.settled(await service.request('/resume'));
    expect(recovered.state, JSON.stringify(recovered)).toMatchObject({
      state: 'pending',
      work: { edgeAcknowledged: true, sqlAcknowledged: false },
    });
    expect(recovered.calls).toEqual({ edge: 2, sql: 2 });
  });
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
  it.each(['503', 'missing'])('expires unresolved %s work at the exact deadline', async mode => {
    service = await start({ config });
    service.modes.sql = mode;
    await service.request('/intake');
    const original = await service.status();
    await service.restart(30 * 86_400_000 - 1);
    expect((await service.status()).state).not.toBe('operator_action_required');
    await service.restart(1);
    await service.alarm();
    const expired = await service.status();
    expect(expired).toMatchObject({
      state: 'operator_action_required',
      work: {
        requestId: original.work.requestId,
        occurredAt: original.work.occurredAt,
        edgeAcknowledged: true,
        sqlAcknowledged: false,
        failureCode: 'retention_deadline',
      },
    });
    expect(expired.work).not.toHaveProperty('attempts');
    expect(expired.work).not.toHaveProperty('nextAttemptAt');
    expect(expired.work).not.toHaveProperty('completedAt');
    const calls = { ...service.calls };
    service.modes.sql = 'ok';
    expect((await service.request('/resume')).status).toBe(503);
    await service.request('/intake');
    await service.alarm();
    expect(service.calls).toEqual(calls);
    expect((await service.status()).state).toBe('operator_action_required');
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
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
