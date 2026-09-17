import { WorkerEntrypoint } from 'cloudflare:workers';
import type { StagingDeliveryEnv } from './delivery-env';
import type { DeliveryBindings } from '../local/delivery';
import localDelivery from '../local/delivery';
import { LocalManagedReceipt } from '../local/receipt';
import { response } from '../local/outcome';
const adapted = (env: StagingDeliveryEnv): DeliveryBindings => ({
  LOCAL_AUTHORITY: env.STAGING_AUTHORITY,
  LOCAL_FAKE_GITHUB: env.STAGING_GITHUB,
  LOCAL_RECEIPTS: env.STAGING_RECEIPTS,
});
export class StagingReceipt extends LocalManagedReceipt {
  protected deliveryTimeoutMs = 11_000;
  constructor(
    ctx: DurableObjectState,
    private stagingEnv: StagingDeliveryEnv
  ) {
    super(ctx, adapted(stagingEnv));
  }
  async fetch(request: Request): Promise<Response> {
    if (
      this.stagingEnv.ENVIRONMENT !== 'staging' ||
      this.stagingEnv.STAGING_ENABLED !== 'true' ||
      this.stagingEnv.STAGING_DELIVERY_ENABLED !== 'true'
    )
      return response('rejected');
    return super.fetch(request);
  }
}
export class StagingDelivery extends WorkerEntrypoint<StagingDeliveryEnv> {
  async fetch(request: Request): Promise<Response> {
    if (
      this.env.ENVIRONMENT !== 'staging' ||
      this.env.STAGING_ENABLED !== 'true' ||
      this.env.STAGING_DELIVERY_ENABLED !== 'true'
    )
      return response('rejected');
    return localDelivery.fetch(request, adapted(this.env));
  }
}
export default { fetch: () => response('rejected') };
