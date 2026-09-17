import { afterEach, describe, expect, it } from 'vitest';
import { start } from '../../managed/uninstall/test-adapter.mjs';
import { config } from './github-staging-fixtures';
let service: Awaited<ReturnType<typeof start>>;
const retention = 30 * 86_400_000;
const applicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(async () => {
  await service?.close();
});
describe('immutable admitted uninstall routing across configuration changes', () => {
  it.each(['installationId', 'appId'] as const)(
    'never redirects admitted work after configured %s changes',
    async field => {
      const target = { ...config };
      service = await start({ config: target });
      service.modes.edge = '503';
      service.modes.sql = '503';
      await service.request('/intake');
      const original = await service.status();
      target[field]++;
      await service.restart(2000);
      service.modes.edge = 'ok';
      service.modes.sql = 'ok';
      await service.alarm();
      expect(service.calls).toEqual({ edge: 1, sql: 1 });
      const stored = JSON.parse((await service.storage()).work[0].value);
      expect(stored).toMatchObject({
        eventHash: original.work.eventHash,
        installationHash: original.work.installationHash,
        edgeAcknowledged: false,
        sqlAcknowledged: false,
        completedAt: null,
      });
      expect(await service.alarmTime()).toBe(original.work.occurredAt + retention);
      expect((await service.storage()).fence).toEqual([{ id: 1 }]);
    }
  );
  it('binds the configured SQL application scope across restart', async () => {
    service = await start({ config: { ...config }, applicationId });
    service.modes.edge = '503';
    service.modes.sql = '503';
    await service.request('/intake');
    const before = await service.status();
    await service.changeScope({ applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await service.restart(2000);
    service.modes.edge = 'ok';
    service.modes.sql = 'ok';
    await service.alarm();
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
    expect(await service.alarmTime()).toBe(before.work.occurredAt + retention);
    expect(JSON.parse((await service.storage()).work[0].value)).toMatchObject({
      routingHash: before.work.routingHash,
      completedAt: null,
    });
  });
  it.each(['installationId', 'applicationId'])(
    'rechecks %s between effects and retains only valid old acknowledgement',
    async field => {
      service = await start({ config: { ...config }, applicationId });
      service.transport.hook = async side => {
        if (side === 'edge')
          await service.changeScope(
            field === 'installationId'
              ? { installationId: config.installationId + 1 }
              : { applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
          );
      };
      await service.request('/intake');
      const stored = JSON.parse((await service.storage()).work[0].value);
      expect(service.calls).toEqual({ edge: 1, sql: 0 });
      expect(stored).toMatchObject({
        edgeAcknowledged: true,
        sqlAcknowledged: false,
        completedAt: null,
        nextAttemptAt: 0,
      });
      expect(await service.alarmTime()).toBe(stored.occurredAt + retention);
      await service.restart(2000);
      await service.alarm();
      expect(service.calls).toEqual({ edge: 1, sql: 0 });
    }
  );
  it('uses immutable old receipt scope during SQL await and never redirects it', async () => {
    service = await start({ config: { ...config }, applicationId });
    service.transport.hook = async side => {
      if (side === 'sql') await service.changeScope({ installationId: config.installationId + 1 });
    };
    await service.request('/intake');
    const stored = JSON.parse((await service.storage()).work[0].value);
    expect(stored).toMatchObject({ edgeAcknowledged: true, sqlAcknowledged: true });
    expect(stored.completedAt).not.toBeNull();
    expect(service.evidence().sqlReceipts[0].installationId).toBe(String(config.installationId));
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
    expect(service.evidence().sqlReceipts).toHaveLength(1);
    await service.restart(2000);
    await service.alarm();
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
    expect((await service.storage()).fence).toEqual([{ id: 1 }]);
  });
  it('permits a target changed away then restored before the next immutable effect', async () => {
    service = await start({ config: { ...config }, applicationId });
    service.transport.hook = async side => {
      if (side === 'edge') {
        await service.changeScope({ installationId: config.installationId + 1 });
        await service.changeScope({ installationId: config.installationId });
      }
    };
    await service.request('/intake');
    expect((await service.status()).state).toBe('complete');
    expect(service.evidence().sqlReceipts[0].installationId).toBe(String(config.installationId));
    expect(service.calls).toEqual({ edge: 1, sql: 1 });
  });
});
