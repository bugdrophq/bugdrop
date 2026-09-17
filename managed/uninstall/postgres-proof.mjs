// Explicit local integration gate: missing real dependencies fail, never skip.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { start } from './test-adapter.mjs';

const dataRoot = process.env.BUGDROP_DATA_TEST_ROOT;
const controlRoot = process.env.BUGDROP_CONTROL_TEST_ROOT ?? process.cwd();
if (!dataRoot) throw new Error('local_postgres_adapter_unavailable');
const data = await import(
  pathToFileURL(join(resolve(dataRoot), 'supabase/tests/helpers/reconciliation.mjs')).href
);
const cases = [];
for (const [slot, failedSide] of [
  [87, 'sql'],
  [88, 'edge'],
  [89, 'none'],
]) {
  let service;
  data.cleanupReconciliationFixture(slot);
  const fixture = data.setupReconciliationFixture(slot);
  try {
    const config = {
      schemaVersion: 1,
      environment: 'staging',
      enabled: true,
      dedicatedDogfood: true,
      appId: 101,
      appSlug: 'fixture-staging-dogfood',
      installationId: Number(fixture.installationId),
      owner: 'fixture-org',
      ownerId: 303,
      repository: 'fixture-dogfood',
      repositoryId: 404,
    };
    service = await start({
      config,
      applicationId: fixture.applicationId,
      controlRoot: resolve(controlRoot),
      sqlApply: data.applyVerifiedUninstall,
    });
    const projection = {
      schemaVersion: 1,
      sequence: 1,
      projection: {
        tenantId: fixture.tenantId,
        applicationId: fixture.applicationId,
        destinationId: fixture.destinationId,
        installationId: fixture.installationId,
        keyId: fixture.keyId,
        configurationVersion: 1,
        authorizationVersion: 1,
        origin: 'https://coordinator.example',
        credentialActive: true,
        applicationActive: true,
        installationActive: true,
        tenantActive: true,
        observedAt: Date.now(),
      },
    };
    assert.equal((await service.projection(projection)).status, 200);
    if (failedSide !== 'none') service.modes[failedSide] = 'lost';
    assert.equal((await service.request('/intake')).status, 200);
    const first = await service.status();
    assert.equal(first.state, failedSide === 'none' ? 'complete' : 'pending');
    // Both actual stores committed even when one response was lost.
    assert.deepEqual((await service.edgeStorage()).revocation, [{ id: 1 }]);
    assert.deepEqual(data.inspectReconciliationFixture(slot), {
      installationPresent: false,
      applicationDisabled: true,
      destinationCount: 0,
      credentialCount: 0,
      outboxCount: 0,
      scopeClosed: true,
      sqlReceiptCount: 1,
    });
    await service.restart(2000);
    if (failedSide !== 'none') service.modes[failedSide] = 'ok';
    await service.alarm();
    const completed = await service.status();
    assert.equal(completed.state, 'complete');
    for (const field of ['eventHash', 'installationHash', 'occurredAt', 'requestId'])
      assert.equal(completed.work[field], first.work[field]);
    await Promise.all(Array.from({ length: 5 }, () => service.request('/intake')));
    assert.equal(data.inspectReconciliationFixture(slot).sqlReceiptCount, 1);
    // A delayed positive publication cannot undo the permanent edge latch.
    assert.equal(
      (
        await service.projection({
          ...projection,
          sequence: 2,
          projection: { ...projection.projection, authorizationVersion: 2, observedAt: Date.now() },
        })
      ).status,
      403
    );
    await service.restart(30 * 86_400_000 + 1);
    await service.alarm();
    assert.equal((await service.status()).state, 'retired');
    assert.deepEqual((await service.storage()).work, []);
    assert.deepEqual((await service.edgeStorage()).revocation, [{ id: 1 }]);
    cases.push({
      scenario:
        failedSide === 'none' ? 'dual-ack-replay-retention' : `${failedSide}-lost-ack-restart`,
      passed: true,
    });
  } finally {
    await service?.close();
    data.cleanupReconciliationFixture(slot);
  }
}
console.log(JSON.stringify({ localOnly: true, stores: ['postgres', 'workerd-sqlite'], cases }));
