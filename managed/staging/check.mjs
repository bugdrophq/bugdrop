import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const directory = mkdtempSync(join(tmpdir(), 'bugdrop-staging-dry-'));
try {
  for (const role of ['authority', 'ingress', 'delivery', 'github', 'reconciliation']) {
    const path = `managed/staging/${role}.json`;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const staging = config.env.staging;
    assert.equal(config.account_id, 'STAGING_ACCOUNT_NOT_APPROVED');
    assert.equal(
      staging.account_id,
      role === 'reconciliation' ? '341a3846c29902f6363c151395932f5a' : 'STAGING_ACCOUNT_NOT_APPROVED'
    );
    assert.equal(staging.name, `bugdrop-managed-${role}-staging`);
    assert.equal(staging.vars.STAGING_ENABLED, 'false');
    assert.equal(staging.workers_dev, false);
    assert.equal(staging.preview_urls, false);
    assert.deepEqual(staging.routes, []);
    execFileSync(
      'node_modules/.bin/wrangler',
      [
        'deploy',
        '--dry-run',
        '--env',
        'staging',
        '--config',
        path,
        '--outdir',
        join(directory, role),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CI: 'true',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_LOG_LEVEL: 'error',
        },
        stdio: 'pipe',
      }
    );
    console.log(`Staging ${role}: isolated dry run passed`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
