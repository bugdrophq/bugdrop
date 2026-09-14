# Production Heartbeat Operations

The `Production Heartbeat` workflow exercises the real production widget, creates one synthetic
Issue in a dedicated test repository, independently verifies it, closes every run-marker match,
proves zero open production-prefix Issues, and reconciles one incident in the repository running the
workflow. During migration preparation, the canonical BugDrop installation uses
`mean-weasel/bugdrop-widget-test` for synthetic Issues. It accepts both `mean-weasel/bugdrop` and
`bugdrophq/bugdrop` as the canonical workflow repository so the core repository can move first while
the test target remains unchanged.

Scheduled events are inert unless `BUGDROP_PRODUCTION_HEARTBEAT_MODE` is exactly `daily` or
`four-hour`. An unset value, `manual`, or an unknown value skips both cron entries. GitHub cron
timing is approximate.

The workflow is not automatically configured for a fork or private copy. Built-in service origins
and repository defaults are accepted only when `GITHUB_REPOSITORY` is `mean-weasel/bugdrop` or
`bugdrophq/bugdrop`. Every other repository must provide a complete self-hosted configuration. This
prevents a partially configured fork from accidentally exercising the canonical BugDrop service.

## Prerequisites

- Protect the `production` GitHub environment with required reviewers for release jobs. The heartbeat
  deliberately does not enter that approval-gated environment, because scheduled monitoring must run
  unattended; it uses only the narrowly scoped repository secrets listed below.
- Install a dedicated monitoring-only GitHub App on exactly the active test repository. During the
  organization move, that is either `mean-weasel/bugdrop-widget-test` or
  `bugdrophq/bugdrop-widget-test`. The App must have only metadata read and Issues write, no webhook
  subscriptions, and no installation access to other repositories after the cutover is proven.
- Set its numeric App ID as the repository variable `BUGDROP_HEARTBEAT_MONITOR_APP_ID` and its
  private key as the repository Actions secret
  `BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY`.
- Configure `VERCEL_AUTOMATION_BYPASS_SECRET` only if the fixed production venue requires it.
- For the canonical installation, configure `MONITOR_HEARTBEAT_SECRET` only after the compatible
  receiver at `https://bugdrop.dev/api/monitor/heartbeat` is deployed. The workflow exposes the
  secret exclusively to the final best-effort outcome sender step.
- Confirm production health reports `environment=production` and a full lowercase 40-character
  `buildSha` before authorization.
- Leave `GITHUB_TOKEN` at declared job permissions. Only the incident job receives `issues: write`,
  and that token is step-scoped and never reaches Playwright.

Record App ownership, installation scope, and private-key rotation ownership privately. Rotate the
private key under dual control, update the Actions secret without reading it back, validate the next
installation token, then revoke the superseded key. Never print or place a private key or
installation token in a log or artifact.

## Self-hosted and private repositories

Self-hosting the application does not require the heartbeat. The heartbeat is an optional
operational safeguard that must be deliberately configured after the production deployment works.
The repository containing this workflow may be private, and the synthetic test repository should
normally be a separate private repository.

Before configuration:

1. Enable GitHub Actions in the self-hosted repository. The workflow file must be on the default
   branch for scheduled events to run. GitHub disables Actions workflows in a new fork by default.
2. Create a dedicated synthetic test repository with Issues enabled and create the labels the Worker
   will apply, normally `bug` and `bugdrop`. Do not use the operational repository or a repository
   containing real user Issues.
3. Install the self-hosted BugDrop GitHub App on that test repository. Record its Issue author login,
   normally `<app-slug>[bot]`.
4. Deploy a fixed HTTPS test venue whose page loads
   `https://<your-worker-origin>/widget.js` and targets the synthetic test repository. If the Worker
   uses `AUTH_TOKEN_SECRET` or `AUTH_TOKEN_ADDITIONAL_SECRETS`, the venue must also configure
   `data-auth-token-provider` to return a valid short-lived token during the automated run. Keep the
   signing secret server-side and protect the provider endpoint with the venue's access control; see
   [Requiring Host-App Auth Tokens](../SELF_HOSTING.md#requiring-host-app-auth-tokens-recommended-for-private-apps).
5. Confirm `https://<your-worker-origin>/api/health` reports `environment=production` and a full
   lowercase 40-character `buildSha`. The deployment process must set `ENVIRONMENT=production` and
   `BUILD_SHA` to the deployed source commit.
6. Provision a separate monitoring App for the self-hosted installation and provide the complete
   self-hosted heartbeat configuration before enabling the workflow. The token-mint owner and
   repository are derived from that validated configuration.
7. Confirm the self-hosted repository permits the GitHub-maintained Actions used by the workflow.
   Private repositories consume the account's applicable GitHub Actions allowance.
8. Replace and review both canonical receiver endpoints before configuring
   `MONITOR_HEARTBEAT_SECRET`: the normal sender defaults to
   `https://bugdrop.dev/api/monitor/heartbeat`, and the checkout-independent fallback embeds the same
   canonical endpoint. The checked-in workflow does not wire a receiver URL variable, so setting a
   self-hosted receiver secret without both code changes would send it to the canonical BugDrop
   receiver instead of the self-hosted receiver.

Set these repository variables under **Settings > Secrets and variables > Actions > Variables**:

| Variable | Required | Value |
| --- | --- | --- |
| `BUGDROP_HEARTBEAT_WIDGET_ORIGIN` | Yes | HTTPS origin of the production Worker, without a path |
| `BUGDROP_HEARTBEAT_VENUE_ORIGIN` | Yes | HTTPS origin of the fixed test venue, without a path |
| `BUGDROP_HEARTBEAT_TEST_REPO` | Yes | Dedicated synthetic repository as `owner/repository` |
| `BUGDROP_HEARTBEAT_EXPECTED_AUTHOR` | Yes | GitHub App Issue author, normally `<app-slug>[bot]` |
| `BUGDROP_HEARTBEAT_EXPECTED_LABELS` | No | Exact comma-separated labels including `bugdrop`; defaults to `bug,bugdrop` |
| `BUGDROP_PRODUCTION_HEARTBEAT_MODE` | Later | Leave unset until staged activation |
| `BUGDROP_HEARTBEAT_MONITOR_APP_ID` | Yes | Numeric App ID of the dedicated monitoring-only GitHub App |

For the canonical migration only, leave `BUGDROP_TEST_REPOSITORY` unset while the test repository
remains under `mean-weasel`. Immediately after that repository transfers, set it to
`bugdrophq/bugdrop-widget-test`. The same allowlisted variable switches the production heartbeat,
merge-queue preview canary, and scheduled janitor together; it cannot change origins, expected
authors, labels, or self-hosted defaults.
Do not combine `BUGDROP_TEST_REPOSITORY` with any `BUGDROP_HEARTBEAT_*` override; configuration
rejects that mixed mode before network access.

Set `BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY` as a repository Actions secret. It belongs only to the
monitoring App and is separate from the production BugDrop App and every Worker credential. The
workflow uses the pinned `actions/create-github-app-token` action to mint one short-lived
installation token for the configured test repository with Issues write. Only the preflight,
verify, evidence, cleanup, and sweep helpers consume its masked action-step `token` output. The token
is not promoted to job or workflow outputs and never reaches Playwright, a browser page, runtime
code, logs, or diagnostics artifacts. At completion, the action's default post step attempts to
DELETE the installation token and warns if revocation fails; the token's short expiry bounds that
fallback, so operators must not treat job completion as guaranteed revocation.
Set `VERCEL_AUTOMATION_BYPASS_SECRET` only when the chosen venue requires it. Repository secrets do
not copy with a fork and should never be exposed to untrusted pull-request workflows.

Keep `BUGDROP_PRODUCTION_HEARTBEAT_MODE` set to `manual` if App authentication fails. Retain the
legacy `BUGDROP_CANARY_GITHUB_TOKEN` repository secret, without binding it anywhere in the new
workflow, until an authorized App-backed staged run completes verification, cleanup, rollback proof,
and Judge approval. The rollback is to revert the App-integration commit to reviewed head
`808f0fbd58a7951627ffb08e02ae203e5a316132`, restoring that head's PAT bindings. Never bind the App
installation token and legacy PAT concurrently, and do not delete either credential merely to
perform rollback. Retire the legacy PAT only after the staged evidence and approval authorize it.

Incidents are opened in the repository running the workflow using its scoped `GITHUB_TOKEN`; no
separate incident token or repository variable is required. Keep Issues enabled in that repository.
For a private installation, the incident, workflow logs, and seven-day diagnostics artifacts remain
visible only to users who can access that repository. This GitHub Issue is not independent paging:
a GitHub outage can disrupt both the transaction and the incident channel.

## Staged activation

Publication, dispatch, Issue mutation, and repository-variable changes require explicit operator
authorization.

1. Keep the mode unset or `manual`. Dispatch with `controlled_failure=false`. Retain the run URL,
   production environment/build SHA, widget hash, synthetic Issue, independent verification, marker
   cleanup, zero-open sweep, incident result, artifact result, and final conclusion.
2. Dispatch with `controlled_failure=true`. This fails only after cleanup and sweep. Confirm exactly
   one incident opens. Repeat to confirm a recurrence comment. Close it manually only for the
   authorized reopen exercise, repeat the controlled failure, then run normally and confirm a
   recovery comment plus closure.
3. Set the mode to `daily`; observe the staggered `17 2 * * *` UTC trigger through the agreed soak.
4. Replace the mode with `four-hour`; this disables the daily trigger and enables only
   `47 1/4 * * *` UTC, for approximately six runs per day.

Do not rerun merely to obtain green status. Diagnose the first failing stage and confirm both cleanup
passes and the incident transition before another run.

## Failure, rollback, and recovery

To disable schedules, unset the mode or set it to `manual`; this does not cancel an active run. The
production-only lock never cancels active work. If a run is interrupted, the next authorized run
begins with a production-prefix preflight and ends with another production sweep. Preview uses a
different prefix, marker namespace, workflow owner, and lock.

The conclusion fails unless transaction stages, authoritative verified evidence, marker cleanup,
prefix sweep, artifact handling, and incident reconciliation succeed. Valid delivery-failure and
inconclusive evidence still flows to incident reconciliation and the receiver before the final step
reports failure. Before upload, the summary writes a fixed-schema, token-free JSON file containing
only normalized stage outcomes and the aggregate boolean. It writes to a
run-specific temporary file, validates the exact schema and allowed outcome values, then atomically
renames it before publishing summary outputs. Artifact staging independently requires non-empty,
schema-valid diagnostics and never copies Playwright results, markers, Issue data, or browser
payloads; upload uses `if-no-files-found: error`. Summary, staging, and upload outcomes independently feed incident
selection and the final conclusion. Cleanup never trusts the browser result. A missing attempt
sentinel skips marker cleanup safely, while the final prefix sweep remains mandatory.

After Playwright validates and forwards its first feedback POST, it writes a private evidence signal
separate from the earlier cleanup-start sentinel. Only that POST proof plus bounded successful
GitHub reads can produce one authoritative delivery evidence record:
`issue_verified`, `issue_absent`, `issue_duplicate`, or `issue_contract_invalid`. Network, selected
GitHub 5xx, rate-limit, authorization, browser, and classification ambiguity remain inconclusive.
Confirmed delivery failure outranks later cleanup, sweep, artifact, or incident failure; verified
delivery likewise remains verified. The stable operational incident closes only for a wholly
healthy verified run. Inconclusive runs create, comment on, or reopen the native incident with
enum-only wording, but never close or relabel an active confirmed-failure incident.

The final step sends one authenticated v1 report with exactly `schemaVersion`, `outcome`,
`reasonCode`, and canonical millisecond UTC `observedAt`. It validates HTTP 200, `Cache-Control:
no-store`, and the receiver's exact response schema. Network, timeout, and HTTP 500, 502, 503, or
504 failures receive at most two bounded retries using identical bytes, headers, timestamp, and
heartbeat ID; deterministic and response-contract failures are never retried. The monitoring secret,
request body, and
receiver response never enter diagnostics, artifacts, summaries, native incident comments, or
classifier outputs. Sender failure is visible but cannot rewrite the workflow's authoritative
conclusion.

The incident channel is GitHub itself. A GitHub outage can affect both the monitored transaction and
incident delivery, so this is deduplicated visibility, not independent paging. External paging is a
separate future control.

GitHub API reads use three total attempts with one- and two-second backoffs only for network errors
and HTTP 500, 502, 503, or 504. Rate limits, authorization failures, deterministic 4xx responses,
and malformed successful JSON fail immediately with sanitized categories. Synthetic prefix scans
request open Issues only, while exact marker cleanup and the stable heartbeat incident retain
`state=all` history. POST/PATCH/comment operations are never placed in the GET retry path; native
incident mutations remain one mutation followed only by exact reconciliation after ambiguity.

## Local, nonmutating checks

```bash
bash test/production-heartbeat-workflow-contract.test.sh
npx vitest run test/githubHeartbeatIncident.test.ts test/githubIssueCanaryProfiles.test.ts
npx playwright test e2e/widget.issue-canary.spec.ts --project=chromium-issue-canary --list
```

Never run the Issue canary locally: listing it is nonmutating; executing it is not.
