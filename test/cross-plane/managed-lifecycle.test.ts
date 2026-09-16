import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binding, canaries } from './attack-inputs';
import { startManaged, type ManagedAdapter } from './managed-adapter';
import { assertPrivate, exchange, mint, submission } from './managed-requests';

let service: ManagedAdapter;
beforeEach(async () => {
  service = await startManaged();
}, 60_000);
afterEach(async () => {
  await service?.close();
}, 60_000);

describe.sequential('managed receipt and revocation failure injection', () => {
  it('serializes concurrent duplicates and reminted capabilities into at most one attempt', async () => {
    const capability = await mint(service);
    const reminted = await mint(service);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        service.submit(submission(i % 2 ? capability : reminted))
      )
    );
    expect(results.every(result => ['delivered', 'delivering'].includes(result.outcome))).toBe(
      true
    );
    expect((await service.submit(submission(reminted))).outcome).toBe('delivered');
    const evidence = await assertPrivate(service, [capability.token, reminted.token]);
    expect(evidence.attempts).toBe(1);
    expect(evidence.receipts.length).toBeGreaterThan(0);
    expect(evidence.outcomes.length).toBeGreaterThan(0);
  }, 60_000);

  it('rejects reusing a consumed submission ID for a different exact payload', async () => {
    const first = await mint(service);
    expect((await service.submit(submission(first))).outcome).toBe('delivered');
    const changedBody = JSON.stringify({ message: 'different logical report' });
    const changedBinding = binding(changedBody);
    const second = await mint(service, changedBinding);
    expect((await service.submit(submission(second, changedBody, changedBinding))).outcome).toBe(
      'rejected'
    );
    expect((await assertPrivate(service, [first.token, second.token])).attempts).toBe(1);
  }, 60_000);

  it('rejects expired capabilities while a newly minted capability remains usable', async () => {
    const expired = await mint(service);
    await service.advanceClock(330_001);
    expect((await service.submit(submission(expired))).outcome).toBe('rejected');
    const fresh = await mint(service);
    expect((await service.submit(submission(fresh))).outcome).toBe('delivered');
    expect((await assertPrivate(service, [expired.token, fresh.token])).attempts).toBe(1);
  }, 60_000);

  it.each(['credential', 'application', 'tenant', 'installation'] as const)(
    'refuses both issuance and a previously issued capability after %s revocation',
    async scope => {
      const capability = await mint(service);
      await service.revoke({ scope });
      expect((await exchange(service)).ok).toBe(false);
      expect((await service.submit(submission(capability))).outcome).toBe('rejected');
      await service.restart();
      expect((await exchange(service)).ok).toBe(false);
      expect((await service.submit(submission(capability))).outcome).toBe('rejected');
      expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
    },
    60_000
  );

  it('accepts uninstall authority only from an untampered GitHub installation deletion', async () => {
    for (const invalid of [
      { validSignature: false },
      { tamperBody: true },
      { installationId: 43 },
      { action: 'created' },
      { event: 'push' },
    ]) {
      expect(await service.uninstall(invalid)).toEqual({ accepted: false });
      // Forged or unrelated lifecycle evidence must not mutate this application's authority.
      expect((await exchange(service)).ok).toBe(true);
    }
    const capability = await mint(service);
    expect(await service.uninstall()).toEqual({ accepted: true });
    expect((await exchange(service)).ok).toBe(false);
    expect((await service.submit(submission(capability))).outcome).toBe('rejected');
    await service.restart();
    expect((await exchange(service)).ok).toBe(false);
    expect((await service.submit(submission(capability))).outcome).toBe('rejected');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
  }, 60_000);

  it('fails closed on an authorization projection older than 30 seconds', async () => {
    const capability = await mint(service);
    await service.expireAuthorizationState();
    expect((await exchange(service)).ok).toBe(false);
    expect((await service.submit(submission(capability))).outcome).toBe('rejected');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
    await service.refreshAuthorizationState();
    const refreshed = await mint(service);
    expect((await service.submit(submission(refreshed))).outcome).toBe('delivered');
  }, 60_000);

  it.each(['indeterminate', 'timeout'] as const)(
    'persists %s as indeterminate without retry after replay, remint or restart',
    async mode => {
      await service.setDeliveryMode(mode, { canary: canaries.github });
      const capability = await mint(service);
      expect((await service.submit(submission(capability))).outcome).toBe('indeterminate');
      const reminted = await mint(service);
      expect((await service.submit(submission(reminted))).outcome).toBe('indeterminate');
      await service.restart();
      expect((await service.submit(submission(reminted))).outcome).toBe('indeterminate');
      const evidence = await assertPrivate(service, [capability.token, reminted.token]);
      expect(evidence.attempts).toBe(1);
      expect(evidence.receipts.length).toBeGreaterThan(0);
      expect(JSON.stringify(evidence.outcomes)).toContain('indeterminate');
    },
    60_000
  );

  it('recovers a crash during delivering as indeterminate without a second attempt', async () => {
    await service.setDeliveryMode('hold', { canary: canaries.github });
    const capability = await mint(service);
    const inFlight = service.submit(submission(capability));
    await expect.poll(async () => (await service.evidence()).attempts, { timeout: 10_000 }).toBe(1);
    const replay = await service.submit(submission(capability));
    expect(replay.outcome).toBe('delivering');
    await service.restart();
    const interrupted = await inFlight;
    expect(interrupted.outcome).toBe('indeterminate');
    expect((await service.submit(submission(capability))).outcome).toBe('indeterminate');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(1);
  }, 60_000);

  it('permits an explicit new submission after an ambiguous outcome without retrying the old one', async () => {
    await service.setDeliveryMode('indeterminate', { canary: canaries.github });
    const first = await mint(service);
    expect((await service.submit(submission(first))).outcome).toBe('indeterminate');
    await service.setDeliveryMode('delivered', { canary: canaries.github });
    const nextBinding = { ...binding(), submissionId: 'explicit-new-logical-submission' };
    const second = await mint(service, nextBinding);
    expect((await service.submit({ ...submission(second), binding: nextBinding })).outcome).toBe(
      'delivered'
    );
    expect((await service.submit(submission(first))).outcome).toBe('indeterminate');
    expect((await assertPrivate(service, [first.token, second.token])).attempts).toBe(2);
  }, 60_000);
});
