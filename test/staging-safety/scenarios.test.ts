import { describe, expect, it, vi } from 'vitest';
import { runRemoteSafety, runScenario } from './scenarios.mjs';

describe('remote runner prerequisite mutations, without any remote provider', () => {
  it.each([undefined, '0.1.1'])(
    'rejects observed SDK client pin %s before scenarios',
    async sdkVersion => {
      const target = {
        approved: true,
        environment: 'staging',
        serviceRevision: 'a'.repeat(40),
        deploymentDigest: 'b'.repeat(64),
        repositoryId: '404',
        origin: 'https://staging.example',
        sdkVersion: '0.1.0',
      };
      const provider = {
        inspectTarget: vi.fn(async () => ({
          ...target,
          sdkVersion,
          runId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
        })),
        startScenario: vi.fn(async () => {
          throw new Error('scenario_started');
        }),
      };
      await expect(runRemoteSafety(provider, target)).rejects.toThrow('staging_safety_failed');
      expect(provider.startScenario).not.toHaveBeenCalled();
    }
  );
  it('never claims full uninstall completion from successful edge rejection alone', async () => {
    const service = {
      mint: vi
        .fn()
        .mockResolvedValueOnce({
          schemaVersion: 1,
          token: 'synthetic-capability',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })
        .mockResolvedValueOnce(null),
      uninstallApprovedInstallation: vi.fn(),
      waitForSignedUninstall: vi.fn(),
      restart: vi.fn(),
      submit: vi.fn(async () => ({ schemaVersion: 1, outcome: 'rejected' })),
      evidence: vi.fn(),
    };
    await expect(
      runScenario(service, 'uninstall', { origin: 'https://staging.example' })
    ).rejects.toThrow('staging_uninstall_completion_unavailable');
    expect(service.waitForSignedUninstall).toHaveBeenCalledOnce();
    expect(service.submit).toHaveBeenCalledOnce();
    expect(service.evidence).not.toHaveBeenCalled();
  });
  it.each(['', 'garbage', '0.1.1'])(
    'rejects unsupported SDK pin %s before provider access',
    async sdkVersion => {
      const provider = { inspectTarget: vi.fn(async () => ({})), startScenario: vi.fn() };
      await expect(
        runRemoteSafety(provider, {
          approved: true,
          environment: 'staging',
          serviceRevision: 'a'.repeat(40),
          deploymentDigest: 'b'.repeat(64),
          repositoryId: '404',
          origin: 'https://staging.example',
          sdkVersion,
        })
      ).rejects.toThrow();
      expect(provider.inspectTarget).not.toHaveBeenCalled();
    }
  );
  it('does not call a provider before explicit target approval', async () => {
    const provider = { inspectTarget: vi.fn(), startScenario: vi.fn() };
    await expect(
      runRemoteSafety(provider, { environment: 'staging', approved: false })
    ).rejects.toThrow();
    expect(provider.inspectTarget).not.toHaveBeenCalled();
    expect(provider.startScenario).not.toHaveBeenCalled();
  });
  it('requires successful configured-origin issuance before testing aliases', async () => {
    const service = { mint: vi.fn(async () => null), evidence: vi.fn() };
    await expect(
      runScenario(service, 'origin-aliases', { origin: 'https://staging.example' })
    ).rejects.toThrow('staging_safety_failed');
    expect(service.mint).toHaveBeenCalledOnce();
    expect(service.mint.mock.calls[0]).toEqual([
      expect.objectContaining({ origin: 'https://staging.example' }),
    ]);
    expect(service.evidence).not.toHaveBeenCalled();
  });
  it.each(['stale-authorization', 'substitute-tenantId', 'revoke-credential', 'uninstall'])(
    'requires a valid capability before the %s fault',
    async scenario => {
      const service = {
        mint: vi.fn(async () => null),
        expireAuthorization: vi.fn(),
        substituteTrustedContext: vi.fn(),
        revoke: vi.fn(),
        uninstallApprovedInstallation: vi.fn(),
        submit: vi.fn(async () => ({ schemaVersion: 1, outcome: 'rejected' })),
        restart: vi.fn(),
        waitForSignedUninstall: vi.fn(),
        evidence: vi.fn(),
        secretMarkers: vi.fn(async () => []),
      };
      await expect(
        runScenario(service, scenario, { origin: 'https://staging.example' })
      ).rejects.toThrow();
      expect(service.submit).not.toHaveBeenCalled();
      expect(service.expireAuthorization).not.toHaveBeenCalled();
      expect(service.substituteTrustedContext).not.toHaveBeenCalled();
      expect(service.revoke).not.toHaveBeenCalled();
      expect(service.uninstallApprovedInstallation).not.toHaveBeenCalled();
    }
  );
});
