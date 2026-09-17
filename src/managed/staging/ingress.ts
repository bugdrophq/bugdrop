import { WorkerEntrypoint } from 'cloudflare:workers';
import type { StagingIngressEnv } from './ingress-env';
import { authenticate, loadAuthority } from '../local/authority';
import { issue, verifySubmission } from '../local/capability';
import { bytes, exchange, json, readBounded } from '../local/protocol';
import { response } from '../local/outcome';
import { submission } from '../local/submission';
const enabled = (env: StagingIngressEnv) =>
  env.ENVIRONMENT === 'staging' && env.STAGING_ENABLED === 'true';
export default {
  async fetch(request: Request, env: StagingIngressEnv): Promise<Response> {
    try {
      if (
        !enabled(env) ||
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/v1/submission-capabilities'
      )
        throw new Error('rejected');
      const body = json(await readBounded(request));
      const authority = await loadAuthority(env.STAGING_AUTHORITY);
      await authenticate(request.headers.get('Authorization'), authority);
      const bound = exchange(request.headers, body, authority.projection.origin);
      return Response.json(await issue(bound, authority), {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return Response.json(
        { error: 'managed_request_rejected' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  },
} satisfies ExportedHandler<StagingIngressEnv>;
// This entrypoint exists only on explicitly configured private service bindings.
export class StagingSubmission extends WorkerEntrypoint<StagingIngressEnv> {
  async fetch(request: Request): Promise<Response> {
    let dispatched = false;
    try {
      if (
        !enabled(this.env) ||
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/submit'
      )
        return response('rejected');
      const input = submission(json(await readBounded(request)));
      const authority = await loadAuthority(this.env.STAGING_AUTHORITY);
      await verifySubmission(
        input.token,
        input.origin,
        input.binding,
        bytes(input.body),
        authority
      );
      dispatched = true;
      return await this.env.STAGING_DELIVERY.fetch(
        'http://delivery.bugdrop.localhost/_local/submit',
        { method: 'POST', body: JSON.stringify(input) }
      );
    } catch {
      return response(dispatched ? 'indeterminate' : 'rejected');
    }
  }
}
