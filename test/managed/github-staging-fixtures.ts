import { generateKeyPairSync } from 'node:crypto';
import type { StagingGitHubConfig } from '../../src/managed/github-staging/config';

export const config: StagingGitHubConfig = {
  schemaVersion: 1,
  environment: 'staging',
  enabled: true,
  dedicatedDogfood: true,
  appId: 101,
  appSlug: 'fixture-staging-dogfood',
  installationId: 202,
  owner: 'fixture-org',
  ownerId: 303,
  repository: 'fixture-dogfood',
  repositoryId: 404,
};
export const installation = {
  id: 202,
  app_id: 101,
  app_slug: config.appSlug,
  account: { id: 303, login: config.owner, type: 'Organization' },
  target_type: 'Organization',
  repository_selection: 'selected',
  suspended_at: null,
  permissions: { issues: 'write', metadata: 'read' },
};
export const repository = {
  private: true,
  id: 404,
  name: config.repository,
  full_name: `${config.owner}/${config.repository}`,
  owner: { id: 303, login: config.owner },
};
export const token = 'ghs_synthetic_staging_fixture_not_a_credential';
export const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({
    format: 'pem',
    type: 'pkcs1',
  })
  .toString();
export const canary = 'private-content-staging-canary';
export const report = JSON.stringify({ message: canary, page: 'https://private.example/report' });
export const request = () =>
  new Request('https://private-binding.invalid/deliver', {
    method: 'POST',
    body: report,
  });
export function tokenResponse() {
  return {
    token,
    permissions: { issues: 'write', metadata: 'read' },
    repositories: [repository],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
