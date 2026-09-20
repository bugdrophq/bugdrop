import { installationRecordKey } from './installation-analytics';
import type { Env } from '../types';

const USAGE_PREFIX = 'installation-usage:';
const DELETION_GUARD_PREFIX = 'installation-usage-deleted:';
const DELETION_GUARD_TTL_SECONDS = 7 * 24 * 60 * 60;

interface InstallationUsageRecord {
  schemaVersion: 1;
  installationId: number;
  successfulFeedbackCount: number;
}

export function installationUsageEnabled(env: Env): boolean {
  return env.INSTALLATION_USAGE_ENABLED === 'true';
}

function installationUsageKey(installationId: number): string {
  assertInstallationId(installationId);
  return `${USAGE_PREFIX}${installationId}`;
}

function installationUsageDeletionGuardKey(installationId: number): string {
  assertInstallationId(installationId);
  return `${DELETION_GUARD_PREFIX}${installationId}`;
}

export async function installationUsageWasDeleted(
  store: KVNamespace,
  installationId: number
): Promise<boolean> {
  return (await store.get(installationUsageDeletionGuardKey(installationId))) !== null;
}

export async function installationIdentityExists(
  store: KVNamespace,
  installationId: number
): Promise<boolean> {
  return (await store.get(installationRecordKey(installationId))) !== null;
}

export async function writeInstallationUsageRecord(
  store: KVNamespace,
  installationId: number,
  successfulFeedbackCount: number
): Promise<void> {
  const record: InstallationUsageRecord = {
    schemaVersion: 1,
    installationId,
    successfulFeedbackCount,
  };
  assertInstallationUsageRecord(record, installationId);
  await store.put(installationUsageKey(installationId), JSON.stringify(record));
}

export async function deleteInstallationUsageRecord(
  store: KVNamespace,
  installationId: number
): Promise<void> {
  await store.delete(installationUsageKey(installationId));
}

export async function markInstallationUsageDeleted(
  store: KVNamespace,
  installationId: number
): Promise<void> {
  await store.put(installationUsageDeletionGuardKey(installationId), '1', {
    expirationTtl: DELETION_GUARD_TTL_SECONDS,
  });
}

function assertInstallationUsageRecord(
  value: unknown,
  expectedInstallationId: number
): asserts value is InstallationUsageRecord {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['schemaVersion', 'installationId', 'successfulFeedbackCount']) ||
    value.schemaVersion !== 1 ||
    value.installationId !== expectedInstallationId ||
    !Number.isSafeInteger(value.successfulFeedbackCount) ||
    (value.successfulFeedbackCount as number) < 0
  ) {
    throw new Error('Invalid installation usage record');
  }
}

function assertInstallationId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid installation ID');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
