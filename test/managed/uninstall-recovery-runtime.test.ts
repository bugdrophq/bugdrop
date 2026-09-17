import { afterEach, describe, expect, it } from 'vitest';
import { start } from '../../managed/uninstall/test-adapter.mjs';
import { tombstone, type Pending } from '../../src/managed/uninstall/state';
import { config } from './github-staging-fixtures';
let service: Awaited<ReturnType<typeof start>>;
const retention = 30 * 86_400_000;
const applicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(async () => {
  await service?.close();
});
async function expired(recovery = true) {
  service = await start({ config, applicationId, recovery });
  service.modes.sql = '503';
  await service.prewarm();
  await service.request('/intake');
  await service.restart(retention);
  await service.alarm();
}
async function continuation(recoveryRequestId = crypto.randomUUID()) {
  return {
    ...service.identity,
    recoveryRequestId,
    tombstonedAt: (await service.status()).work.tombstonedAt,
    tombstoneId: (await service.status()).work.tombstoneId,
  };
}
describe('actual SQLite retention and private continuation', () => {
  it('retains deadline alarm when retries exhaust and recovers alarm loss on duplicate intake', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    const original = await service.status();
    for (let i = 0; i < 8; i++) {
      await service.restart(86_400_000);
      await service.alarm();
    }
    expect(await service.alarmTime()).toBe(original.work.occurredAt + retention);
    await service.deleteAlarm();
    await service.restart();
    await service.request('/intake');
    expect(await service.alarmTime()).toBe(original.work.occurredAt + retention);
    await service.restart(22 * 86_400_000);
    await service.request('/resume');
    expect((await service.status()).state).toBe('operator_action_required');
    expect(service.calls.sql).toBe(8);
  });
  it('keeps only the retention alarm after a crash saving the last retry attempt', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    const original = await service.status();
    for (let i = 0; i < 6; i++) {
      await service.restart(86_400_000);
      await service.alarm();
    }
    await service.restart(86_400_000);
    service.setFault(1, 'sync-failure');
    expect((await service.alarm()).status).not.toBe(200);
    await service.restart(86_400_000);
    for (let i = 0; i < 2; i++) {
      await service.alarm();
      expect(await service.alarmTime()).toBe(original.work.occurredAt + retention);
    }
    expect(service.calls.sql).toBe(7);
  });
  it('tombstones atomically across failed sync, preserving fence and incomplete acknowledgements', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    await service.restart(retention);
    service.setFault(1, 'sync-failure');
    expect((await service.request('/resume')).status).toBe(503);
    await service.restart();
    const state = await service.status();
    expect(state).toMatchObject({
      state: 'operator_action_required',
      work: { sqlAcknowledged: false },
    });
    expect(Object.keys(state.work).sort()).toEqual(
      [
        'edgeAcknowledged',
        'eventHash',
        'failureCode',
        'installationHash',
        'occurredAt',
        'recoveryAttempts',
        'requestId',
        'routingHash',
        'sqlAcknowledged',
        'state',
        'tombstonedAt',
        'tombstoneId',
      ].sort()
    );
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
    expect(service.calls.sql).toBe(1);
  });
  it('rolls back a failed tombstone transaction without partial deletion or completion', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    const before = await service.storage();
    await service.advance(retention);
    await service.failTransaction();
    expect((await service.request('/resume')).status).toBe(503);
    expect(await service.storage()).toEqual(before);
    expect(service.calls.sql).toBe(1);
    await service.alarm();
    expect((await service.status()).state).toBe('operator_action_required');
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
  });
  it('rejects late successful side acknowledgements across the deadline', async () => {
    service = await start({ config });
    service.modes.sql = '503';
    await service.request('/intake');
    await service.advance(retention - 1);
    service.modes.sql = 'ok';
    service.transport.hook = async side => {
      if (side === 'sql') await service.advance(1);
    };
    await service.request('/resume');
    expect(await service.status()).toMatchObject({
      state: 'operator_action_required',
      work: { sqlAcknowledged: false },
    });
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
  });
  it('has no recovery route capability without its separately keyed binding', async () => {
    await expired(false);
    expect((await service.request('/continue', await continuation())).status).toBe(503);
    expect((await service.status()).work.recoveryAttempts).toBe(0);
    expect(service.recovery.calls).toBe(0);
  });
  it.each(['before', 'during'])(
    'rejects changed mapping scope %s recovery verification',
    async when => {
      await expired();
      const body = await continuation();
      const change = () =>
        service.changeScope({ applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      if (when === 'before') await change();
      else
        service.recovery.hook = async proof => {
          await change();
          return proof;
        };
      const observed = await service.settled(await service.request('/continue', body));
      const diagnostic = JSON.stringify(observed);
      expect(observed.intake.status, diagnostic).toBe(503);
      expect(observed.state.state, diagnostic).toBe('operator_action_required');
      expect(observed.recoveryCalls, diagnostic).toBe(when === 'before' ? 0 : 1);
      expect(service.calls.sql).toBe(1);
      expect((await service.storage()).fence).toEqual([{ id: 1 }]);
    }
  );
  it('consumes a trusted challenge once and returns the same linked cycle after response loss', async () => {
    await expired();
    const original = await service.status();
    let secret = '';
    service.recovery.hook = async proof => {
      secret = String(proof.challenge);
      return proof;
    };
    const body = await continuation();
    service.setFault(2, 'sync-failure');
    expect((await service.request('/continue', body)).status).toBe(503);
    await service.restart();
    expect((await service.request('/continue', body)).status).toBe(200);
    const linked = await service.status();
    expect(linked.state).toBe('pending');
    expect(linked.work.recoveryRequestId).toBe(body.recoveryRequestId);
    expect(linked.work.requestId).toBe(original.work.requestId);
    expect(linked.work.occurredAt).toBe(original.work.occurredAt);
    expect(linked.work).not.toHaveProperty('recoveryAttempt');
    expect(JSON.stringify(await service.storage())).not.toContain(secret);
    expect(service.recovery.calls).toBe(1);
    expect((await service.request('/continue', await continuation())).status).toBe(503);
    await service.restart(retention);
    await service.alarm();
    expect((await service.status()).state).toBe('operator_action_required');
    expect((await service.request('/continue', body)).status).toBe(503);
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
  });
  it.each(['sync-failure', 'crash'])(
    'supersedes an expired attempt after %s before the adapter call',
    async fault => {
      await expired();
      const body = await continuation();
      service.setFault(1, fault);
      try {
        expect((await service.request('/continue', body)).status).not.toBe(200);
      } catch (error) {
        expect(String(error)).toContain('injected_uninstall_post_sync_crash');
      }
      await service.restart();
      const before = await service.status();
      expect(service.recovery.calls).toBe(0);
      expect((await service.request('/continue', body)).status).toBe(503);
      await service.restart(30_000);
      expect((await service.request('/continue', body)).status).toBe(200);
      expect((await service.status()).work.continuationId).not.toBe(
        before.work.recoveryAttempt.generation
      );
      expect(service.recovery.calls).toBe(1);
    }
  );
  it('rejects a delayed old generation after a new one is accepted', async () => {
    await expired();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    service.recovery.hook = async proof => {
      started();
      await held;
      return proof;
    };
    const first = service.request('/continue', await continuation());
    await ready;
    await service.advance(30_000);
    service.recovery.hook = undefined;
    const body = await continuation();
    expect((await service.request('/continue', body)).status).toBe(200);
    const accepted = await service.status();
    release();
    expect((await first).status).toBe(503);
    expect(await service.status()).toEqual(accepted);
    expect(accepted.work.recoveryRequestId).toBe(body.recoveryRequestId);
  });
  it('rejects old signed continuation after multiple cycles without retaining routing', async () => {
    await expired();
    const first = await continuation();
    expect((await service.request('/continue', first)).status).toBe(200);
    await service.restart(retention);
    await service.alarm();
    const second = await continuation();
    expect((await service.request('/continue', second)).status).toBe(200);
    await service.restart(retention);
    await service.alarm();
    const before = await service.status();
    expect((await service.request('/continue', first)).status).toBe(503);
    expect(await service.status()).toEqual(before);
    expect(service.recovery.calls).toBe(2);
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
  });
  it('uses distinct tombstone identities even at the same timestamp and rejects rollback evidence', async () => {
    service = await start({ config, applicationId, recovery: true });
    service.modes.sql = '503';
    await service.request('/intake');
    const pending = (await service.status()).work as Pending;
    const a = tombstone(pending),
      b = tombstone(pending);
    expect(a.tombstonedAt).toBe(b.tombstonedAt);
    expect(a.tombstoneId).not.toBe(b.tombstoneId);
    await service.restart(retention);
    await service.alarm();
    const body = await continuation();
    await service.advance(-1);
    expect((await service.request('/continue', body)).status).toBe(503);
    expect(service.recovery.calls).toBe(0);
    expect((await service.status()).state).toBe('operator_action_required');
  });
  it('bounds invalid recovery attempts and never uses caller booleans or raw proofs', async () => {
    await expired();
    service.recovery.mode = 'forged';
    expect(
      (await service.request('/continue', { ...(await continuation()), providerRemoved: true }))
        .status
    ).toBe(503);
    for (let i = 0; i < 9; i++) {
      expect((await service.request('/continue', await continuation())).status).toBe(503);
      await service.advance(30_000);
    }
    expect(service.recovery.calls).toBe(8);
    expect((await service.status()).state).toBe('operator_action_required');
    expect(service.calls.sql).toBe(1);
  });
});
