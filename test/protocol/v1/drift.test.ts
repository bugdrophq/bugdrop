import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('detects changed upstream bytes rather than silently accepting fixture drift', () => {
  const sdk = mkdtempSync(join(tmpdir(), 'bugdrop-protocol-sdk-'));
  const destination = join(sdk, 'packages/contracts/fixtures');
  mkdirSync(destination, { recursive: true });
  cpSync('test/protocol/v1/fixtures', destination, { recursive: true });
  const check = () =>
    execFileSync(process.execPath, ['scripts/protocol/check-fixture-drift.mjs', sdk], {
      stdio: 'pipe',
    });
  try {
    expect(check).not.toThrow();
    const fixture = join(destination, 'origin.v1.json');
    writeFileSync(fixture, `${readFileSync(fixture, 'utf8')}\n`);
    expect(check).toThrow();
    rmSync(fixture);
    expect(check).toThrow();
  } finally {
    rmSync(sdk, { recursive: true, force: true });
  }
});
