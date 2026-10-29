import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import baseline from './fixtures/current-public-baseline.v2.json';
import mobileBaseline from './fixtures/current-public-baseline.v3.json';
import deferredBaseline from './fixtures/current-public-baseline.v4.json';
import current from './fixtures/current-public-baseline.v5.json';
import accessible from './fixtures/current-public-baseline.v6.json';
import flowCapture from './fixtures/current-public-baseline.v7.json';
import acquisition from './fixtures/current-public-baseline.v8.json';
import productionCanary from './fixtures/current-public-baseline.v9.json';
import totals from './fixtures/current-public-baseline.v10.json';
import thumbnails from './fixtures/current-public-baseline.v11.json';

function isPublicPath(path: string): boolean {
  return (
    (path.startsWith('src/') &&
      !path.startsWith('src/managed/') &&
      !path.startsWith('src/widget/managed/')) ||
    path.startsWith('public/') ||
    ['wrangler.toml', 'scripts/build-widget.js', 'tsconfig.widget.json'].includes(path)
  );
}

function publicFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
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

describe('legacy public plane preserves its explicit compatibility boundary', () => {
  it('pins the reviewed v2 baseline to the exact merged public tree', () => {
    expect(baseline.baseCommit).toBe('73bb9db0a9ad69a508007bb39c5f23f174c338ef');
    const paths = publicFilesAt(baseline.baseCommit);
    expect(paths).toContain('src/widget/locales/zh-CN.ts');
    expect(paths.length).toBe(baseline.fileCount);
    expect(
      fingerprint(paths, path => execFileSync('git', ['show', `${baseline.baseCommit}:${path}`]))
    ).toBe(baseline.sha256);
  }, 30_000);

  it('pins the reviewed v3 mobile annotation baseline to PR #424', () => {
    const commit = 'fb0c3e34a012c7827ccc34577651f799dce39621';
    const paths = publicFilesAt(commit);
    expect(paths).toContain('src/widget/locales/zh-CN.ts');
    expect(paths.length).toBe(mobileBaseline.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      mobileBaseline.sha256
    );
  }, 30_000);

  it('pins the reviewed v4 release deferral to PR #425', () => {
    const commit = 'f6ca6a6cdba9704edf87a40cf6a4f15f814ba2fc';
    const paths = publicFilesAt(commit);
    expect(paths).not.toContain('src/widget/locales/zh-CN.ts');
    expect(paths.length).toBe(deferredBaseline.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      deferredBaseline.sha256
    );
  }, 30_000);

  it('pins the reviewed v5 public tree before the standard-modal accessibility change', () => {
    const commit = '5f302286f1c1831910fc6038881ac8bcc77c621c';
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(current.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      current.sha256
    );
  }, 30_000);

  it('pins the reviewed v6 accessibility tree before Flow screenshot integration', () => {
    const commit = 'daf7e5da';
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(accessible.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      accessible.sha256
    );
  }, 30_000);

  it('pins the reviewed v7 Flow capture tree before acquisition counting', () => {
    const commit = 'aaf71e8d306e7736d8badcc3842fd9ecd6a6f435';
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(flowCapture.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      flowCapture.sha256
    );
  }, 30_000);

  it('pins the acquisition baseline before the production canary compatibility change', () => {
    const commit = productionCanary.approvedDelta.baseCommit;
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(acquisition.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      acquisition.sha256
    );
  }, 30_000);

  it('pins the reviewed v9 production canary tree before public total publication', () => {
    const commit = totals.approvedDelta.baseCommit;
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(productionCanary.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      productionCanary.sha256
    );
  }, 30_000);

  it('pins the reviewed v10 public tree before uploaded-image thumbnails', () => {
    const commit = thumbnails.approvedDelta.baseCommit;
    const paths = publicFilesAt(commit);
    expect(paths.length).toBe(totals.fileCount);
    expect(fingerprint(paths, path => execFileSync('git', ['show', `${commit}:${path}`]))).toBe(
      totals.sha256
    );
  }, 30_000);

  it('pins uploaded-image thumbnails to the exact reviewed PR tree', () => {
    expect(thumbnails.reviewedCommit).toBe('518658c3f51a3e9c7d909da89ddb7cfa2f20322c');
    expect(thumbnails.approvedDelta.previousBaseline).toBe('current-public-baseline.v10.json');
    expect(thumbnails.approvedDelta.previousSha256).toBe(totals.sha256);
    const paths = publicFilesAt(thumbnails.reviewedCommit);
    expect(paths.length).toBe(thumbnails.fileCount);
    expect(
      fingerprint(paths, path =>
        execFileSync('git', ['show', `${thumbnails.reviewedCommit}:${path}`])
      )
    ).toBe(thumbnails.sha256);
  }, 30_000);

  it('matches the thumbnail baseline with only its two declared widget sources changed', () => {
    const paths = publicFiles();
    const base = thumbnails.approvedDelta.baseCommit;
    const prior = publicFilesAt(base);
    const changed = paths.filter(
      path =>
        !prior.includes(path) ||
        !Buffer.from(readFileSync(path)).equals(execFileSync('git', ['show', `${base}:${path}`]))
    );
    expect(thumbnails.approvedDelta.changedPublicSources).toEqual([
      'src/widget/index.ts',
      'src/widget/ui.ts',
    ]);
    expect(changed).toEqual(thumbnails.approvedDelta.changedPublicSources);
    expect(prior.filter(path => !paths.includes(path))).toEqual([]);
    expect(paths.length).toBe(thumbnails.fileCount);
    expect(fingerprint(paths, readFileSync)).toBe(thumbnails.sha256);
  }, 30_000);

  it.each([
    'src/index.ts',
    'wrangler.toml',
    'scripts/build-widget.js',
    'src/widget/locales/zh-CN.ts',
    'src/widget/index.ts',
    'src/widget/ui.ts',
  ])('detects a public boundary mutation in %s', target => {
    const hash = fingerprint(publicFiles(), path => {
      const bytes = readFileSync(path);
      return path === target ? Buffer.concat([bytes, Buffer.from('\nMANAGED_MUTATION')]) : bytes;
    });
    expect(hash).not.toBe(thumbnails.sha256);
  });
});
