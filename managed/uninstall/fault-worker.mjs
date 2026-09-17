// Local-only test entrypoint; never referenced by a deployment manifest.
import { StagingUninstall } from '../../src/managed/uninstall/coordinator.ts';
export { GithubWebhook } from '../../src/managed/staging/github.ts';
export { UninstallControl } from '../../src/managed/uninstall/control.ts';
export class TestUninstall extends StagingUninstall {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = new Proxy(ctx.storage, {
      get(target, property) {
        if (property === 'sync')
          return async () => {
            const action = await (
              await env.TEST_UNINSTALL_SYNC.fetch('http://fault.bugdrop.localhost/sync')
            ).text();
            if (action === 'sync-failure') throw new Error('injected_uninstall_sync_failure');
            await target.sync();
            if (action === 'crash') ctx.abort('injected_uninstall_post_sync_crash');
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
  now() {
    return Number(this.env.FIXTURE_NOW);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/_test/alarm') {
      await this.alarm();
      return new Response('ok');
    }
    if (path === '/_test/storage')
      return Response.json({
        work: this.ctx.storage.sql.exec('SELECT * FROM uninstall_work').toArray(),
        fence: this.ctx.storage.sql.exec('SELECT * FROM uninstall_fence').toArray(),
      });
    return super.fetch(request);
  }
}
export default {
  fetch(request, env) {
    return env.STAGING_UNINSTALLS.get(
      env.STAGING_UNINSTALLS.idFromName(env.FIXTURE_OBJECT_NAME)
    ).fetch(request);
  },
};
