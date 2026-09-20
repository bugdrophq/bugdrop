export const INSTALLATION_RECORD_PREFIX = 'installation:';

type InstallationAccountType = 'User' | 'Organization';

interface InstallationIdentityRecord {
  schemaVersion: 1;
  installationId: number;
  account: {
    login: string;
    type: InstallationAccountType;
    profileUrl: string;
  };
  installedAt: string;
}

export interface NewInstallationRecord {
  installationId: number;
  account: InstallationIdentityRecord['account'];
  installedAt: string;
}

export function installationRecordKey(installationId: number): string {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('Invalid installation ID');
  }
  return `${INSTALLATION_RECORD_PREFIX}${installationId}`;
}

export async function createInstallationRecord(
  store: KVNamespace,
  installation: NewInstallationRecord
): Promise<boolean> {
  const key = installationRecordKey(installation.installationId);
  const existing = await store.get(key);
  if (existing !== null) {
    const record = parseInstallationIdentityRecord(existing, installation.installationId);
    assertInstallationIdentityRecord(record, installation.installationId);
    return false;
  }

  const record: InstallationIdentityRecord = {
    schemaVersion: 1,
    installationId: installation.installationId,
    account: installation.account,
    installedAt: installation.installedAt,
  };
  assertInstallationIdentityRecord(record, installation.installationId);
  await store.put(key, JSON.stringify(record));
  return true;
}

function parseInstallationIdentityRecord(value: string, installationId: number): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid installation identity record for ${installationId}`);
  }
}

function assertInstallationIdentityRecord(
  value: unknown,
  expectedInstallationId: number
): asserts value is InstallationIdentityRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) {
    throw new Error('Invalid installation identity record');
  }
  if (
    value.schemaVersion !== 1 ||
    value.installationId !== expectedInstallationId ||
    !isPlainObject(value.account) ||
    !hasExactKeys(value.account, ACCOUNT_KEYS) ||
    typeof value.account.login !== 'string' ||
    !isGitHubAccountLogin(value.account.login) ||
    !isInstallationAccountType(value.account.type) ||
    typeof value.account.profileUrl !== 'string' ||
    !isCanonicalGitHubProfileUrl(value.account.profileUrl, value.account.login) ||
    !isIsoDate(value.installedAt)
  ) {
    throw new Error('Invalid installation identity record');
  }
}

export function isInstallationAccountType(value: unknown): value is InstallationAccountType {
  return value === 'User' || value === 'Organization';
}

export function isGitHubAccountLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(value);
}

export function isCanonicalGitHubProfileUrl(value: string, login: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      (url.pathname === `/${login}` || url.pathname === `/${login}/`)
    );
  } catch {
    return false;
  }
}

const RECORD_KEYS = ['schemaVersion', 'installationId', 'account', 'installedAt'] as const;
const ACCOUNT_KEYS = ['login', 'type', 'profileUrl'] as const;

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

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
