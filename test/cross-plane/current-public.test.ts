import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import baseline from './fixtures/current-public-baseline.v2.json';

function publicFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(
      path =>
        (path.startsWith('src/') && !path.startsWith('src/managed/')) ||
        path.startsWith('public/') ||
        ['wrangler.toml', 'scripts/build-widget.js', 'tsconfig.widget.json'].includes(path)
    )
    .sort();
}

function fingerprint(paths: string[], read: (path: string) => Uint8Array): string {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(read(path)).update('\0');
  return hash.digest('hex');
}

describe('current public plane matches the reviewed admin-read baseline', () => {
  it('matches the reviewed tracked runtime, assets and configuration byte for byte', () => {
    const paths = publicFiles();
    expect(paths.length).toBe(baseline.fileCount);
    expect(fingerprint(paths, readFileSync)).toBe(baseline.sha256);
  });

  it.each(['src/index.ts', 'wrangler.toml', 'scripts/build-widget.js'])(
    'detects a public boundary mutation in %s',
    target => {
      const hash = fingerprint(publicFiles(), path => {
        const bytes = readFileSync(path);
        return path === target ? Buffer.concat([bytes, Buffer.from('\nMANAGED_MUTATION')]) : bytes;
      });
      expect(hash).not.toBe(baseline.sha256);
    }
  );
});
