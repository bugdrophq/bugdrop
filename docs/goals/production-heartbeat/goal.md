# Production Heartbeat

## Objective

Implement a production synthetic heartbeat that runs approximately every four hours, exercises the
real production widget through GitHub Issue creation and verified cleanup, and manages one
deduplicated incident Issue when the heartbeat fails. Preserve the merge-triggered preview canary as
the authoritative mutating preview proof and retain only lightweight scheduled preview health and
janitor coverage.

## Original Request

Create a detailed GoalBuddy implementation plan for the agreed four-hour production heartbeat and
decide whether preview should receive the same scheduled mutating heartbeat.

## Intake Summary

- Input shape: `existing_plan`
- Audience: BugDrop maintainers and operators
- Authority: `approved` for local planning and implementation; remote publishing, manual production
  mutation, and schedule activation still require exact operator authorization at the live-proof gate
- Proof type: `demo`
- Completion proof: local contract and behavioral checks pass; an authorized production run creates
  exactly one synthetic Issue, independently verifies it, closes it, proves zero stale heartbeat
  Issues, and demonstrates one incident Issue through failure, recurrence, and recovery
- Goal oracle: the receipt-backed production Issue and incident lifecycles, not workflow syntax or
  mocked success alone
- Likely misfire: shipping a green-looking scheduled workflow without proving real production
  submission, unconditional cleanup, final failure aggregation, and incident recovery
- Blind spots considered: GitHub schedule delay; GitHub being shared by both the monitored transaction
  and incident channel; production/preview sweep collisions; mixed deployment identity; alert flapping;
  cleanup failure hidden by continued execution; existing unrelated dirty work
- Existing plan facts: dedicated production workflow; staggered four-hour schedule; fixed production
  origins; production deployment identity; strict preview and production canary profiles; distinct
  marker prefixes and concurrency locks; cleanup independent of Playwright; deduplicated incident
  management; daily nonmutating preview health and janitor; contract/unit/browser validation; staged
  manual-to-daily-to-four-hour rollout; all execution occurs in the fresh
  `codex/production-heartbeat` worktree created from `origin/main` at
  `75c0e5c7009e804c6d9e03f4886188d4f7b2094d`

## Goal Oracle

The oracle for this goal is:

`One authorized production run drives the real widget to exactly one independently verified synthetic
Issue, closes it with a zero-open prefix sweep, and a controlled post-cleanup failure plus recovery
drives exactly one BugDrop incident Issue through open/update-or-reopen/close, while the merge-queue
preview canary contract remains unchanged.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice,
or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps
receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Complete the full local implementation in the largest safe vertical slices, adversarially verify the
workflow and credential boundaries, then stop at the exact authorization boundary for remote
publication and live production mutation if approval has not yet been granted. After authorization,
capture the full live oracle and enable the staged schedule. Do not stop merely because one local
slice passes.

## Existing Plan To Preserve And Validate

1. Create a dedicated production-heartbeat workflow with manual dispatch, a staggered four-hour cron,
   its own non-cancelling concurrency lock, explicit permissions, bounded timeout, and failure
   artifacts.
2. Add a trustworthy production deployment identity and verify consistent environment, Worker SHA,
   widget origin, venue origin, and feedback response identity.
3. Share only the canary transaction engine. Keep strict allowlisted preview and production entry
   profiles so generalization cannot weaken preview safeguards.
4. Use separate preview and production marker/title prefixes. A workflow may never sweep the other
   environment's in-flight Issues.
5. Keep GitHub read/close credentials out of Playwright. Verification and cleanup independently
   rediscover the Issue, and cleanup does not trust the browser result file.
6. Always attempt marker cleanup and a final reserved-prefix sweep. Aggregate every stage afterward
   so cleanup or alert failures cannot be masked by `continue-on-error` behavior.
7. Manage one stable incident Issue directly through GitHub Actions in the BugDrop repository:
   open on first failure, update or reopen on recurrence, and comment plus close on the next complete
   success.
8. Do not add a four-hour mutating preview heartbeat. Keep the exact-byte real-Issue preview canary
   merge-triggered and use a daily locked nonmutating preview health/janitor job.
9. Prove marker validation, singleton verification, pagination, stale cleanup, incident idempotency,
   recurrence, recovery, token redaction, workflow ownership, token scoping, unconditional cleanup,
   fail-closed aggregation, and prefix isolation through local tests and workflow contracts.
10. Roll out through an authorized manual live run, a controlled failure/recovery exercise, a short
    daily soak, and then the four-hour schedule.

## Non-Negotiable Constraints

- Preserve existing user work and unrelated dirty files.
- Conduct all implementation and verification in
  `/Users/neonwatty/Desktop/bugdrop-production-heartbeat` on branch
  `codex/production-heartbeat`, whose starting commit must equal the freshly fetched `origin/main`.
- Do not implement in or copy unrelated changes from `/Users/neonwatty/Desktop/bugdrop`.
- Do not run the real Issue canary locally.
- Do not expose verification or cleanup credentials to Playwright, job-wide environments, logs, or
  artifacts.
- Do not alert through BugDrop itself; the incident path must be independent of the system under test.
- Keep production synthetic Issues in `mean-weasel/bugdrop-widget-test`; keep incident Issues in the
  BugDrop repository.
- Never allow production and preview cleanup prefixes or concurrency ownership to overlap.
- A cleanup, sweep, incident-update, or final-aggregation failure is a heartbeat failure.
- Do not silently weaken exact preview deployment identity or the merge queue's required status
  bridge.
- Treat GitHub Actions cron as approximate. External paging is outside this tranche and must remain an
  explicit operational limitation.
- Do not push, dispatch a workflow, create or close live Issues, or enable the schedule without exact
  operator authorization at the live-proof boundary.
- Apply the repository Burden Of Proof: identify the strongest realistic failure mode and directly try
  to disprove the implementation before completion.

## Verification Inventory

The execution PM must validate the exact commands against current repository state before assigning
them to Workers. Expected gate families include:

- `bash test/ci-workflow-contract.test.sh`
- `npm run check:actions-node24`
- focused Vitest coverage for canary and incident helpers
- intercepted or list-only Playwright coverage for production and preview canary profiles
- `make check`
- `make test`
- the repository's relevant widget build and E2E definition checks

Pre-existing red health checks are not automatically owned by this goal. Record any such failures and
prove whether the heartbeat diff caused them.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asks to start `/goal` and a safe
Worker task can be activated. Do not stop after a single verified Worker package while another safe
local package remains.

If exact authorization for publishing or live production mutation is the only remaining blocker,
preserve the required reply in the blocked receipt, set the goal to the valid terminal approval-wait
shape, and ask once.

## Slice Sizing

The intended slices are vertical outcomes rather than file-by-file edits:

1. Production-safe deployment identity and synthetic transaction primitives, preserving preview.
2. Scheduled workflow, incident lifecycle, cleanup aggregation, contracts, and operations guidance.
3. Adversarial local audit and any bounded remediation it discovers.
4. Authorized live proof and staged activation.

The active Judge may combine or revise these only when repository evidence shows a safer or more
useful boundary.

## Board Health

The PM owns board health. If the board looks stale, misleading, offline, or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.2/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/production-heartbeat
```

Machine truth lives at `docs/goals/production-heartbeat/state.yaml`. If this charter and the board
disagree about status, active task, receipts, or completion, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/production-heartbeat/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract.
2. Read `state.yaml` and work only on its active task.
3. Preserve the intake, existing-plan facts, authority boundaries, and oracle.
4. Dispatch the role named on the task and record a durable receipt.
5. Activate the next largest safe reversible package when work remains.
6. Review only at phase, risk, rejected-verification, ambiguity, and final-completion boundaries.
7. Run the bundled stop checker before ending the host turn.
8. Finish only after a final audit maps current evidence to the oracle and records
   `full_outcome_complete: true`, or after GoalBuddy validates an exact approval wait.
