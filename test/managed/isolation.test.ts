import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const roles = ['ingress', 'delivery', 'consumer'] as const;
const configs = roles.map(role => JSON.parse(readFileSync(`managed/${role}.json`, 'utf8')));
const publicConfig = readFileSync('wrangler.toml', 'utf8');
const publicValues = [...publicConfig.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);

// This deliberately closed allowlist makes new authority require an explicit test change.
function assertIsolation(candidates: typeof configs): void {
  candidates.forEach((config, index) => {
    const role = roles[index];
    const base = {
      $schema: '../node_modules/wrangler/config-schema.json',
      name: `bugdrop-managed-local-${role}`,
      main: `../src/managed/${role}.ts`,
      account_id: 'STAGE_0_LOCAL_ONLY_NO_ACCOUNT',
      compatibility_date: '2026-06-10',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      routes: [],
      vars: { MANAGED_STAGE: 'local-scaffold' },
      observability: { enabled: false },
    };
    const state = (name: string, className: string) => ({
      durable_objects: { bindings: [{ name, class_name: className }] },
      migrations: [{ tag: 'managed-local-v1', new_sqlite_classes: [className] }],
    });
    const resources = {
      ingress: {
        services: [{ binding: 'MANAGED_DELIVERY', service: 'bugdrop-managed-local-delivery' }],
        kv_namespaces: [
          { binding: 'MANAGED_CONFIG', id: 'local-only-managed-config', remote: false },
        ],
        ...state('MANAGED_AUTHORIZATION', 'ManagedAuthorization'),
      },
      delivery: {
        queues: {
          producers: [{ binding: 'MANAGED_OUTCOMES', queue: 'bugdrop-managed-local-outcomes' }],
        },
        ...state('MANAGED_RECEIPTS', 'ManagedReceipts'),
      },
      consumer: {
        queues: {
          consumers: [
            {
              queue: 'bugdrop-managed-local-outcomes',
              dead_letter_queue: 'bugdrop-managed-local-outcomes-dlq',
              max_retries: 3,
              max_batch_size: 10,
              retry_delay: 60,
            },
          ],
        },
      },
    };
    expect(config).toEqual({ ...base, ...resources[role] });
    // Compare resource-bearing fields against every current-public environment, not just prod.
    const resourceText = JSON.stringify(resources[role]);
    for (const value of publicValues.filter(value => value.length > 5)) {
      expect(resourceText).not.toContain(JSON.stringify(value));
    }
  });
  // A new public-to-managed binding would cross the boundary even if managed stayed unchanged.
  expect(publicConfig).not.toMatch(
    /MANAGED_|bugdrop-managed-|ManagedAuthorization|ManagedReceipts/
  );
}

describe('Stage 0 resource isolation', () => {
  it('has no public resource, secret, route, remote binding, or deployable account', () => {
    assertIsolation(configs);
  });

  it.each(publicValues.filter(value => /^[a-f0-9]{32}$/.test(value)))(
    'rejects aliasing public namespace %s',
    id => {
      const candidate = structuredClone(configs);
      candidate[0].kv_namespaces[0].id = id;
      expect(() => assertIsolation(candidate)).toThrow();
    }
  );

  it.each([
    ['public service', (c: typeof configs) => (c[0].services[0].service = 'bugdrop')],
    [
      'external DO',
      (c: typeof configs) => (c[1].durable_objects.bindings[0].script_name = 'bugdrop'),
    ],
    [
      'public DO class',
      (c: typeof configs) => (c[1].durable_objects.bindings[0].class_name = 'FeedbackCounter'),
    ],
    ['public secret', (c: typeof configs) => (c[0].vars.GITHUB_PRIVATE_KEY = 'canary')],
    ['public route', (c: typeof configs) => (c[0].routes = [{ pattern: 'bugdrop.dev/*' }])],
    ['workers.dev', (c: typeof configs) => (c[1].workers_dev = true)],
    ['preview URL', (c: typeof configs) => (c[1].preview_urls = true)],
    ['remote KV', (c: typeof configs) => (c[0].kv_namespaces[0].remote = true)],
    ['account authority', (c: typeof configs) => (c[0].account_id = 'a'.repeat(32))],
    ['environment override', (c: typeof configs) => (c[0].env = { production: {} })],
    [
      'unexpected binding',
      (c: typeof configs) => (c[2].hyperdrive = [{ binding: 'DB', id: 'a'.repeat(32) }]),
    ],
    ['queue alias', (c: typeof configs) => (c[2].queues.consumers[0].queue = 'public-outcomes')],
    ['missing DLQ', (c: typeof configs) => delete c[2].queues.consumers[0].dead_letter_queue],
  ])('rejects %s', (_label, mutate) => {
    const candidate = structuredClone(configs);
    mutate(candidate);
    expect(() => assertIsolation(candidate)).toThrow();
  });
});
