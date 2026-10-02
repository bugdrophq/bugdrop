import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const preview = workflow.jobs['deploy-preview'];
const condition = preview.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
// Evaluate the actual workflow expression across success, failure, skip and cancellation.
const permitsPreview = new Function(
  'always',
  'github',
  'needs',
  `return (${condition
    .replaceAll('needs.radix-e2e', "needs['radix-e2e']")
    .replaceAll('needs.mobile-webkit-e2e', "needs['mobile-webkit-e2e']")});`
);
for (const event of ['pull_request', 'merge_group']) {
  for (const full of ['true', 'false', undefined]) {
    for (const check of ['success', 'failure', 'skipped', 'cancelled']) {
      for (const test of ['success', 'failure', 'skipped', 'cancelled']) {
        for (const e2e of ['success', 'failure', 'skipped', 'cancelled']) {
          for (const radix of ['success', 'failure', 'skipped', 'cancelled']) {
            for (const mobileWebkit of ['success', 'failure', 'skipped', 'cancelled']) {
              const expected =
                event === 'merge_group' &&
                check === 'success' &&
                (full === 'false' ||
                  [test, e2e, radix, mobileWebkit].every(result => result === 'success'));
              assert.equal(
                permitsPreview(
                  () => true,
                  { event_name: event },
                  {
                    check: { result: check, outputs: { full_ci: full } },
                    test: { result: test },
                    e2e: { result: e2e },
                    'radix-e2e': { result: radix },
                    'mobile-webkit-e2e': { result: mobileWebkit },
                  }
                ),
                expected
              );
            }
          }
        }
      }
    }
  }
}
for (const step of preview.steps.slice(1)) {
  assert.ok(step.if.includes("needs.check.outputs.full_ci != 'false'"), step.name ?? step.uses);
}
assert.equal(preview.steps[0].if, "needs.check.outputs.full_ci == 'false'");
assert.equal(workflow.jobs['live-preview-tests'].needs[0], 'deploy-preview');
const checkSteps = workflow.jobs.check.steps;
assert.ok(
  checkSteps.findIndex(step => step.uses?.startsWith('actions/setup-node@')) <
    checkSteps.findIndex(step => step.id === 'scope')
);
assert.ok(
  checkSteps.find(step => step.id === 'scope').env.PR_BASE_SHA.includes('merge_group.base_sha')
);
assert.ok(
  checkSteps.find(step => step.id === 'scope').env.PR_HEAD_SHA.includes('merge_group.head_sha')
);
console.log('CI scope workflow gate checks passed (6,144 preview states)');
