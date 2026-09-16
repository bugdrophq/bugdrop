import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function outcomes(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const records = [];
  function visit(suite, titles = []) {
    const context = [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        assert.equal(test.status, 'expected', `${spec.title}: unexpected/flaky/skipped result`);
        assert.equal(test.expectedStatus, 'passed');
        assert.equal(test.results.length, 1, `${spec.title}: retries are not clean baseline proof`);
        assert.equal(test.results[0].status, 'passed');
        records.push({
          file: spec.file,
          title: [...context, spec.title].join(' > '),
          project: test.projectName,
          status: test.status,
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, context);
  }
  for (const suite of report.suites) visit(suite);
  assert.equal(report.errors?.length ?? 0, 0);
  assert.equal(records.length, 48, 'Expected the full selected public regression set');
  return records.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const [before, after] = process.argv.slice(2);
assert.ok(
  before && after,
  'Usage: node scripts/cross-plane/compare-public-runs.mjs BEFORE.json AFTER.json'
);
assert.deepEqual(outcomes(after), outcomes(before));
console.log('All 48 current-public regression identifiers and successful outcomes match.');
