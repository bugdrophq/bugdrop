import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitObserverError, observeGitRange } from '../../scripts/release/git-observer.mjs';

const temporaryDirectories: string[] = [];

function git(directory: string, ...args: string[]) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function repositoryWithLargeChange() {
  const directory = mkdtempSync(join(tmpdir(), 'bugdrop-git-observer-'));
  temporaryDirectories.push(directory);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'BugDrop Test');
  git(directory, 'config', 'user.email', 'bugdrop@example.test');
  writeFileSync(join(directory, 'baseline.txt'), 'baseline\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'Baseline');
  const previousSha = git(directory, 'rev-parse', 'HEAD');
  mkdirSync(join(directory, 'changed'));
  for (let index = 0; index < 301; index += 1) {
    writeFileSync(
      join(directory, 'changed', `${String(index).padStart(3, '0')}.txt`),
      `${index}\n`
    );
  }
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'Change more than REST compare can report');
  const targetSha = git(directory, 'rev-parse', 'HEAD');
  return { directory, previousSha, targetSha };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('complete immutable Git observation', () => {
  it('reports all paths beyond GitHub compare RESTs 300-file cap', () => {
    const fixture = repositoryWithLargeChange();
    const result = observeGitRange({
      repositoryDir: fixture.directory,
      previousSha: fixture.previousSha,
      targetSha: fixture.targetSha,
      mainSha: fixture.targetSha,
      controllerSha: fixture.targetSha,
    });
    expect(result.changedPaths).toHaveLength(301);
    expect(result.changedPaths.at(0)).toBe('changed/000.txt');
    expect(result.changedPaths.at(-1)).toBe('changed/300.txt');
    expect(result.commits).toEqual([
      { sha: fixture.targetSha, subject: 'Change more than REST compare can report' },
    ]);
    expect(result.facts).toMatchObject({
      targetReachableFromMain: true,
      previousReleaseAncestor: true,
      targetStrictlyLater: true,
      controllerReachableFromMain: true,
    });
  }, 30_000);

  it('rejects abbreviated identity before invoking Git', () => {
    const runner = { run: () => expect.unreachable('runner must not be called') };
    expect(() =>
      observeGitRange(
        {
          repositoryDir: '/tmp/repo',
          previousSha: 'short',
          targetSha: 'a'.repeat(40),
          mainSha: 'b'.repeat(40),
          controllerSha: 'c'.repeat(40),
        },
        runner
      )
    ).toThrow(GitObserverError);
  });
});
