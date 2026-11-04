# Merge-Queue Real-Issue Canary Implementation Plan

**Status:** Ready for owner review

**Date:** 2026-08-01

**Scope:** Merge-group preview CI, legacy widget submission, Worker build identity, independent GitHub
Issue verification, and fail-visible cleanup

## Objective

Add one merge-group-only canary that proves the exact widget bytes built from the merge-group SHA,
runs through the preview Worker built from that same SHA, and creates one real, correctly formatted
Issue in `mean-weasel/bugdrop-widget-test` through the existing GitHub App. The canary then
independently reads the Issue with a least-privilege token, rejects duplicates, and closes every
matching canary Issue even when submission or verification fails partway through.

This document is an implementation plan, not authorization to implement. Configurable feedback
variants remain out of scope. The legacy behavior protected by
`docs/plans/2026-08-01-configurable-feedback-variants-design.md` is compatibility context only.

## Why this work is necessary

The current live submission test in `e2e/widget.live.spec.ts` makes an unmanaged real `/feedback`
request, accepts success or error, inherits two CI retries, records no Issue identity, and performs no
cleanup. The same live project runs in merge-group, production, scheduled, and manual workflows.

The historical cleanup preceding this plan found 394 Issues titled exactly
`Live E2E test submission`; 332 were open. All 332 were closed, and a before/after fingerprint proved
that none of the 119 unrelated open Issues changed. Durable evidence is in
`docs/goals/merge-queue-issue-canary/notes/T001-cleanup-evidence.md`.

Current architecture also permits a second merge group to overwrite the one shared
`bugdrop-preview` Worker while the first group is testing it. Preview deployment needs only the
fast `check` job, not unit, build, local E2E, or the Radix browser matrix. Widget bytes are already
hashed well, but `/api/health` carries no Worker build identity.

Detailed current-state evidence and the approved architecture are in:

- `docs/goals/merge-queue-issue-canary/notes/T002-architecture-map.md`
- `docs/goals/merge-queue-issue-canary/notes/T003-architecture-decision.md`

## Non-goals

- No configurable feedback variants, headless submission API, or UX redesign.
- No new Worker, database, queue, KV namespace, storage service, or external cleanup service.
- No new GitHub App and no expansion of the existing BugDrop App's role.
- No production real-Issue canary.
- No screenshot or attachment upload in the canary.
- No GitHub ruleset mutation; preserve the required check names `Deploy Preview` and
  `Live Preview Tests`.
- No exactly-once delivery claim. GitHub and runner outages make an absolute synchronous cleanup
  guarantee impossible; the design provides fail-visible immediate cleanup and two eventual
  recovery paths.

## Invariants

1. Only `merge_group` may create a canary Issue.
2. Issue creation uses the existing preview Worker and GitHub App. The verification token never
   creates an Issue.
3. No shared-preview deployment or consumer overlaps another merge group's preview critical
   section.
4. Preview deployment begins only after check, unit/build, local Chromium E2E, and the local Radix
   browser matrix pass.
5. The venue's actual widget script bytes equal the bytes built from the checked-out merge-group
   tree.
6. The actual `/feedback` response identifies the preview Worker build as the full merge-group SHA.
7. One canary attempt performs one browser submission with Playwright retries explicitly zero.
8. A server-side verifier finds exactly one matching non-PR Issue and asserts its complete contract.
9. Cleanup discovers by marker rather than relying on a response number or GitHub search indexing.
10. Cleanup closes all matching Issues, then proves none remain open.
11. Scheduled, production, manual, PR, and local live paths cannot make a real canary submission.
12. Existing unconfigured Worker and widget behavior remains unchanged.

## Operator prerequisite

Create one fine-grained GitHub token and store it as the repository Actions secret
`BUGDROP_CANARY_GITHUB_TOKEN`.

- Resource owner: the owner that can grant access to `mean-weasel/bugdrop-widget-test`.
- Repository access: only `mean-weasel/bugdrop-widget-test`.
- Repository permission: Issues read/write. Write includes read.
- No Contents, Actions, Administration, Pull requests, or organization permissions.
- Give it an expiry and document rotation ownership.

The token is step-scoped only to verification and cleanup commands. It must never be:

- set at workflow or job scope;
- passed to Playwright or a browser page;
- sent to the Worker;
- placed in a trace, report, artifact, Issue, or log;
- used to create the canary Issue.

Before enabling the live canary, verify the token with non-mutating list/get calls and one
operator-approved close/reopen exercise on a temporary Issue if organizational policy requires it.

## Marker and expected Issue contract

Construct one marker per workflow attempt:

```text
bugdrop-ci-canary:<GITHUB_RUN_ID>:<GITHUB_RUN_ATTEMPT>:<GITHUB_SHA>
```

Use the full merge-group SHA. Put the full marker in both the title and description. Use a stable
title prefix such as `[BugDrop CI canary]` so preflight and scheduled cleanup can identify stale
canaries while the full marker identifies one attempt.

The expected Issue contract is:

- positive integer `number`;
- exact canonical URL
  `https://github.com/mean-weasel/bugdrop-widget-test/issues/<number>`;
- exact expected title containing the full marker;
- raw body contains `## Description`, the full marker, system-information details, and
  `*Submitted via [BugDrop](https://github.com/mean-weasel/bugdrop)*`;
- raw body does not contain `## Screenshot`;
- exact label set `bug`, `bugdrop`;
- creator `neonwatty-bugdrop[bot]`;
- state `open` before cleanup;
- exactly one non-PR Issue matches the current full marker.

The title and body marker make response-loss cleanup possible. Filtering must paginate the REST
Issues endpoint with `state=all`, reject entries containing `pull_request`, and compare marker/title
content locally. Do not use GitHub search as cleanup truth because indexing can lag Issue creation.

## Target CI shape

### Required local gates

Keep the existing local jobs parallel, but require all of them before shared-preview work:

```text
check
├── test
├── e2e (two shards)
└── radix-e2e (three browsers)
     └── preview-critical-section / check name: Deploy Preview
          └── live-preview-status / check name: Live Preview Tests
```

The preview critical-section job uses:

```yaml
needs: [check, test, e2e, radix-e2e]
if: github.event_name == 'merge_group'
concurrency:
  group: bugdrop-shared-preview
  cancel-in-progress: false
  queue: max
```

`queue: max` matters: `cancel-in-progress: false` protects the active job, but the default
concurrency queue retains only one pending job and cancels an older pending required-check run.

### One uninterrupted shared-preview job

The job retaining the name `Deploy Preview` owns this entire sequence while holding the mutex:

1. Checkout the merge-group SHA and install dependencies/browsers.
2. Preflight cleanup of every stale reserved-prefix canary Issue; verify none remain open.
3. Build all assets from the checkout and compute expected widget SHA-256.
4. Deploy `bugdrop-preview` with `BUILD_SHA=$GITHUB_SHA`.
5. Poll health until `environment == preview` and `buildSha == GITHUB_SHA`.
6. Poll the deployed widget until its bytes match expected SHA-256.
7. Verify the fixed Vercel venue loads that preview origin and exact asset.
8. Run the existing nonmutating Chromium live suite and live Radix suite.
9. Run Chromium, Firefox, and WebKit cross-browser live smoke coverage inside this same job.
10. Run the dedicated Chromium real-Issue canary once, with zero retries.
11. Independently verify exactly one real Issue and its complete contract.
12. In a separate `if: always()` step, close all current-marker matches and re-read them.
13. In the final locked cleanup step, sweep all open reserved-prefix canaries and fail if any remain.
14. Upload failure artifacts only after cleanup; no artifact may contain the token.

No preview deployment or live-preview consumer may remain in a separate job. A job-level lock that
ends after deployment does not protect tests.

### Preserve required status names

The existing ruleset requires `Deploy Preview` and `Live Preview Tests`.

- The critical-section job remains named `Deploy Preview`.
- Replace the current live job with a lightweight dependent job named `Live Preview Tests`.
- Give it `if: always()` and make it exit nonzero unless the critical-section job result is exactly
  `success`.

This is a fail-closed status bridge, not an unconditional no-op. It prevents a skipped downstream
job from hiding preview or cleanup failure.

## Implementation packages

Follow test-first sequencing within each package. Packages are ordered because later workflow work
depends on earlier helper and runtime contracts.

### Package A: testable GitHub Issue verifier and cleaner

Candidate files:

- `scripts/github-issue-canary.mjs`
- `test/githubIssueCanary.test.ts`
- `knip.json` only if the new CLI must be declared as an entry
- `package.json` or `Makefile` only if a named command materially reduces unsafe invocation

Implement a module with injected `fetch` for tests and a small CLI for Actions. Suggested commands:

```text
preflight --repo mean-weasel/bugdrop-widget-test --prefix "[BugDrop CI canary]"
verify --repo ... --marker ... --result-file test-results/issue-canary-result.json
cleanup --repo ... --marker ...
sweep --repo ... --prefix "[BugDrop CI canary]"
```

Required behavior:

- Parse Link pagination until exhausted.
- Always request `state=all` for current-marker verification and current cleanup.
- Exclude `pull_request` entries.
- Require repository identity and exact marker/prefix inputs.
- Verify the response result file identifies the same sole Issue found by marker.
- Assert title, raw body, exact labels, bot author, footer, no screenshot, URL, number, and state.
- On duplicate verification, fail but return enough structured information for cleanup to close all
  matches.
- Cleanup closes every open match, not the first.
- On an ambiguous PATCH failure, GET that exact Issue before deciding whether retry is safe.
- A readback showing already closed is idempotent success.
- A readback showing open may receive one bounded retry; retain all failures and continue closing
  other matches.
- Re-enumerate after cleanup and exit nonzero if any match remains open.
- Never print the Authorization header or token.

Write failure-mode tests before the CLI path. All tests use fake API responses and no credentials.

Focused verification:

```bash
npx vitest run test/githubIssueCanary.test.ts
npm run lint
npm run typecheck
npx knip
```

Stop if the helper needs broader than repository-scoped Issues read/write, uses search indexing, or
cannot keep authorization out of diagnostic output.

Rollback: remove the helper and its tests before any workflow step depends on it.

### Package B: additive Worker build identity

Files:

- `src/types.ts`
- `src/routes/api.ts`
- `test/api.test.ts`

Test first:

1. Configured `BUILD_SHA` appears in health JSON.
2. Configured `BUILD_SHA` appears as `X-BugDrop-Build-SHA` on successful `/feedback` responses.
3. Decide and test whether the header also appears on feedback errors; consistent middleware is
   preferable because failure responses remain diagnosable.
4. With no `BUILD_SHA`, existing health and API contracts remain compatible and no misleading SHA
   value is emitted.
5. Existing Issue body, labels, authentication, and response fields remain unchanged.

Implementation:

- Add optional `BUILD_SHA?: string` to `Env`.
- Add an API middleware/header only when the binding is nonempty.
- Add `buildSha` to health only when configured.
- Deploy preview with a properly quoted `--var BUILD_SHA:$GITHUB_SHA` argument.
- After deployment, assert both `environment == preview` and exact full SHA so a missing/overridden
  preview variable fails before submission.

Focused verification:

```bash
npx vitest run test/api.test.ts
npm run typecheck
npm run lint
```

Stop if this changes request bodies, Issue formatting, authentication, label resolution, or behavior
of an unconfigured deployment.

Rollback: stop passing the variable and revert the optional header/health fields together.

### Package C: isolated legacy-widget Playwright canary

Files:

- new `e2e/widget.issue-canary.spec.ts`
- `e2e/widget.live.spec.ts`
- `playwright.config.ts`
- focused tests/helpers if extraction is needed

First remove the unmanaged side effect:

- Convert `Feedback Submission (Live)` to a fully mocked transport/UI assertion, or remove it only
  if equivalent mocked coverage already exists.
- Assert regular live, production, scheduled, and manual paths make no unmocked feedback POST.

Add a dedicated project whose `testMatch` is only the canary spec. Also ensure regular Chromium and
live projects exclude it. Set:

```text
fullyParallel: false
workers: 1
retries: 0
```

The workflow command must repeat `--workers=1 --retries=0` as drift defense.

Canary flow:

1. Require explicit `LIVE_TARGET=preview`, expected widget origin/hash, full expected Worker SHA,
   marker, and result-file path. Fail before interaction when any value is missing.
2. Open the real fixed Vercel preview venue.
3. Read its actual script source and prove preview origin and expected bytes.
4. Do not mock `/api/check` or `/feedback`.
5. Open the legacy trigger and form.
6. Fill the exact marker-bearing title and description.
7. Explicitly uncheck/disable screenshot capture before Submit. Do not enter capture and click Skip.
8. Start the POST response waiter before clicking Submit.
9. Require exactly one `/api/feedback` POST to the preview Worker.
10. Assert `X-BugDrop-Build-SHA` equals the full expected SHA.
11. Parse success JSON and require a positive integer number and exact canonical URL.
12. Write only `{ marker, issueNumber, issueUrl, workerSha }` to the ephemeral result file. It
    contains no credential.
13. Assert the widget reaches its success UI. Independent GitHub field verification remains
    server-side.

If the Worker creates an Issue but the response is lost or assertions fail, the result file may be
absent. Cleanup must still find and close by marker.

Local/PR verification must be nonmutating:

```bash
npx playwright test e2e/widget.issue-canary.spec.ts --project=chromium-issue-canary --list
npx playwright test --project=chromium
```

The real canary itself is not a local verification command and must not run without the merge-group
workflow and token-backed cleanup surrounding it.

Stop if the token enters Playwright, the test can match a non-merge-group project, screenshot upload
is possible, or more than one submission can occur.

Rollback: restore mocked live coverage and remove the dedicated project/spec before removing cleanup
or helper code.

### Package D: workflow critical section, recovery, contracts, and docs

Files:

- `.github/workflows/ci.yml`
- `.github/workflows/live-tests.yml`
- `test/ci-workflow-contract.test.sh`
- `Makefile` only if approved by Package A/C
- relevant CI/testing documentation

Update the static contract test before restructuring the workflow. It must assert:

- critical job is merge-group-only;
- `needs` includes check, unit/build, local E2E matrix, and Radix matrix;
- exactly one job owns preview deployment and every preview test/canary step;
- shared concurrency group, `cancel-in-progress: false`, and `queue: max` are present;
- both required check names remain;
- status bridge uses `if: always()` and fails unless the critical job succeeded;
- canary invocation is explicit, one worker, and zero retries;
- verification token appears only in verifier/cleanup step environments;
- cleanup uses `if: always()` and does not require the result file;
- normal live workflow cannot invoke the canary;
- current unmanaged real submission is gone or mocked;
- scheduled janitor uses the same lock and never submits feedback.

Workflow step order follows the target CI shape above. Preserve failure reports, but run cleanup
before artifacts or status bridging.

For hard-cancellation recovery, add a janitor to the existing daily scheduled live workflow:

- On `schedule`, coordinate through the same `bugdrop-shared-preview` concurrency group with queueing
  so it cannot close an active merge-group canary.
- For workflow calls and manual dispatches, use a unique concurrency group so production/manual live
  checks do not block the preview mutex.
- Run server-side stale `sweep` in an `if: always()` step with the token scoped only to that step.
- Never run the canary from this workflow.

Focused verification:

```bash
bash test/ci-workflow-contract.test.sh
npm run check:actions-node24
npm run format:check
```

Then run the full local oracle before live rollout:

```bash
npm run validate
make build-all
make test-e2e
make test-radix-e2e BROWSER=chromium
make test-radix-e2e BROWSER=firefox
make test-radix-e2e BROWSER=webkit
```

Stop if required check names would change, a ruleset update becomes necessary, the lock does not span
all preview consumers, scheduled cleanup can race an active canary, or workflow syntax cannot be
proven by the contract test.

Rollback: revert the workflow, bridge, and scheduled janitor as one package. Do not leave a real
submission path enabled without cleanup.

## Failure-mode proof matrix

| Failure mode | Test/injection | Required result |
| --- | --- | --- |
| Leaked Issue | Fake cleanup API leaves one marker match open after PATCH | Cleanup exits nonzero and reports the exact number; bridge fails |
| Duplicate Issues | Verifier receives two non-PR Issues with the full marker | Verification fails; cleanup closes both; final readback is zero open |
| Response lost after creation | Marker Issue exists but result file is absent | Verification fails; `if: always()` cleanup still finds and closes it |
| Cleanup partial failure | One close returns error and GET still says open | Continue other closes, bounded retry, final nonzero until none remain |
| Ambiguous close response | PATCH errors but exact GET says closed | Treat as idempotent success without creating or reopening anything |
| Wrong widget bytes | Expected hash differs from actual venue script | Fail before Submit; no Issue exists |
| Wrong Worker SHA before Submit | Health build SHA differs | Fail before Submit; no Issue exists |
| Wrong Worker on actual POST | Feedback response header differs | Browser test fails; marker cleanup closes any created Issue |
| Concurrent preview replacement | Static contract removes/changes mutex or leaves a consumer outside job | Workflow contract test fails |
| Retry drift | Project or command omits zero retries | Config/workflow contract test fails |
| Pull request returned by Issues API | Fake page contains `pull_request` with marker | Verifier and cleanup ignore it |
| Search-index lag | Search has no result but paginated list contains marker | List-based verifier/cleanup finds the Issue |
| Scheduled/production/manual accidental invocation | Normal live project/workflow discovery | Canary is not selected; all feedback POSTs are mocked/absent |
| Hard cancellation | Same-run cleanup is skipped | Next locked preflight or daily locked janitor closes stale marker |
| Token missing/expired | Verifier receives 401/403 | Job fails visibly; canary does not silently pass; cleanup recovery remains pending |

## Requirement traceability matrix

| Original requirement | Package/files | Executable assertion | Verification |
| --- | --- | --- | --- |
| Merge-queue-only | C/D: canary project and CI workflow | Explicit `merge_group`; normal paths cannot select canary | Playwright list + workflow contract |
| Exact deployed widget matches SHA | C/D: current hash setup + canary | Actual venue script origin and SHA-256 equal checkout build | Focused Playwright/hash negative test |
| Exact preview Worker matches SHA | B/C/D: Env, API, deploy, canary | Health and actual POST header equal full `GITHUB_SHA` | API unit tests + wrong-SHA negative test |
| Real Issue through existing App | C: real legacy widget POST | No `/feedback` mock; response is positive number/canonical URL | One merge-group evidence record |
| Least-privilege verification/cleanup | A/D: helper and step env | Token only in Issues API steps; helper has no create command | Workflow contract + permission review |
| Correct title/body/labels/attribution/marker | A/C | Exactly one API Issue matches every expected field | Helper unit tests + live readback receipt |
| No screenshots | C/A | Screenshot explicitly disabled; body lacks screenshot section | Playwright assertion + API verifier |
| Disable retries and prevent duplicates | A/C/D | Project and CLI retries zero; exactly one marker match | Config contract + duplicate fixture |
| Always close matches after partial failure | A/D | Separate `if: always()` close-all and final readback | Lost-response/partial-close fixtures |
| Recover from hard cancellation | A/D | Locked next-run sweep plus locked daily janitor | Workflow contract + stale fixture |
| Prevent shared-preview replacement | D | One queued non-cancelling mutex encloses every consumer | Workflow ownership/concurrency contract |
| Run after local gates | D | Critical job needs check, test, E2E, Radix | Workflow contract |
| No new storage/services | All | Only ephemeral result file and existing Actions/GitHub/Worker | Diff audit |
| Preserve existing behavior | B/C | Optional identity; normal live POST mocked; legacy payload unchanged | Existing unit/E2E suites |
| Update tests/docs | A-D | Focused tests, contract guard, operator docs | `npm run validate` + formatting |
| No configurable variants | All | No variant API/runtime files changed | Diff audit against allowed scope |

## Live rollout and burden of proof

Do not declare the implementation complete merely because unit tests and workflow syntax pass.

The first live merge-group run must retain evidence of:

1. All local gates completed before preview deployment began.
2. Concurrency group acquisition and no overlapping preview critical section.
3. Expected and actual widget SHA-256 match.
4. Health `buildSha` equals the merge-group SHA.
5. Actual feedback response header equals the merge-group SHA.
6. Positive Issue number and canonical URL from the widget response.
7. Independent API readback of the exact title, body, marker, label set, bot author, footer, and no
   screenshot section.
8. Exactly one marker match before cleanup.
9. The Issue state is closed after cleanup.
10. A final repository query finds zero open reserved-prefix canary Issues.

Then deliberately try to disprove the implementation with the strongest realistic failures:

- Run the helper fixtures for duplicate, lost response, ambiguous/partial close, and leak.
- Inspect the workflow DAG to prove no preview consumer sits outside the mutex.
- Inspect project discovery to prove the canary cannot run from normal live workflows.
- Force a wrong expected Worker SHA in a noncreating test path and prove it blocks submission.
- Re-run the complete local oracle, not only focused tests.

The final handoff must include these commands/results and the live Issue URL as an audit record. The
Issue itself should already be closed. Never publish or log the verification token.

## Owner review checklist

Before approving implementation, confirm:

- [ ] The job-level critical-section restructure and fail-closed required-check bridge are acceptable.
- [ ] The local Radix matrix should block preview deployment.
- [ ] The secret name and fine-grained token ownership/rotation plan are acceptable.
- [ ] The stable marker prefix and exact field expectations are acceptable.
- [ ] A daily lock-coordinated stale janitor in the existing scheduled workflow is acceptable.
- [ ] The existing production/scheduled live suite should stop making real feedback submissions.
- [ ] The first merge-group live run may create one short-lived, automatically closed test Issue.

After approval, execute Packages A-D in order and require a final Judge review against the live
rollout evidence above.
