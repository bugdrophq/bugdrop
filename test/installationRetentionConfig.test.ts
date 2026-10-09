import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('installation retention configuration', () => {
  it('binds isolated storage, the first-party route, and daily cleanup triggers', () => {
    const config = readFileSync('wrangler.toml', 'utf8');

    expect(config.match(/binding = "INSTALLATION_ANALYTICS"/g)).toHaveLength(3);
    expect(config.match(/crons = \["17 3 \* \* \*"\]/g)).toHaveLength(2);
    expect(config.match(/bugdrop\.dev\/api\/github\/webhook\*/g)).toHaveLength(2);
    expect(config.indexOf('routes = [')).toBeLessThan(config.indexOf('[triggers]'));
    expect(config).toContain('id = "a567f723a2eb4cfab807b0c1d678dc76"');
    expect(config).toContain('id = "c58b33f6a0dc416b8661661ce0d23f7f"');
  });

  it('enables per-installation usage counting only in production', () => {
    const config = readFileSync('wrangler.toml', 'utf8');
    const productionVars = config.split('[env.production.vars]')[1]?.split('\n[')[0];

    expect(config.match(/INSTALLATION_USAGE_ENABLED = "true"/g)).toHaveLength(1);
    expect(productionVars).toContain('INSTALLATION_USAGE_ENABLED = "true"');
  });

  it('documents installation usage collection before enabling it', () => {
    const policy = readFileSync('PRIVACY.md', 'utf8');

    expect(policy).toContain('best-effort, unrounded per-installation count');
    expect(policy).toContain('each installation feedback counter retain up to 1,024');
    expect(policy).toContain('deletion guard derived from the GitHub App installation');
    expect(policy).not.toContain('does not currently retain per-installation feedback counts');
  });
});
