// Local-only test entrypoint; never referenced by a deployment manifest.
import { StagingUninstall } from '../../src/managed/uninstall/coordinator.ts';
export { GithubWebhook } from '../../src/managed/staging/github.ts';
export { UninstallControl } from '../../src/managed/uninstall/control.ts';
export class TestUninstall extends StagingUninstall {
  constructor(ctx, env) {
    super(ctx, env);
    this.transportTrace = [];
    for (const [side, name] of [
      ['edge', 'STAGING_CONTROL'],
      ['sql', 'STAGING_RECONCILIATION'],
      ['recovery', 'STAGING_UNINSTALL_RECOVERY'],
    ]) {
      const original = env[name];
      if (!original) continue;
      env[name] = {
        fetch: async request => {
          const event = { side, startedAt: Date.now(), finishedAt: null, status: null };
          this.transportTrace.push(event);
          try {
            const response = await original.fetch(request);
            event.status = response.status;
            return response;
          } finally {
            event.finishedAt = Date.now();
          }
        },
      };
    }
    const fixture = this;
    const storage = new Proxy(ctx.storage, {
      get(target, property) {
        if (property === 'transactionSync')
          return callback =>
            target.transactionSync(() => {
              const result = callback();
              if (fixture.failTransaction) {
                fixture.failTransaction = false;
                throw new Error('injected_uninstall_transaction_failure');
              }
              return result;
            });
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
    return this.testNow ?? Number(this.env.FIXTURE_NOW);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/_test/trace') return Response.json(this.transportTrace);
    if (path === '/_test/prewarm') {
      await Promise.all(
        ['STAGING_CONTROL', 'STAGING_RECONCILIATION', 'STAGING_UNINSTALL_RECOVERY']
          .filter(name => this.env[name])
          .map(name =>
            this.env[name].fetch('http://uninstall.bugdrop.localhost/_test/warm-binding')
          )
      );
      return new Response('warm');
    }
    if (path === '/_test/settled') {
      await this.running;
      await this.ctx.storage.sync();
      return new Response('settled');
    }
    if (path === '/_test/scope') {
      const body = await request.json();
      this.env.STAGING_GITHUB_TARGET_JSON = JSON.stringify(body.config);
      this.env.STAGING_APPLICATION_ID = body.applicationId;
      return new Response('ok');
    }
    if (path === '/_test/fail-transaction') {
      this.failTransaction = true;
      return new Response('ok');
    }
    if (path === '/_test/clock') {
      this.testNow = Number(await request.text());
      return new Response('ok');
    }
    if (path === '/_test/delete-alarm') {
      await this.ctx.storage.deleteAlarm();
      return new Response('ok');
    }
    if (path === '/_test/alarm-time') return Response.json(await this.ctx.storage.getAlarm());
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
