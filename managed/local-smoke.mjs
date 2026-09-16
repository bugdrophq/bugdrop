// Uses Miniflare bundled with the repository's pinned Wrangler dependency.
import { Miniflare } from 'miniflare';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const roles = ['ingress', 'delivery', 'consumer'];
const output = mkdtempSync(join(tmpdir(), 'bugdrop-managed-smoke-'));
let runtime;
try {
  const workers = roles.map(role => {
    const configPath = `managed/${role}.json`;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const outdir = join(output, role);
    execFileSync(
      'node_modules/.bin/wrangler',
      ['deploy', '-c', configPath, '--dry-run', '--outdir', outdir],
      { stdio: 'pipe' }
    );
    return {
      name: config.name,
      modules: true,
      modulesRoot: outdir,
      scriptPath: join(outdir, `${role}.js`),
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      bindings: config.vars,
      kvNamespaces: Object.fromEntries((config.kv_namespaces ?? []).map(b => [b.binding, b.id])),
      durableObjects: Object.fromEntries(
        (config.durable_objects?.bindings ?? []).map(b => [
          b.name,
          { className: b.class_name, useSQLite: true },
        ])
      ),
      serviceBindings: Object.fromEntries((config.services ?? []).map(b => [b.binding, b.service])),
      queueProducers: Object.fromEntries(
        (config.queues?.producers ?? []).map(b => [b.binding, b.queue])
      ),
      queueConsumers: Object.fromEntries(
        (config.queues?.consumers ?? []).map(b => [
          b.queue,
          {
            maxRetries: b.max_retries,
            deadLetterQueue: b.dead_letter_queue,
          },
        ])
      ),
    };
  });
  runtime = new Miniflare({ host: 'bugdrop-managed.localhost', workers });
  for (const role of ['ingress', 'delivery']) {
    const worker = await runtime.getWorker(`bugdrop-managed-local-${role}`);
    const health = await worker.fetch('http://bugdrop-managed.localhost/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      stage: 'local-scaffold',
      ready: false,
      bindingsPresent: true,
    });
    const refused = await worker.fetch('http://bugdrop-managed.localhost/feedback', {
      method: 'POST',
      body: 'PRIVATE-CANARY',
    });
    assert.equal(refused.status, 503);
    const bindings = await runtime.getBindings(`bugdrop-managed-local-${role}`);
    const namespace = bindings[role === 'ingress' ? 'MANAGED_AUTHORIZATION' : 'MANAGED_RECEIPTS'];
    const coordinator = namespace.get(namespace.idFromName('local-proof'));
    assert.equal(
      (await coordinator.fetch('http://bugdrop-managed.localhost/authorize')).status,
      503
    );
    if (role === 'ingress') {
      const boundDelivery = await bindings.MANAGED_DELIVERY.fetch(
        'http://bugdrop-managed.localhost/health'
      );
      assert.equal(boundDelivery.status, 200);
      assert.equal((await boundDelivery.json()).ready, false);
    }
    console.log(`${role}: workerd health, refusal and SQLite DO refusal passed`);
  }
  const consumer = await runtime.getWorker('bugdrop-managed-local-consumer');
  await assert.rejects(
    () => consumer.fetch('http://bugdrop-managed.localhost/health'),
    /Handler does not export a fetch\(\) function/
  );
  console.log('consumer: no HTTP handler confirmed (expected runtime error above)');
} finally {
  await runtime?.dispose();
  rmSync(output, { recursive: true, force: true });
}
