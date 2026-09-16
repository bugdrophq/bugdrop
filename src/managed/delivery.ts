import type { ManagedDeliveryEnv } from './delivery-env';
import { health, unavailable } from './closed';

/** Reserved 30-day at-most-once receipt coordinator; no receipt can authorize delivery yet. */
export class ManagedReceipts {
  async fetch(): Promise<Response> {
    return unavailable();
  }
}

export default {
  async fetch(request: Request, env: ManagedDeliveryEnv): Promise<Response> {
    return health(
      request,
      env.MANAGED_STAGE === 'local-scaffold' &&
        typeof env.MANAGED_RECEIPTS?.get === 'function' &&
        typeof env.MANAGED_OUTCOMES?.send === 'function'
    );
  },
} satisfies ExportedHandler<ManagedDeliveryEnv>;
