import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import './build.mjs';

const sdkRoot = process.env.BUGDROP_MANAGED_SDK_ROOT;
if (!sdkRoot) throw new Error('Set BUGDROP_MANAGED_SDK_ROOT to a built SDK checkout.');
const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'packages/browser/package.json')));
assert.equal(manifest.name, '@bugdrop/browser');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'bugdrop-managed-consumer-')));
try {
  const packed = execFileSync(
    'npm',
    [
      'pack',
      '--workspace=@bugdrop/browser',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      directory,
    ],
    { cwd: resolve(sdkRoot), encoding: 'utf8' }
  );
  const tarball = join(directory, JSON.parse(packed)[0].filename);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    { cwd: directory, stdio: 'pipe' }
  );
  const require = createRequire(join(directory, 'package.json'));
  const entry = await realpath(require.resolve('@bugdrop/browser'));
  assert.ok(entry.startsWith(join(directory, 'node_modules') + '/'));
  assert.ok(entry.includes('/dist/'));
  await build({
    stdin: {
      contents: "import { BugDrop } from '@bugdrop/browser'; window.PackedBugDrop = BugDrop;",
      resolveDir: directory,
    },
    outfile: 'dist/managed-widget/packed-sdk.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
  console.log(`Prepared isolated packed @bugdrop/browser ${manifest.version} consumer.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
