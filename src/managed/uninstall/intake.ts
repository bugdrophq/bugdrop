import type { StagingGithubEnv } from '../staging/github-env';
import type { StagingGitHubConfig } from '../github-staging/config';
import { hmac, utf8 } from '../local/protocol';
import { commitments } from './contracts';

/** Called only after exact raw-body GitHub authentication and configured identity checks. */
export async function admitVerifiedUninstall(
  env: StagingGithubEnv,
  config: StagingGitHubConfig
): Promise<Response> {
  const scoped = await commitments(
    env.STAGING_UNINSTALL_COMMITMENT_KEY,
    config.appId,
    config.installationId
  );
  const raw = JSON.stringify({ schemaVersion: 1, ...scoped });
  return env.STAGING_UNINSTALLS.get(
    env.STAGING_UNINSTALLS.idFromName(scoped.installationHash)
  ).fetch('http://uninstall.bugdrop.localhost/intake', {
    method: 'POST',
    body: raw,
    headers: {
      'X-BugDrop-Uninstall-Signature': await hmac(
        env.STAGING_UNINSTALL_COMMITMENT_KEY,
        utf8(`bugdrop:uninstall:intake:v1\0${raw}`)
      ),
    },
  });
}
