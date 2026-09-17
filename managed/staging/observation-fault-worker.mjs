// Test-only controls, absent from deployment manifests.
import * as base from '../../src/managed/staging/authority.ts';
import { Observation } from '../../src/managed/staging/observation.ts';
export {
  IssuerAuthority,
  DeliveryAuthority,
  StagingControl,
  StagingObservation,
} from '../../src/managed/staging/authority.ts';
export class StagingAuthorization extends base.StagingAuthorization {
  constructor(ctx, env) {
    super(ctx, env);
    this.testTime = Date.now();
    this.failure = '';
    const storage = new Proxy(ctx.storage, {
      get: (target, name) => {
        if (name === 'sync')
          return async () => {
            if (this.failure === 'sync') {
              this.failure = '';
              throw new Error('test_sync_failure');
            }
            await target.sync();
          };
        if (name === 'transactionSync')
          return fn =>
            target.transactionSync(() => {
              fn();
              if (this.failure === 'write') {
                this.failure = '';
                throw new Error('test_write_failure');
              }
            });
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.observation = new Observation(storage, () => this.testTime);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/_test/observation') {
      const body = await request.json();
      if (body.advance) this.testTime += body.advance;
      if (body.failure) this.failure = body.failure;
      if (body.applicationId) this.env.STAGING_APPLICATION_ID = body.applicationId;
      if (body.alarm) await this.alarm();
      return Response.json({
        observation: this.ctx.storage.sql.exec('SELECT * FROM staging_observation').toArray(),
        revocation: this.ctx.storage.sql.exec('SELECT * FROM revocation').toArray(),
      });
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request, env) {
    return env.STAGING_AUTHORIZATIONS.get(
      env.STAGING_AUTHORIZATIONS.idFromName(env.STAGING_APPLICATION_ID)
    ).fetch(request);
  },
};
