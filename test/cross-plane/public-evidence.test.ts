import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('refuses changed, skipped, retried or empty public regression evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bugdrop-public-evidence-'));
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  const report = {
    errors: [],
    suites: [
      {
        title: 'current public regression',
        specs: Array.from({ length: 48 }, (_, index) => ({
          title: `scenario-${index}`,
          file: 'public-flow.spec.ts',
          tests: [
            {
              status: 'expected',
              expectedStatus: 'passed',
              projectName: 'chromium',
              results: [{ status: 'passed' }],
            },
          ],
        })),
      },
    ],
  };
  const compare = () =>
    execFileSync(process.execPath, ['scripts/cross-plane/compare-public-runs.mjs', before, after], {
      stdio: 'pipe',
    });
  try {
    writeFileSync(before, JSON.stringify(report));
    writeFileSync(after, JSON.stringify(report));
    expect(compare).not.toThrow();
    const mutations = [
      (candidate: typeof report) => {
        candidate.suites[0].specs[0].title = 'different scenario';
      },
      (candidate: typeof report) => {
        candidate.suites[0].specs[0].tests[0].status = 'skipped';
      },
      (candidate: typeof report) => {
        candidate.suites[0].specs[0].tests[0].results.push({ status: 'passed' });
      },
      (candidate: typeof report) => {
        candidate.suites[0].specs = [];
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(report);
      mutate(candidate);
      writeFileSync(after, JSON.stringify(candidate));
      expect(compare).toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
