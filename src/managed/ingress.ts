import type { ManagedIngressEnv } from './ingress-env';
import { health, unavailable } from './closed';

/** Reserved strongly consistent revocation coordinator; no authorization state is trusted yet. */
export class ManagedAuthorization {
  async fetch(): Promise<Response> {
    return unavailable();
  }
}

export default {
  async fetch(request: Request, env: ManagedIngressEnv): Promise<Response> {
    return health(
      request,
      env.MANAGED_STAGE === 'local-scaffold' &&
        typeof env.MANAGED_CONFIG?.get === 'function' &&
        typeof env.MANAGED_AUTHORIZATION?.get === 'function' &&
        typeof env.MANAGED_DELIVERY?.fetch === 'function'
    );
  },
} satisfies ExportedHandler<ManagedIngressEnv>;
