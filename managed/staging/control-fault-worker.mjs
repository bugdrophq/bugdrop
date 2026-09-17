// Test-only Worker entrypoint. No manifest references this fault-injection wrapper.
import * as base from '../../src/managed/staging/authority.ts';
export {
  IssuerAuthority,
  DeliveryAuthority,
  StagingControl,
} from '../../src/managed/staging/authority.ts';
export default base.default;
export class StagingAuthorization extends base.StagingAuthorization {
  constructor(ctx, env) {
    super(ctx, env);
    let rollback = env.STAGING_TEST_ROLLBACK === 'true';
    const sql = new Proxy(ctx.storage.sql, {
      get(target, property) {
        if (property === 'exec')
          return (query, ...args) => {
            if (rollback && query.startsWith('INSERT OR REPLACE INTO control_receipt')) {
              rollback = false;
              throw new Error('injected_receipt_write_failure');
            }
            return target.exec(query, ...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const storage = new Proxy(ctx.storage, {
      get(target, property) {
        if (property === 'sql') return sql;
        if (property === 'sync')
          return async () => {
            const action = await (
              await env.TEST_CONTROL_SYNC.fetch('http://fault.bugdrop.localhost/sync')
            ).text();
            if (action === 'sync-failure') throw new Error('injected_sync_failure');
            await target.sync();
            if (action === 'crash') ctx.abort('injected_post_sync_crash');
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(this, 'ctx', {
      value: new Proxy(ctx, {
        get(target, property) {
          if (property === 'storage') return storage;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
  }
}
