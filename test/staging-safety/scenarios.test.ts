import { describe, expect, it, vi } from 'vitest';
import { runRemoteSafety, runScenario } from './scenarios.mjs';

describe('remote runner prerequisite mutations, without any remote provider', () => {
  it('does not call a provider before explicit target approval', async () => {
    const provider = { inspectTarget: vi.fn(), startScenario: vi.fn() };
    await expect(
      runRemoteSafety(provider, { environment: 'staging', approved: false })
    ).rejects.toThrow();
    expect(provider.inspectTarget).not.toHaveBeenCalled();
    expect(provider.startScenario).not.toHaveBeenCalled();
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
