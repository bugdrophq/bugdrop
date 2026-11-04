# Merge-Queue Real-Issue Canary

## Objective

Safely close the clearly attributable historical live-E2E Issues in
`mean-weasel/bugdrop-widget-test`, then produce an implementation-ready, evidence-backed plan for a
merge-group-only canary that creates, verifies, and closes exactly one real Issue through the
deployed preview widget, preview Worker, and existing GitHub App.

## Original Request

> First clean up the old issues in the preview test repo, and then talk about implementing and an
> implementation plan for this, using GoalBuddy prep to keep us on track with granular, grounded
> tasks.

## Intake Summary

- Input shape: `existing_plan`
- Audience: BugDrop maintainers and merge-queue operators
- Authority: `approved`
- Proof type: `artifact`
- Completion proof: the exact historical CI-Issue population is closed without touching unrelated
  Issues, and a reviewed implementation plan maps every canary requirement to current repository
  files, workflow changes, tests, verification commands, rollback boundaries, and failure-mode
  evidence.
- Goal oracle: GitHub API readback shows zero open Issues with the exact legacy automated title and
  unchanged nonmatching Issues; the final Judge accepts the plan only if it prevents leaked or
  duplicate Issues and proves the actual feedback request was handled by the merge-group preview
  widget and Worker.
- Likely misfire: broadly closing human-created test Issues, treating a health response as Worker
  SHA proof, relying on Playwright `afterAll` for cleanup, or beginning implementation before the
  owner reviews the plan.
- Blind spots considered: hard cancellation can bypass in-process cleanup; the shared preview mutex
  must span deploy through cleanup; production scheduled live tests currently share the live spec;
  the verification token must never create Issues or enter browser context; the referenced variants
  design is currently untracked.
- Existing plan facts: use `mean-weasel/bugdrop-widget-test`; merge-group-only; exact deployed widget
  and Worker must match `github.sha`; use the legacy widget with screenshots disabled; require a real
  Issue number and canonical URL; assert title, body, labels, attribution, and unique marker; disable
  retries; close all marker matches after partial failure; serialize the shared preview; wait for all
  local gates; add no storage/services; preserve behavior; do not implement configurable variants.

## Goal Oracle

The oracle for this goal is:

`Independent GitHub API readback proves the exact-title historical cleanup touched no unrelated
Issue, and a final Judge can trace every proposed canary step from merge-group SHA and deployed
assets through one real Issue to independently verified zero-leak cleanup.`

The PM must keep comparing task receipts to this oracle. A plausible plan, a passing happy path, or
an optimistic cleanup summary is insufficient. Completion requires direct GitHub readback plus a
final Judge receipt recording `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

This is a cleanup-and-planning tranche. Close only the exact legacy automated population, inspect
the current live-test and CI architecture, make the key concurrency/SHA/cleanup decisions explicit,
and produce a granular implementation plan. Do not implement the canary in this tranche; execution
requires the owner's review of the plan.

## Non-Negotiable Constraints

- Close only open, non-pull-request Issues whose title is exactly `Live E2E test submission` in
  `mean-weasel/bugdrop-widget-test`; do not close fuzzy matches or any other Issue.
- Inventory and record the exact target numbers before mutation; after mutation, prove zero exact
  matches remain open and that nonmatching Issues were not closed by this work.
- Treat closure as recoverable but material; on ambiguous API failure, read back state before retry.
- Do not expose any GitHub verification token to browser code, traces, Worker configuration, or Issue
  creation.
- Do not edit product, test, workflow, or configuration files during this tranche. The only planned
  repository artifact beyond GoalBuddy control files is the implementation-plan document.
- Preserve existing public behavior and use no new storage, queue, database, or backend service.
- Keep the canary merge-group-only and keep configurable feedback variants out of scope.
- Follow `AGENTS.md` and `CLAUDE.md`, including the burden-of-proof requirement.

## Stop Rule

Stop only after a final audit proves both outcomes of this tranche: the exact legacy population is
closed without collateral mutation, and the implementation plan is grounded enough for an owner to
approve or revise before code changes begin.

Planning is completion for this explicitly plan-only tranche; canary implementation is intentionally
deferred to a separately approved execution tranche.

## Slice Sizing

The cleanup is one bounded Worker package because its high mutation count shares one exact selection
rule and one proof contract. Architecture discovery is one read-only Scout package. Plan authoring is
one coherent Worker package after Judge validation, not a collection of tiny file-by-file tasks.

## Board Health

Machine truth lives in `docs/goals/merge-queue-issue-canary/state.yaml`. If the board looks stale or
misleading, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.2/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/merge-queue-issue-canary
```

## Canonical Board

Machine truth lives at:

`docs/goals/merge-queue-issue-canary/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts,
verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/merge-queue-issue-canary/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract.
2. Read `state.yaml` and work only on its active task.
3. Re-check the exact cleanup selection, authority, oracle, constraints, and likely misfire.
4. Dispatch Scout, Judge, or Worker according to the task card and preserve one active task.
5. Record a compact receipt with commands and direct evidence, then update the board.
6. Continue through the plan-only tranche while safe work remains.
7. Before ending, run the GoalBuddy `check-can-stop.mjs` gate.
8. Finish only when the final Judge maps cleanup and plan evidence to the oracle and records
   `full_outcome_complete: true`.
