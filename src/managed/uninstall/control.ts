import { WorkerEntrypoint } from 'cloudflare:workers';
import type { StagingGithubEnv } from '../staging/github-env';
import { stagingConfig } from '../github-staging/config';
import { json, readBounded, reject, utf8 } from '../local/protocol';
import { commitments } from './contracts';

/** Private service entrypoint only; public GitHub and ingress handlers never route here. */
export class UninstallControl extends WorkerEntrypoint<StagingGithubEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      if (
        this.env.ENVIRONMENT !== 'staging' ||
        this.env.STAGING_ENABLED !== 'true' ||
        request.method !== 'POST' ||
        !['/status', '/resume', '/continue'].includes(new URL(request.url).pathname)
      )
        reject();
      const config = stagingConfig(json(utf8(this.env.STAGING_GITHUB_TARGET_JSON)));
      const scoped = await commitments(
        this.env.STAGING_UNINSTALL_COMMITMENT_KEY,
        config.appId,
        config.installationId
      );
      const body = await readBounded(request, 512);
      // The DO authenticates the original bytes and path before status or resume.
      return await this.env.STAGING_UNINSTALLS.get(
        this.env.STAGING_UNINSTALLS.idFromName(scoped.installationHash)
      ).fetch(new Request(request, { body }));
    } catch {
      return Response.json({ error: 'uninstall_request_rejected' }, { status: 503 });
    }
  }
}
