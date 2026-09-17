import type { LocalDeliveryEnv } from './delivery-env';
import { loadAuthority } from './authority';
import { verifySubmission } from './capability';
import { bytes, hmac, json, readBounded, utf8 } from './protocol';
import { response } from './outcome';
import { submission } from './submission';
export { LocalManagedReceipt } from './receipt';
export type DeliveryBindings = Omit<LocalDeliveryEnv, 'LOCAL_RECEIPTS'> & {
  LOCAL_RECEIPTS: Pick<DurableObjectNamespace, 'idFromName'> & {
    get(id: DurableObjectId): Pick<DurableObjectStub, 'fetch'>;
  };
};

export default {
  async fetch(request: Request, env: DeliveryBindings): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/_local/submit')
      return response('rejected');
    let dispatched = false;
    try {
      const input = submission(json(await readBounded(request)));
      const authority = await loadAuthority(env.LOCAL_AUTHORITY);
      const claims = await verifySubmission(
        input.token,
        input.origin,
        input.binding,
        bytes(input.body),
        authority
      );
      const key = await hmac(
        authority.receiptKey,
        utf8(JSON.stringify([claims.applicationId, claims.submissionId]))
      );
      const stub = env.LOCAL_RECEIPTS.get(env.LOCAL_RECEIPTS.idFromName(key));
      dispatched = true;
      return await stub.fetch('http://receipt.bugdrop.localhost/deliver', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch {
      return response(dispatched ? 'indeterminate' : 'rejected');
    }
  },
} satisfies ExportedHandler<LocalDeliveryEnv>;
