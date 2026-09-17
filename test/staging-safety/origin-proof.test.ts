import { describe, expect, it, vi } from 'vitest';
import { proveOrigins } from './origin-proof.mjs';
import { packedSdkSafetyContract } from './scenarios.mjs';
const target = {
  origin: 'https://staging.example:8443',
  applicationId: 'app-test',
  runId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
};
function fixture(local = true) {
  let count = 1;
  const snapshot = () => ({
    runId: target.runId,
    scenario: 'origin-aliases',
    applicationId: target.applicationId,
    count,
    complete: true,
    exclusive: true,
  });
  const service = {
    readExchangeCount: vi.fn(async () => snapshot()),
    ...(local
      ? {
          rejectInvalidOrigin: vi.fn(async () => ({
            outcome: 'client_validation_rejected',
            networkAttempts: 0,
            before: snapshot(),
            after: snapshot(),
          })),
        }
      : {}),
  };
  const mint = vi.fn(async () => {
    count++;
    return null;
  });
  return { service, mint, snapshot };
}
describe('private v2 origin proof distinguishes local rejection and actual denial', () => {
  it('pins the packed runner handshake and records scoped zero/one network deltas', async () => {
    expect(packedSdkSafetyContract).toEqual({ version: 2, sdkVersion: '0.1.0' });
    expect(Object.isFrozen(packedSdkSafetyContract)).toBe(true);
    const { service, mint } = fixture();
    const checks = await proveOrigins(service, target, {}, mint);
    expect(checks).toHaveLength(5);
    expect(
      checks
        .slice(0, 4)
        .map(item => [item.outcome, item.networkAttempts, item.before.count, item.after.count])
    ).toEqual(Array.from({ length: 4 }, () => ['client_validation_rejected', 0, 1, 1]));
    expect(checks[4]).toMatchObject({
      index: 4,
      outcome: 'http_denied',
      networkAttempts: 1,
      before: { count: 1 },
      after: { count: 2 },
    });
    expect(mint).toHaveBeenCalledExactlyOnceWith('https://wrong-origin.invalid', false);
    expect(service.rejectInvalidOrigin?.mock.calls[2]).toEqual([
      expect.objectContaining({ origin: 'https://STAGING.EXAMPLE:8443' }),
    ]);
  });
  it('keeps raw HTTP alias mode honest through independent counters', async () => {
    const { service, mint } = fixture(false);
    const checks = await proveOrigins(service, target, {}, mint);
    expect(checks.every(item => item.outcome === 'http_denied' && item.networkAttempts === 1)).toBe(
      true
    );
    expect(checks[4].after.count).toBe(6);
    expect(mint).toHaveBeenCalledTimes(5);
  });
  it.each([
    { runId: 'wrong' },
    { applicationId: 'other-app' },
    { scenario: 'other-scenario' },
    { complete: false },
    { exclusive: false },
    { count: -1 },
    { count: 1.5 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects missing scope/completeness or ambiguous counters %j', async mutation => {
    const { service, mint, snapshot } = fixture();
    service.rejectInvalidOrigin = vi.fn(async () => ({
      outcome: 'client_validation_rejected',
      networkAttempts: 0,
      before: { ...snapshot(), ...mutation },
      after: snapshot(),
    }));
    await expect(proveOrigins(service, target, {}, mint)).rejects.toThrow(
      'staging_origin_proof_rejected'
    );
    expect(mint).not.toHaveBeenCalled();
  });
  it('rejects a local-rejection claim with a network attempt or mutated earlier snapshot', async () => {
    const { service, mint, snapshot } = fixture();
    const shared = snapshot();
    shared.count = 2;
    service.rejectInvalidOrigin = vi.fn(async () => ({
      outcome: 'client_validation_rejected',
      networkAttempts: 0,
      before: shared,
      after: shared,
    }));
    await expect(proveOrigins(service, target, {}, mint)).rejects.toThrow();
  });
  it('rejects canonical wrong-origin claims with no independently observed request', async () => {
    const { service } = fixture();
    await expect(proveOrigins(service, target, {}, async () => null)).rejects.toThrow();
  });
  it('requires the independent counter even when the client can reject aliases locally', async () => {
    const { service, mint } = fixture();
    await expect(
      proveOrigins({ rejectInvalidOrigin: service.rejectInvalidOrigin }, target, {}, mint)
    ).rejects.toThrow();
  });
});
