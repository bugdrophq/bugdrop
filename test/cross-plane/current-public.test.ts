import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import baseline from './fixtures/current-public-baseline.v2.json';

function isPublicPath(path: string): boolean {
  return (
    (path.startsWith('src/') && !path.startsWith('src/managed/')) ||
    path.startsWith('public/') ||
    ['wrangler.toml', 'scripts/build-widget.js', 'tsconfig.widget.json'].includes(path)
  );
}

function publicFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(isPublicPath)
    .sort();
}

function publicFilesAt(commit: string): string[] {
  return execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', commit], { encoding: 'utf8' })
    .split('\0')
    .filter(isPublicPath)
    .sort();
}

function fingerprint(paths: string[], read: (path: string) => Uint8Array): string {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(read(path)).update('\0');
  return hash.digest('hex');
}

describe('current public plane remains unchanged through managed integration', () => {
  it('pins the reviewed v2 baseline to the exact feature commit public tree', () => {
    expect(baseline.baseCommit).toBe('6b9ec9a4100a4351b143451b4a211b7067f3fb9e');
    const paths = publicFilesAt(baseline.baseCommit);
    expect(paths).toContain('src/widget/locales/zh-CN.ts');
    expect(paths.length).toBe(baseline.fileCount);
    expect(
      fingerprint(paths, path => execFileSync('git', ['show', `${baseline.baseCommit}:${path}`]))
    ).toBe(baseline.sha256);
  });

  it('matches the reviewed tracked runtime, assets and configuration byte for byte', () => {
    const paths = publicFiles();
    expect(paths).toContain('src/widget/locales/zh-CN.ts');
    expect(paths.length).toBe(baseline.fileCount);
    expect(fingerprint(paths, readFileSync)).toBe(baseline.sha256);
  });

  it.each([
    'src/index.ts',
    'wrangler.toml',
    'scripts/build-widget.js',
    'src/widget/locales/zh-CN.ts',
  ])('detects a public boundary mutation in %s', target => {
    const hash = fingerprint(publicFiles(), path => {
      const bytes = readFileSync(path);
      return path === target ? Buffer.concat([bytes, Buffer.from('\nMANAGED_MUTATION')]) : bytes;
    });
    expect(hash).not.toBe(baseline.sha256);
  });
});
