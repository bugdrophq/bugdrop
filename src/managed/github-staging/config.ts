import { keys, record, reject } from '../local/protocol';

/** Reviewed operational configuration, never assembled from a submission. */
export interface StagingGitHubConfig {
  schemaVersion: 1;
  environment: 'staging';
  enabled: true;
  dedicatedDogfood: true;
  appId: number;
  appSlug: string;
  installationId: number;
  owner: string;
  ownerId: number;
  repository: string;
  repositoryId: number;
}

export function stagingConfig(input: unknown): StagingGitHubConfig {
  const value = record(input);
  keys(value, [
    'schemaVersion',
    'environment',
    'enabled',
    'dedicatedDogfood',
    'appId',
    'appSlug',
    'installationId',
    'owner',
    'ownerId',
    'repository',
    'repositoryId',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.environment !== 'staging' ||
    value.enabled !== true ||
    value.dedicatedDogfood !== true
  )
    reject();
  for (const key of ['appId', 'installationId', 'ownerId', 'repositoryId']) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) reject();
  }
  for (const key of ['appSlug', 'owner', 'repository']) {
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value[key]))
      reject();
  }
  if (!/staging|dogfood/.test(String(value.appSlug)) || !/dogfood/.test(String(value.repository)))
    reject();
  return {
    schemaVersion: 1,
    environment: 'staging',
    enabled: true,
    dedicatedDogfood: true,
    appId: value.appId as number,
    appSlug: value.appSlug as string,
    installationId: value.installationId as number,
    owner: value.owner as string,
    ownerId: value.ownerId as number,
    repository: value.repository as string,
    repositoryId: value.repositoryId as number,
  };
}

export function minimalPermissions(input: unknown): void {
  const permissions = record(input);
  keys(permissions, ['issues', 'metadata']);
  if (
    permissions.issues !== 'write' ||
    (permissions.metadata !== undefined && permissions.metadata !== 'read')
  )
    reject();
}

export function installationIdentity(input: unknown, config: StagingGitHubConfig): void {
  const value = record(input);
  const account = record(value.account);
  if (
    value.id !== config.installationId ||
    value.app_id !== config.appId ||
    value.app_slug !== config.appSlug ||
    account.id !== config.ownerId ||
    account.login !== config.owner ||
    account.type !== 'Organization'
  )
    reject();
}

export function installationMatches(input: unknown, config: StagingGitHubConfig): void {
  installationIdentity(input, config);
  const value = record(input);
  if (
    value.target_type !== 'Organization' ||
    value.repository_selection !== 'selected' ||
    value.suspended_at !== null
  )
    reject();
  minimalPermissions(value.permissions);
}

export function repositoryMatches(input: unknown, config: StagingGitHubConfig): void {
  const value = record(input);
  const owner = record(value.owner);
  if (
    value.private !== true ||
    value.id !== config.repositoryId ||
    value.name !== config.repository ||
    value.full_name !== `${config.owner}/${config.repository}` ||
    owner.id !== config.ownerId ||
    owner.login !== config.owner
  )
    reject();
}
