# T003 architecture decision

## Decision

Approved with the concrete architecture below. The implementation plan may proceed; canary code
must wait for owner approval after the plan-only tranche.

## 1. Preview critical section and local gates

Use one job-level critical section rather than workflow-level serialization.

- The job keeps the required check name `Deploy Preview`.
- It has `needs: [check, test, e2e, radix-e2e]` and runs only for `merge_group`.
- It declares the repository-wide concurrency group `bugdrop-shared-preview`,
  `cancel-in-progress: false`, and `queue: max`.
- The lock is acquired only after local gates complete, so different merge groups may run local
  tests concurrently but cannot overlap any shared-preview activity.
- Inside that same job, run deployment, readiness/SHA proof, current Chromium live tests, live Radix,
  the Chromium/Firefox/WebKit live smoke set, the real-Issue canary, verification, and cleanup. No
  shared-preview consumer remains in a separate parallel job.
- Replace the current `Live Preview Tests` job with an `if: always()` status bridge depending on the
  critical-section job. It must fail unless `needs.<critical-job>.result == 'success'`. This preserves
  both externally required check names without claiming success when the critical section failed or
  was canceled.

Rejected alternatives:

- Workflow-level serialization preserves the current jobs but needlessly serializes all local test
  time and can collide with the ruleset's 60-minute response timeout when five merge groups build.
- Separate job locks cannot span the deploy-to-test handoff.
- Per-SHA Workers change topology and do not satisfy the shared-preview constraint.

Rollback: revert the workflow restructure to the prior three preview jobs. Do not partially retain
deployment in one job and canary cleanup in another.

## 2. Exact build identity

Widget proof remains byte-based:

1. Build `public/widget.js` from the checked-out merge-group tree.
2. Compute its SHA-256.
3. Read the actual venue script URL and require the preview Worker origin.
4. Fetch those exact script bytes and require the expected SHA-256.

Worker proof is additive:

1. Add optional `BUILD_SHA?: string` to `Env`.
2. Deploy preview with `--var BUILD_SHA:$GITHUB_SHA` (properly quoted).
3. Add `buildSha` to preview health output for polling/diagnostics when configured.
4. Add `X-BugDrop-Build-SHA` to Worker API responses when configured.
5. The canary captures the actual POST `/api/feedback` response, requires its URL to be the preview
   Worker endpoint, and requires that response header to equal the full merge-group `GITHUB_SHA`.

Health identity is necessary for readiness but insufficient for the canary. The actual feedback
response header is the authoritative Worker identity proof.

Rollback: omit `BUILD_SHA`; optional behavior leaves existing self-hosted/production responses
unchanged except where explicitly configured.

## 3. Dedicated real-Issue canary

Create a dedicated spec/project whose filename does not match the normal live patterns. Its project
and CLI invocation both specify zero retries, one worker, and Chromium only.

The test:

1. Runs only when the explicit merge-group canary environment is present; otherwise it skips or
   fails closed according to the dedicated command contract.
2. Opens the real fixed Vercel preview venue and uses its deployed legacy script-tag widget.
3. Does not intercept `/api/check` or `/feedback`.
4. Builds a unique marker from `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and full `GITHUB_SHA`.
5. Places the marker in both the exact Issue title and description.
6. Explicitly disables screenshot capture before submission, rather than entering screenshot capture
   and clicking Skip.
7. Starts the response waiter before Submit, captures the one POST response, and requires:
   - preview Worker URL;
   - expected build-SHA response header;
   - success JSON;
   - positive integer Issue number;
   - canonical URL
     `https://github.com/mean-weasel/bugdrop-widget-test/issues/<number>`.

The existing unmanaged `Feedback Submission (Live)` test must no longer make a real POST. Convert it
to a mocked transport/UI assertion or remove it if equivalent mocked coverage already exists. The
normal `chromium-live` project, reusable production workflow, daily schedule, manual dispatch, and
PR/local suites must never match or invoke the new canary.

## 4. Independent Issue verifier

Use a testable Node `.mjs` module/CLI rather than embedding the GitHub logic in workflow shell.

- The secret is a fine-grained token scoped only to `mean-weasel/bugdrop-widget-test` with Issues
  read/write (`write` includes read).
- Supply it only to verifier/cleanup steps. Never set it at job scope, pass it to Playwright, place it
  in browser context, send it to the Worker, or include it in traces/artifacts.
- Issue creation remains exclusively the existing GitHub App path.

Verification enumerates `state=all` repository Issues through REST pagination, excludes entries with
`pull_request`, and filters the exact current marker locally. It does not depend on GitHub search
indexing. It requires exactly one match and asserts:

- response number and canonical URL identify that match;
- exact marker-bearing title and marker in raw body;
- exact label set `bug`, `bugdrop`;
- author `neonwatty-bugdrop[bot]`;
- `## Description`, system-information details, and the BugDrop attribution footer;
- absence of `## Screenshot`;
- open state before cleanup.

The Playwright response number/URL assertion and server-side marker discovery are independent proof
layers. The verifier must not create Issues.

## 5. Duplicate and cleanup contract

Use a reserved format such as:

```text
bugdrop-ci-canary:<GITHUB_RUN_ID>:<GITHUB_RUN_ATTEMPT>:<GITHUB_SHA>
```

The full string appears in title and description. A stable title prefix identifies stale canaries;
the full marker identifies one workflow attempt.

Within the locked critical section:

1. Before deployment, run a preflight stale sweep over all open, non-PR Issues with the reserved
   prefix/marker contract. Close every match and verify none remain.
2. Submit once with Playwright retries disabled.
3. Independently verify exactly one current-marker match. Zero and more-than-one both fail.
4. Run cleanup as a separate `if: always()` workflow step. Enumerate by the current marker even when
   the POST response/output is absent, close every open match, read back ambiguous PATCH results
   before retry, then paginate again and fail if any current-marker match is open.
5. As a final locked defense, sweep all open reserved-prefix canaries and fail if any remain.

Hard cancellation can prevent same-run `always()` steps. Add a daily stale janitor to the already
scheduled live workflow. It uses the same repository-wide concurrency group with queueing so it
cannot close an active merge-group canary, and it performs only server-side stale cleanup—never
Issue creation. The next merge-group preflight remains a second recovery path.

No system can guarantee synchronous closure during a total GitHub/runner outage. The contract is
fail-visible immediate cleanup plus two eventual cleanup paths, not an unprovable exactly-once claim.

## 6. Implementation packages for the plan

### Package A: GitHub canary helper and failure-mode tests

Candidate files:

- `scripts/github-issue-canary.mjs`
- focused test file under `test/`

Cover pagination, PR exclusion, exact marker filtering, duplicate detection, expected field
assertions, close-all behavior, ambiguous close readback, cleanup verification failure, and stale
sweep. Tests inject a fake fetch/API and never use real credentials.

Stop if broader than repository-scoped Issues read/write is required or secrets would enter browser
state.

### Package B: Worker build identity

Candidate files:

- `src/types.ts`
- `src/routes/api.ts`
- `test/api.test.ts`

Cover configured header/health SHA, absent-binding compatibility, and actual feedback success/error
response identity as appropriate.

Stop if the implementation alters existing request bodies, Issue formatting, authentication, label
behavior, or unconfigured deployments.

### Package C: Isolated Playwright canary and removal of unmanaged mutation

Candidate files:

- new dedicated canary spec under `e2e/`
- `e2e/widget.live.spec.ts`
- `playwright.config.ts`
- focused E2E/helper tests if required

Cover exact response number/URL/SHA, explicit screenshot disablement, one submission, zero retries,
and nonmatching normal live projects.

Stop if local, PR, production, scheduled, or manual live invocation can create a real Issue.

### Package D: Workflow critical section, recovery, contracts, and docs

Candidate files:

- `.github/workflows/ci.yml`
- `.github/workflows/live-tests.yml`
- `test/ci-workflow-contract.test.sh`
- `Makefile` only if a safe named command is justified
- relevant CI/testing documentation

Cover local-gate dependencies, exact merge-group condition, single queued mutex, preservation of
required status names, fail-closed bridge, zero-retry invocation, step-scoped token, `if: always()`
cleanup, stale preflight, scheduled lock-coordinated janitor, and absence of real POSTs elsewhere.

Stop if required ruleset mutation, new infrastructure, a new GitHub App, or broader token permission
is necessary.

## 7. Required verification and rollback evidence

- Focused helper and Worker unit tests.
- Static CI workflow contract tests for every concurrency/gating/isolation/cleanup invariant.
- `npm run validate` and relevant local E2E suites with all GitHub traffic mocked.
- Explicit negative tests for wrong widget bytes, wrong actual-response Worker SHA, duplicate matches,
  lost response, one cleanup PATCH failure, ambiguous PATCH success, leaked open match, PR-shaped API
  entries, retry drift, and missing mutex coverage.
- Final implementation evidence must include one successful merge-group canary with its Issue number,
  URL, exact readback assertions, and confirmed closed state, plus a repository query showing no open
  reserved-prefix canary Issues.

Rollback must be atomic at package boundaries. In particular, do not ship real submission without
independent cleanup, and do not remove the unmanaged test until the dedicated canary path and normal
mocked coverage are both present in the same change.

## Deferred/owner boundaries

- Creating and storing the fine-grained secret is an operator action before the implementation can
  run live; the plan must name the secret and exact scope.
- Changing the external GitHub ruleset is not required by this architecture and remains out of
  scope.
- Configurable feedback variants remain entirely out of scope.
