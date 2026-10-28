import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { GitHubInstallationInventory } from '../src/lib/github-installation-inventory';
import {
  INSTALLATION_COUNT_KEY,
  getPublicInstallationCount,
  publishInstallationCount,
} from '../src/lib/public-installation-count';
import api from '../src/routes/api';

function environment(initial: string | null = null) {
  let stored = initial;
  const put = vi.fn(async (_key: string, value: string) => {
    stored = value;
  });
  const env = {
    ALLOWED_ORIGINS: '*',
    INSTALLATION_COUNT_EXCLUDED_OWNERS: 'mean-weasel, NeonWatty,bugdrophq',
    INSTALLATION_ANALYTICS: { get: vi.fn(async () => stored), put },
  } as unknown as Env;
  return { env, put, read: () => stored };
}

function inventory(count = 173): GitHubInstallationInventory {
  return {
    installationIds: Array.from({ length: count }, (_, i) => i + 1),
    records: ['MEAN-WEASEL', 'neonwatty', 'bugdrophq'].map((login, i) => ({
      installationId: i + 1,
      account: { login, type: 'Organization', profileUrl: `https://github.com/${login}` },
      installedAt: '2026-10-01T00:00:00.000Z',
    })),
    skippedCount: count - 3,
    pageCount: 2,
  };
}

const now = new Date('2026-10-28T18:00:00.000Z');

describe('public installation aggregate', () => {
  it('uses the complete inventory, excludes owned accounts and stores no identities', async () => {
    const { env, put } = environment();
    await publishInstallationCount(env, inventory(), now);
    expect(put).toHaveBeenCalledWith(
      INSTALLATION_COUNT_KEY,
      JSON.stringify({
        schemaVersion: 1,
        githubAppInstallations: 170,
        display: '170+',
        updatedAt: now.toISOString(),
      })
    );
    expect(put.mock.calls[0][1]).not.toMatch(/bugdrophq|neonwatty|installationId|profileUrl/);
    expect(await getPublicInstallationCount(env)).toEqual({
      schemaVersion: 1,
      githubAppInstallations: 170,
      display: '170+',
      updatedAt: now.toISOString(),
    });
  });

  it('allows a lower total after uninstalls instead of retaining an inflated floor', async () => {
    const { env } = environment();
    await publishInstallationCount(env, inventory(), now);
    await publishInstallationCount(env, inventory(153), now);
    expect((await getPublicInstallationCount(env))?.display).toBe('150+');
  });

  it('projects public fields even if a stored snapshot contains extra private fields', async () => {
    const { env } = environment(
      JSON.stringify({
        schemaVersion: 1,
        githubAppInstallations: 170,
        display: '170+',
        updatedAt: now.toISOString(),
        accounts: ['private-account'],
        installationIds: [123],
      })
    );
    const response = await api.fetch(
      new Request('https://stats.bugdrop.localhost/stats/installations'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      githubAppInstallations: 170,
      display: '170+',
      updatedAt: now.toISOString(),
    });
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300');
  });

  it.each([
    null,
    '{bad',
    'null',
    '{}',
    JSON.stringify({
      schemaVersion: 1,
      githubAppInstallations: 171,
      display: '171+',
      updatedAt: now.toISOString(),
    }),
    JSON.stringify({
      schemaVersion: 1,
      githubAppInstallations: 170,
      display: '900+',
      updatedAt: now.toISOString(),
    }),
  ])(
    'returns an uncached unavailable response for missing or malformed storage: %s',
    async initial => {
      const { env } = environment(initial);
      const response = await api.fetch(
        new Request('https://stats.bugdrop.localhost/stats/installations'),
        env
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Installation count unavailable' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  );
});
