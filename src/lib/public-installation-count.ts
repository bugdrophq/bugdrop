import type { Env } from '../types';
import type { GitHubInstallationInventory } from './github-installation-inventory';

export const INSTALLATION_COUNT_CRON = '7 * * * *';
export const INSTALLATION_COUNT_KEY = 'public:github-app-installations:v1';

interface PublicInstallationCount {
  schemaVersion: 1;
  githubAppInstallations: number;
  display: string;
  updatedAt: string;
}

export async function publishInstallationCount(
  env: Env,
  inventory: GitHubInstallationInventory,
  now = new Date()
): Promise<void> {
  if (!env.INSTALLATION_ANALYTICS) throw new Error('Installation count storage is unavailable');
  const excluded = new Set(
    (env.INSTALLATION_COUNT_EXCLUDED_OWNERS ?? '')
      .split(',')
      .map(owner => owner.trim().toLowerCase())
      .filter(Boolean)
  );
  const excludedCount = inventory.records.filter(record =>
    excluded.has(record.account.login.toLowerCase())
  ).length;
  // Include installations without a supported identity record; inventory IDs are authoritative.
  const count = inventory.installationIds.length - excludedCount;
  const githubAppInstallations = Math.floor(count / 10) * 10;
  const snapshot: PublicInstallationCount = {
    schemaVersion: 1,
    githubAppInstallations,
    display: `${githubAppInstallations.toLocaleString('en-US')}+`,
    updatedAt: now.toISOString(),
  };
  // Only a completed GitHub inventory replaces the last verified aggregate. No identities are copied.
  await env.INSTALLATION_ANALYTICS.put(INSTALLATION_COUNT_KEY, JSON.stringify(snapshot));
}

export async function getPublicInstallationCount(
  env: Env
): Promise<PublicInstallationCount | null> {
  if (!env.INSTALLATION_ANALYTICS) return null;
  const raw = await env.INSTALLATION_ANALYTICS.get(INSTALLATION_COUNT_KEY);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid installation count snapshot');
  const snapshot = value as Partial<PublicInstallationCount>;
  const count = snapshot.githubAppInstallations;
  if (
    snapshot.schemaVersion !== 1 ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    (count as number) % 10 !== 0 ||
    snapshot.display !== `${(count as number).toLocaleString('en-US')}+` ||
    typeof snapshot.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
    new Date(snapshot.updatedAt).toISOString() !== snapshot.updatedAt
  ) {
    throw new Error('Invalid installation count snapshot');
  }
  // Explicitly project public fields so unexpected stored fields cannot expose account identities.
  return {
    schemaVersion: 1,
    githubAppInstallations: count as number,
    display: snapshot.display,
    updatedAt: snapshot.updatedAt,
  };
}
