# T002 architecture map

## Current workflow DAG

The `CI` workflow runs on `pull_request` and `merge_group`.

```text
check
├── test (unit + build)
├── e2e (Chromium, two shards)
├── radix-e2e (Chromium, Firefox, WebKit)
└── deploy-preview (merge_group only)
    ├── live-preview-tests (Chromium live + Chromium live Radix)
    └── live-preview-cross-browser-tests (Chromium, Firefox, WebKit matrix)
```

Evidence:

- `.github/workflows/ci.yml:133-155`: unit tests and full build need only `check`.
- `.github/workflows/ci.yml:157-218`: both local Chromium E2E shards need only `check`.
- `.github/workflows/ci.yml:227-275`: the local Radix browser matrix needs only `check`.
- `.github/workflows/ci.yml:285-311`: `deploy-preview` also needs only `check`, so preview
  deployment can begin before unit, build, local E2E, or Radix results exist.
- `.github/workflows/ci.yml:313-423`: the main live preview job needs only deployment.
- `.github/workflows/ci.yml:425-519`: the cross-browser live matrix also needs only deployment.
- The active GitHub ruleset requires Lint/Check, Unit, both local Chromium E2E shards, Deploy
  Preview, and Live Preview Tests. It does not require the local Radix matrix or live cross-browser
  matrix, although those jobs still run.

The implementation must decide whether "all local unit/E2E gates" includes the Radix browser matrix.
Repository guidance and the existing PR-reuse check treat the Radix matrix as part of the reusable
local checks, so the conservative dependency is `check`, `test`, `e2e`, and `radix-e2e` before any
preview deployment.

## Shared-preview replacement surface

- `wrangler.toml:43-57` names one shared Worker, `bugdrop-preview`, and one shared preview KV
  namespace.
- No workflow currently declares `concurrency`, `cancel-in-progress`, or a queue policy.
- The merge-queue ruleset allows up to five entries to build concurrently.
- Both live-preview jobs release from the same deploy job and execute concurrently against the same
  Worker URL.
- A second merge-group workflow can deploy a different SHA while the first workflow is still in
  either live job. Locking only `deploy-preview`, only a new canary job, or separate deploy/test jobs
  does not protect the interval between deployment and the last preview consumer.

GitHub's current concurrency contract supports a repository-wide workflow or job group,
`cancel-in-progress`, and `queue: max`. Without `queue: max`, only one pending run is retained, so a
new merge group can cancel an older pending required-check run even when the active run is not
canceled. Source:
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

Candidate designs for Judge resolution:

1. A workflow-level merge-group concurrency group spanning local gates through every preview
   consumer and cleanup, with `cancel-in-progress: false` and `queue: max`. This preserves current
   required check names but serializes complete merge-group CI runs.
2. Restructure all preview deployment and consumers into one job-level critical section after local
   gates. This is narrower but conflicts with the existing separately required `Deploy Preview` and
   `Live Preview Tests` check names unless rule/config aggregation is redesigned.
3. Per-SHA Worker names would avoid the mutex but changes deployment topology and cleanup scope; it
   is inconsistent with the stated shared-preview constraint and is not the smallest compatible
   plan.

## Widget identity proof

The repository already has a strong byte-level widget check:

- `.github/workflows/ci.yml:385-405` and `486-506` rebuild `public/widget.js` from the checked-out
  merge-group tree, compute SHA-256, and poll the deployed preview asset until it matches.
- `e2e/widget.live.spec.ts:348-369` reads the actual page's script URL, requires the preview Worker
  origin, fetches that exact URL, and compares its SHA-256 with `EXPECTED_WIDGET_SHA256`.
- The Vercel venue's `index.html` uses `src="__BUGDROP_URL__/widget.js"` and
  `data-repo="mean-weasel/bugdrop-widget-test"`; `vite.config.ts` substitutes
  `VITE_BUGDROP_URL` (defaulting to production). The fixed preview alias must therefore keep its
  preview URL configuration, and the DOM-origin/hash assertion is the authoritative runtime proof.

This proves the bytes loaded by the venue equal the widget built from the merge-group checkout. The
bundle version string is tag-derived rather than SHA-derived, but byte equality is the stronger
artifact identity signal.

## Missing Worker identity proof

- `src/routes/api.ts:108-115` returns only `status`, `environment`, and a current timestamp from
  `/api/health`.
- `src/types.ts:1-29` has no build-SHA binding.
- Preview deployment is `npx wrangler deploy --env preview`, with no SHA variable or version tag.
- A healthy response therefore proves only that some preview Worker answered.

Cloudflare's current Wrangler `deploy --var key:value` flag injects a string binding and overrides a
same-name configured value, so CI can deploy with a nonsecret `BUILD_SHA:$GITHUB_SHA`. Source:
https://developers.cloudflare.com/workers/wrangler/commands/workers/

Candidate additive proof contract:

- Add optional `BUILD_SHA` to `Env`.
- Deploy preview with the merge-group `GITHUB_SHA` as `BUILD_SHA`.
- Return it from health for readiness/diagnostics.
- Add `X-BugDrop-Build-SHA` to the actual `/feedback` response and assert it on the browser-observed
  POST response. Health-before-submit alone is insufficient because replacement could occur between
  health and feedback.

Cloudflare version-metadata exposes a Cloudflare version ID/tag/timestamp, but not the Git SHA unless
CI also supplies a tag; a direct SHA binding is simpler and directly testable. Source:
https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/

## Current real-Issue side effect and retry behavior

- `e2e/widget.live.spec.ts:815-864` performs one unmocked `/feedback` POST with title
  `Live E2E test submission`.
- It mocks only `/api/check`, waits a fixed eight seconds, and accepts either success or error.
- It does not capture a response number/URL, independently read GitHub, detect duplicates, or close
  a created Issue.
- `playwright.config.ts:5-14` applies two retries to all CI projects; the `chromium-live` project does
  not override retries. A failed attempt after Issue creation can therefore create another Issue.
- The same `chromium-live` project is invoked by `.github/workflows/live-tests.yml`, which runs by
  reusable production call, manual dispatch (preview by default), and a daily production schedule.
- The production deployment workflow also calls this reusable live workflow after every main
  deployment. The unmanaged POST is therefore not merge-group-only.
- T001 proved the consequence: 394 historical exact-title Issues existed, 332 were open before
  cleanup, and all are now closed.

A dedicated canary file/project must not match the regular live project's pattern. The unmanaged
submission test must be removed or changed to a fully mocked transport-only assertion so scheduled,
production, PR, and manual live paths cannot create Issues. The canary invocation must set retries
to zero both in its project and command line as defense against config drift.

## Real submission and readback contract available today

- `src/routes/api.ts:136-288` gets an installation token from the existing GitHub App, creates the
  Issue, and returns `issueNumber`, `issueUrl`, and `isPublic`.
- The verification token is not needed by the Worker or widget and must never be passed to either.
- The test venue uses the legacy script-tag widget and the target repository.
- The widget can submit without evidence by explicitly disabling/unchecking screenshot capture; the
  Issue body should then lack `## Screenshot`.
- Default bug submission labels are `bug` plus the always-added `bugdrop` label.
- Existing Issue #576 confirms the creator is `neonwatty-bugdrop[bot]`, labels are `bug` and
  `bugdrop`, and the body ends with the BugDrop attribution footer.

An Issues read/write fine-grained token scoped only to `mean-weasel/bugdrop-widget-test` can list/get
Issues and PATCH their state. GitHub documents Issues-read for list/get and Issues-write for update;
write includes read. Source: https://docs.github.com/en/rest/issues/issues

The verifier can assert these returned Issue fields without Contents access:

- `number`, `html_url`, `state`, `title`, raw `body`, `labels[].name`, `user.login`, `created_at`.

It can close by PATCHing `state=closed` and `state_reason=not_planned`. It must exclude objects with a
`pull_request` key because GitHub's Issues endpoints also return pull requests.

## Marker, duplicate, and cleanup gaps to close

The current test has no marker. A safe marker should include `GITHUB_RUN_ID`,
`GITHUB_RUN_ATTEMPT`, and the full merge-group `GITHUB_SHA`, appear in both exact title content and
description/body, and be unique to one canary attempt. GitHub documents `GITHUB_SHA` for
`merge_group` as the merge-group SHA:
https://docs.github.com/en/enterprise-cloud@latest/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group

Readback and cleanup must enumerate repository Issues with `state=all`, paginate, exclude pull
requests, and filter exact marker content locally. GitHub search indexing is too weak for cleanup
after a lost response. The immediate cleanup must be a separate workflow step with `if: always()`;
Playwright hooks or a single returned Issue number are insufficient. The cleanup step must close all
matches, not merely the first, then paginate again and fail if any remain open.

Hard cancellation or GitHub outage can prevent any same-run cleanup. The plan must explicitly choose
additional defense, such as a stale-marker sweep after acquiring the same preview lock on the next
merge-group run, while documenting that no remote system can provide an absolute synchronous
guarantee during total external failure.

## Candidate implementation/test surfaces

- `.github/workflows/ci.yml`: local-gate dependencies, concurrency critical section, SHA deploy,
  canary invocation, independent verification, `if: always()` cleanup, artifacts.
- `.github/workflows/live-tests.yml`: ensure scheduled/manual/production live suites contain no real
  unmanaged feedback submission.
- `playwright.config.ts`: dedicated nonmatching canary project with explicit zero retries.
- `e2e/widget.live.spec.ts`: remove or mock the current unmanaged real-Issue test.
- New dedicated canary spec, likely `e2e/widget.issue-canary.spec.ts`: real legacy-widget interaction,
  actual feedback response number/URL/build-SHA assertions, screenshot disabled.
- `src/types.ts` and `src/routes/api.ts`: optional build SHA and actual-response identity header.
- `test/api.test.ts`: health/header presence and absence compatibility tests.
- New scripts/modules under `scripts/` plus focused unit tests: marker construction, paginated
  discovery, exact verification, duplicate detection, close-all, ambiguous close readback, stale
  cleanup.
- `test/ci-workflow-contract.test.sh`: dependency, concurrency, merge-group-only invocation,
  retry-zero, token-boundary, and `if: always()` cleanup contract checks.
- `Makefile`, only if a named local canary command materially improves safe invocation.
- Documentation covering secret scope, setup, cleanup semantics, manual recovery, and local tests
  that do not create real Issues.

## Verification commands and proof targets

- Focused unit tests for Worker build-SHA behavior and canary helper logic.
- `bash test/ci-workflow-contract.test.sh` for static workflow invariants.
- `npm run validate` and relevant local Playwright suites with feedback mocked.
- A negative fixture for each strongest failure mode: wrong widget bytes, wrong Worker SHA, duplicate
  matches, response lost after creation, one close failure, leaked open match, and preview-lock
  omission.
- The only real-Issue proof runs in `merge_group`; local and PR tests must not have the credential or
  make a real feedback POST.

## Judge decisions required

1. Workflow-level serialization versus restructuring preview jobs into one critical-section job,
   including how to preserve required check names.
2. Whether `queue: max` is required to prevent required merge-group runs from canceling while
   pending; current GitHub docs say it is.
3. Exact build-SHA transport: direct Worker variable/header versus version tag plus metadata.
4. Whether health also exposes SHA in addition to the actual response header.
5. Helper architecture: testable Node module/CLI versus workflow shell, and how secrets stay out of
   browser/traces.
6. Hard-cancellation recovery: next-run stale sweep only, or an additional scheduled janitor.
7. Whether all local gates includes the local Radix matrix; conservative reading says yes.
8. Exact title/body marker format and whether attribution means both bot author and footer.
9. Whether the existing fixed preview Vercel alias needs any additional configuration assertion
   beyond actual DOM script origin and byte hash.
