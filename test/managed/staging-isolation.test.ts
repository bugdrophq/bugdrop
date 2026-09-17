import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const roles = ['authority', 'ingress', 'delivery', 'github'];
describe('unapproved staging remains isolated and closed', () => {
  it.each(roles)('%s has no default/public exposure or inherited production authority', role => {
    const c = JSON.parse(readFileSync(`managed/staging/${role}.json`, 'utf8'));
    const s = c.env.staging;
    expect(Object.keys(c.env)).toEqual(['staging']);
    for (const config of [c, s]) {
      expect(config.account_id).toBe('STAGING_ACCOUNT_NOT_APPROVED');
      expect(config.routes).toEqual([]);
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      for (const forbidden of [
        'kv_namespaces',
        'd1_databases',
        'r2_buckets',
        'hyperdrive',
        'queues',
        'analytics_engine_datasets',
        'tail_consumers',
      ])
        expect(config).not.toHaveProperty(forbidden);
    }
    expect(c.observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
      traces: { enabled: false },
    });
    expect(s.name).toBe(`bugdrop-managed-${role}-staging`);
    expect(s.vars.STAGING_ENABLED).toBe('false');
    for (const binding of s.services ?? [])
      expect(binding.service).toMatch(
        /^bugdrop-managed-(authority|ingress|delivery|github)-staging$/
      );
    for (const binding of s.durable_objects?.bindings ?? [])
      expect(binding.class_name).toMatch(/^Staging(Authorization|Receipt)$/);
    const publicConfig = readFileSync('wrangler.toml', 'utf8');
    expect(publicConfig).not.toContain(s.name);
    for (const id of publicConfig.matchAll(/"([a-f0-9]{32})"/g))
      expect(JSON.stringify(c)).not.toContain(id[1]);
  });
});
