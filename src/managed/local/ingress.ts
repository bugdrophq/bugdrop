import type { LocalIngressEnv } from './ingress-env';
import { authenticate, loadAuthority } from './authority';
import { issue, verifySubmission } from './capability';
import { bytes, exchange, json, readBounded } from './protocol';
import { response } from './outcome';
import { submission } from './submission';

export default {
  async fetch(request: Request, env: LocalIngressEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method !== 'POST' ||
      !['/v1/submission-capabilities', '/_local/submit'].includes(path)
    )
      return response('rejected');
    try {
      const a = await loadAuthority(env.LOCAL_AUTHORITY);
      const body = json(await readBounded(request));
      if (path === '/v1/submission-capabilities') {
        await authenticate(request.headers.get('Authorization'), a);
        const bound = exchange(request.headers, body, a.projection.origin);
        const capability = await issue(bound, a);
        // Narrow fixed evidence only; never forward headers, credentials or submission metadata.
        await env.LOCAL_EVIDENCE.fetch('http://evidence.bugdrop.localhost/sdk', {
          method: 'POST',
          body: '0.1.0',
        });
        return Response.json(capability, { headers: { 'Cache-Control': 'no-store' } });
      }
      const input = submission(body);
      await verifySubmission(input.token, input.origin, input.binding, bytes(input.body), a);
      return await env.LOCAL_DELIVERY.fetch('http://delivery.bugdrop.localhost/_local/submit', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch {
      if (path === '/v1/submission-capabilities')
        return Response.json(
          { error: 'managed_request_rejected' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } }
        );
      return response('rejected');
    }
  },
} satisfies ExportedHandler<LocalIngressEnv>;
