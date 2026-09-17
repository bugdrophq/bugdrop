import { WorkerEntrypoint } from 'cloudflare:workers';
import type { StagingGithubEnv } from './github-env';
import { loadAuthority, type Authority } from '../local/authority';
import { verifySubmission } from '../local/capability';
import { submission } from '../local/submission';
import { bytes, json, readBounded, reject, utf8 } from '../local/protocol';
import { stagingConfig } from '../github-staging/config';
import { handleGitHubDelivery } from '../github-staging/delivery';
import { verifyGitHubUninstall } from '../github-staging/webhook';
import { admitVerifiedUninstall } from '../uninstall/intake';
export { StagingUninstall } from '../uninstall/coordinator';
export { UninstallControl } from '../uninstall/control';
const refused = () =>
  Response.json(
    { outcome: 'failed_before_delivery' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
function configured(env: StagingGithubEnv) {
  if (env.ENVIRONMENT !== 'staging' || env.STAGING_ENABLED !== 'true') reject();
  return stagingConfig(json(utf8(env.STAGING_GITHUB_TARGET_JSON)));
}
async function authority(env: StagingGithubEnv, installationId: number): Promise<Authority> {
  const result = await loadAuthority(env.STAGING_AUTHORITY);
  if (
    result.realm !== 'staging' ||
    result.projection.applicationId !== env.STAGING_APPLICATION_ID ||
    result.projection.destinationId !== env.STAGING_DESTINATION_ID ||
    result.projection.installationId !== String(installationId)
  )
    reject();
  return result;
}
export default {
  async fetch(request: Request, env: StagingGithubEnv): Promise<Response> {
    try {
      if (
        env.STAGING_DELIVERY_ENABLED !== 'true' ||
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/attempt'
      )
        return refused();
      const config = configured(env);
      const input = submission(json(await readBounded(request)));
      const raw = bytes(input.body);
      const initial = await authority(env, config.installationId);
      await verifySubmission(input.token, input.origin, input.binding, raw, initial);
      return await handleGitHubDelivery(
        new Request('http://github.bugdrop.localhost/deliver', { method: 'POST', body: raw }),
        config,
        { privateKey: env.STAGING_GITHUB_PRIVATE_KEY },
        initial.projection.observedAt + 30_000,
        async () => {
          const fresh = await authority(env, config.installationId);
          await verifySubmission(input.token, input.origin, input.binding, raw, fresh);
        }
      );
    } catch {
      return refused();
    }
  },
} satisfies ExportedHandler<StagingGithubEnv>;
export class GithubWebhook extends WorkerEntrypoint<StagingGithubEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== '/github/staging/webhook') reject();
      const config = configured(this.env);
      if (!(await verifyGitHubUninstall(request, config, this.env.STAGING_GITHUB_WEBHOOK_SECRET)))
        reject();
      return await admitVerifiedUninstall(this.env, config);
    } catch {
      return Response.json({ error: 'managed_webhook_rejected' }, { status: 403 });
    }
  }
}
