import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { hmac, utf8, verifyHmac } from '../../src/managed/local/protocol';
import {
  hashRecoveryChallenge,
  recoverUninstall,
  type RecoveryExpectation,
} from '../../src/managed/uninstall/recovery';

const key = Buffer.alloc(32, 7).toString('base64url');
const now = 1_789_650_000_000;
const expected: RecoveryExpectation = {
  deployment: 'staging',
  githubAppId: 101,
  applicationId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
  providerInstallationId: '202',
  eventHash: 'a'.repeat(64),
  installationHash: 'b'.repeat(64),
  occurredAt: now - 100_000,
  tombstonedAt: now - 1000,
  tombstoneId: 'cd51c858-77ce-4ba2-b806-8fbf07924ace',
  requestId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
  recoveryGeneration: 'ed51c858-77ce-4ba2-b806-8fbf07924ace',
  recoveryRequestId: 'fd51c858-77ce-4ba2-b806-8fbf07924ace',
  challenge: Buffer.alloc(32, 2).toString('base64url'),
  challengeExpiresAt: now + 30_000,
};
const proof = {
  schemaVersion: 1,
  ...expected,
  verifiedAt: now,
  providerRemoved: true,
  mappingConfirmed: true,
  internalMapping: {
    applicationId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
    installationId: 'bd51c858-77ce-4ba2-b806-8fbf07924ace',
  },
};
function environment(
  value: unknown = proof,
  options: { status?: number; key?: string; domain?: string } = {}
) {
  const fetch = vi.fn(async (request: Request) => {
    const requestRaw = await request.text();
    expect(
      await verifyHmac(
        key,
        utf8(`bugdrop:uninstall:recovery-request:v1\0${requestRaw}`),
        request.headers.get('X-BugDrop-Recovery-Signature')!
      )
    ).toBe(true);
    expect(JSON.parse(requestRaw)).toEqual({ schemaVersion: 1, ...expected });
    const raw = JSON.stringify(value);
    return new Response(raw, {
      status: options.status ?? 200,
      headers: {
        'X-BugDrop-Recovery-Signature': await hmac(
          options.key ?? key,
          utf8(`${options.domain ?? 'bugdrop:uninstall:recovery-receipt:v1'}\0${raw}`)
        ),
      },
    });
  });
  return {
    STAGING_UNINSTALL_RECOVERY: { fetch } as unknown as Fetcher,
    STAGING_UNINSTALL_RECOVERY_HMAC_KEY: key,
  };
}
describe('trusted private uninstall recovery assertion', () => {
  it('accepts only bound fresh affirmative evidence and returns no identity or proof', async () => {
    expect(await recoverUninstall(environment(), expected, () => now)).toBe(true);
    expect(
      await recoverUninstall(
        environment({ ...proof, verifiedAt: now - 30_000 }),
        expected,
        () => now
      )
    ).toBe(true);
  });
  it('fails closed without the separately keyed binding', async () => {
    expect(await recoverUninstall({}, expected, () => now)).toBe(false);
    expect(
      await recoverUninstall(
        { STAGING_UNINSTALL_RECOVERY: environment().STAGING_UNINSTALL_RECOVERY },
        expected,
        () => now
      )
    ).toBe(false);
  });
  it.each([
    { verifiedAt: now - 30_001 },
    { verifiedAt: now + 1 },
    { deployment: 'production' },
    { githubAppId: 102 },
    { applicationId: 'another-app' },
    { providerInstallationId: '203' },
    { eventHash: 'c'.repeat(64) },
    { installationHash: 'c'.repeat(64) },
    { occurredAt: now - 1 },
    { requestId: proof.recoveryRequestId },
    { tombstonedAt: now - 999 },
    { tombstoneId: proof.requestId },
    { recoveryGeneration: proof.requestId },
    { recoveryRequestId: proof.requestId },
    { challenge: Buffer.alloc(32, 3).toString('base64url') },
    { challengeExpiresAt: now + 30_001 },
    { providerRemoved: false },
    { mappingConfirmed: false },
    { token: 'private-canary' },
    { internalMapping: { ...proof.internalMapping, tenant: 'private-canary' } },
    {
      internalMapping: {
        ...proof.internalMapping,
        applicationId: proof.internalMapping.installationId,
      },
    },
    {
      internalMapping: {
        applicationId: 'bad',
        installationId: proof.internalMapping.installationId,
      },
    },
  ])('rejects stale, cross-scope, widened or unauthoritative proof %j', async delta => {
    expect(await recoverUninstall(environment({ ...proof, ...delta }), expected, () => now)).toBe(
      false
    );
  });
  it.each([
    { status: 404 },
    { status: 503 },
    { key: Buffer.alloc(32, 8).toString('base64url') },
    { domain: 'bugdrop:uninstall:sql-receipt:v1' },
  ])(
    'rejects transport failures, forged signatures and cross-domain signatures %j',
    async options => {
      expect(await recoverUninstall(environment(proof, options), expected, () => now)).toBe(false);
    }
  );
  it('checks challenge expiry again at receipt arrival', async () => {
    const clock = vi
      .fn()
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 30_000);
    expect(await recoverUninstall(environment(), expected, clock)).toBe(false);
  });
  it('does not contact the service for an expired challenge', async () => {
    const env = environment();
    expect(await recoverUninstall(env, { ...expected, challengeExpiresAt: now }, () => now)).toBe(
      false
    );
    expect(env.STAGING_UNINSTALL_RECOVERY.fetch).not.toHaveBeenCalled();
  });
  it('bounds oversized and stalled response bodies even when transport ignores abort', async () => {
    expect(
      await recoverUninstall(environment({ padding: 'x'.repeat(2049) }), expected, () => now)
    ).toBe(false);
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      let entered!: () => void;
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const env = {
        STAGING_UNINSTALL_RECOVERY_HMAC_KEY: key,
        STAGING_UNINSTALL_RECOVERY: {
          fetch: async () => {
            entered();
            return new Response(new ReadableStream({ cancel }));
          },
        } as unknown as Fetcher,
      };
      const pending = recoverUninstall(env, expected, () => now);
      await started;
      await vi.advanceTimersByTimeAsync(2100);
      expect(await pending).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('hashes only canonical random 32-byte challenges', async () => {
    const hash = await hashRecoveryChallenge(expected.challenge);
    expect(hash).not.toBe(expected.challenge);
    expect(await hashRecoveryChallenge(expected.challenge)).toBe(hash);
    await expect(hashRecoveryChallenge('bad')).rejects.toThrow();
  });
});
