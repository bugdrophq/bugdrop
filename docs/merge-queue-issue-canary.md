# Merge-Queue Issue Canary Operations

The CI workflow runs one real-Issue canary only for GitHub `merge_group` events. It uses the fixed
Vercel preview venue, the shared `bugdrop-preview` Worker, the deployed widget's rendered CTA
variant, and the existing BugDrop GitHub App. Pull requests, manual and reusable live workflows, the
daily live workflow, and local Playwright commands do not select the canary. The Phase 0 run remains
the retained live proof for the legacy form; the routine action was replaced rather than duplicated.

## Safety model

`Deploy Preview` is a single queued critical section. It waits for lint/type checks, unit/build,
both local E2E shards, and all three local Radix browsers. The shared
`bugdrop-shared-preview` lock then covers stale cleanup, build, deployment, every preview consumer,
the one-shot canary, independent verification, current-marker cleanup, and a final prefix sweep.
Active runs are not cancelled and pending merge groups use maximum queueing.

The dependent required check `Live Preview Tests` is a fail-closed bridge: it passes only when the
entire critical section succeeds. Do not change either required check name without coordinating a
repository ruleset change.

The marker format is:

```text
bugdrop-ci-canary:<run-id>:<run-attempt>:<full-merge-group-sha>
```

The preview profile binds the marker's terminal SHA to the exact expected Worker SHA before browser
mutation and again during independent verification. Production uses the disjoint
`bugdrop-production-heartbeat` marker namespace and `[BugDrop production heartbeat]` title prefix;
neither workflow can sweep the other's Issues.

Before the mutating canary, two nonmutating live tests render the inline star review and CTA text
modal from the exact deployed widget bytes. Each intercepts its only feedback POST, prevents it from
reaching the Worker, and asserts the complete normalized Issue draft and explicit-submit behavior.

The canary browser then opens one rendered CTA modal and activates its explicit Submit button once,
sending exactly one screenshot-free structured request. It asserts the discriminator, schema
version, generic Issue draft, server-owned label
boundary, submission ID, request origin, response origin, full Worker build SHA, positive Issue
number, and canonical Issue URL. The server-side verifier independently lists repository Issues,
rejects duplicates and pull requests, and checks the structured section, exact submission marker,
title, labels, author, attribution, system information, and absence of screenshots. Cleanup always
rediscovers by marker; it never depends on the browser result file.

GitHub reads use three total attempts with one- and two-second backoffs, only for network failures
and HTTP 500, 502, 503, or 504. Rate limits, authentication failures, other 4xx responses, and
malformed successful JSON fail immediately with sanitized diagnostic categories. Marker discovery
retains `state=all` for stable history; prefix preflight/final sweeps request only open Issues.
Pagination retries the same URL and appends a page only after a valid response.

## Credential and rotation

The merge-queue/preview canary, scheduled janitor, and production heartbeat use the same dedicated
monitoring-only GitHub App. Its numeric App ID is stored in
`BUGDROP_HEARTBEAT_MONITOR_APP_ID`, its private key in
`BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY`, and its installation is limited to the approved test
repository with metadata read and Issues write. During the organization migration, the approved
identity is either `mean-weasel/bugdrop-widget-test` or `bugdrophq/bugdrop-widget-test`, never both in
one token. A pinned token-mint action creates a short-lived installation token, masks it, and exposes
it only through the action step's `token` output. It is not promoted to job or workflow outputs and
never reaches Playwright, a browser page, runtime code, logs, or artifacts. The default post step
attempts DELETE revocation at completion and warns if that request fails; short-lived expiry bounds
the fallback, so revocation is best-effort rather than guaranteed. The monitoring App is not the
production BugDrop App.

`BUGDROP_TEST_REPOSITORY` is the single cutover variable for the canonical preview canary,
scheduled janitor, and production heartbeat. Leave it unset before the test-repository transfer;
set it to `bugdrophq/bugdrop-widget-test` immediately afterward.

The repository owner is responsible for rotation. Record the expiry in the repository's private
credential inventory, rotate before expiry, and validate replacement access with nonmutating Issue
list/get calls. If policy requires a write exercise, use a separately approved temporary Issue and
close/reopen it outside the canary. Never print or retrieve the secret value during rotation.

For the monitoring App, record the App owner, exact installation repository, and private-key
rotation owner. Add and validate a replacement private key through the Actions secret, then revoke
the superseded key; do not download, log, or retain local key copies beyond the controlled transfer.

Production rollout remains in `manual` mode on App-authentication failure. Keep the unbound legacy
`BUGDROP_CANARY_GITHUB_TOKEN` secret until an authorized App-backed run, cleanup, rollback proof, and
Judge approval complete. Roll back by reverting the App integration to reviewed head
`808f0fbd58a7951627ffb08e02ae203e5a316132`, which restores the prior PAT bindings; never bind or run
the App token and PAT concurrently. Credential deletion is not part of rollback, and PAT retirement
requires separate approval after staged success.

An unavailable, expired, or unapproved token fails preflight before deployment/submission. If it
expires after Issue creation, cleanup fails visibly and the required status bridge remains red.

## Failure and recovery

Same-run cleanup has two independent passes while holding the lock:

1. close every Issue matching the exact run marker;
2. close every open Issue with the reserved `[BugDrop CI canary]` prefix and prove zero remain.

Closing a synthetic Issue is never generically retried. An ambiguous network/selected-5xx first
PATCH, or a 2xx response that does not confirm closure, is followed by bounded exact GET readback.
Only stable proof that the Issue remains open permits one identical second PATCH, followed by final
bounded GET proof. Deterministic failures and rate limits stop immediately.

Hard cancellation can skip both passes. The next merge group performs a locked prefix preflight
before deploying, and the daily scheduled live workflow performs the same prefix sweep under the
same lock. Manual and reusable live runs use unique concurrency groups and remain nonmutating; they
cannot race the preview mutex or run the canary. The daily scheduled live workflow is fixed to the
preview venue and Worker, remains nonmutating, and selects the preview-profile janitor.

When a run fails, do not rerun merely to obtain green status. First inspect the failed step and
confirm whether the final sweep ran. If cancellation prevented cleanup, wait for the next locked
preflight or daily janitor, or initiate a separately authorized recovery workflow change. Do not
close Issues by title search results; the helper paginates the repository Issues API and compares
markers locally.

## Evidence checklist

For the first authorized live merge-group run and any incident, retain:

- workflow run URL, run attempt, and full merge-group SHA;
- completion of every local gate before `Deploy Preview`;
- expected and served widget SHA-256;
- preview health environment and full build SHA;
- actual feedback request/response origins and response build-SHA header;
- canonical Issue number and URL returned to the widget;
- independent structured section/submission marker, title, body, labels, author, no-screenshot, and
  exactly-one readback;
- current-marker closed-state readback and final zero-open prefix sweep;
- the final `Deploy Preview` and `Live Preview Tests` conclusions.

Artifacts are uploaded only after both cleanup passes and must not contain the verification token.
Local workflow checks are nonmutating:

```bash
bash test/ci-workflow-contract.test.sh
npm run check:actions-node24
npx playwright test e2e/widget.issue-canary.spec.ts --project=chromium-issue-canary --list
```

Do not run the canary test itself locally or outside its locked merge-group workflow.
