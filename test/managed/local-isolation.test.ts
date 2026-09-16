import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const config = (role: string) => JSON.parse(readFileSync(`managed/local/${role}.json`, 'utf8'));
const publicConfig = readFileSync('wrangler.toml', 'utf8');
describe('local-only implementation authority', () => {
  it.each(['ingress', 'delivery'])('limits %s to dedicated, unrouted local bindings', role => {
    const c = config(role);
    expect(c.account_id).toBe('STAGE_0_LOCAL_ONLY_NO_ACCOUNT');
    expect(c.name).toBe(`bugdrop-managed-harness-${role}`);
    expect(c.workers_dev).toBe(false);
    expect(c.preview_urls).toBe(false);
    expect(c.routes).toEqual([]);
    expect(c.observability).toEqual({ enabled: false });
    expect(Object.keys(c).sort()).toEqual(
      [
        '$schema',
        'name',
        'main',
        'account_id',
        'compatibility_date',
        'compatibility_flags',
        'workers_dev',
        'preview_urls',
        'routes',
        'observability',
        'services',
        ...(role === 'delivery' ? ['durable_objects', 'migrations'] : []),
      ].sort()
    );
    const expected =
      role === 'ingress'
        ? { LOCAL_AUTHORITY: 'authority', LOCAL_DELIVERY: 'delivery', LOCAL_EVIDENCE: 'evidence' }
        : { LOCAL_AUTHORITY: 'authority', LOCAL_FAKE_GITHUB: 'fake-github' };
    expect(c.services).toEqual(
      Object.entries(expected).map(([binding, suffix]) => ({
        binding,
        service: `bugdrop-managed-harness-${suffix}`,
      }))
    );
    if (role === 'delivery') {
      expect(c.durable_objects).toEqual({
        bindings: [{ name: 'LOCAL_RECEIPTS', class_name: 'LocalManagedReceipt' }],
      });
      expect(c.migrations).toEqual([
        { tag: 'local-harness-v1', new_sqlite_classes: ['LocalManagedReceipt'] },
      ]);
    }
    for (const match of publicConfig.matchAll(/"([a-f0-9]{32})"/g))
      expect(JSON.stringify(c)).not.toContain(match[1]);
    expect(publicConfig).not.toContain(c.name);
  });
});
