# Weekly Manual Release Cadence

## Objective

Complete the first implementation tranche after the production safety freeze: use the already-open documentation-only planning PR as the post-freeze canary, prove that merging it cannot start a production release, create a fresh worktree from the resulting `main`, and implement the read-only deterministic planning and identity engine from Work Package 1.

This tranche must not wire a production workflow, dispatch the freeze workflow, deploy production, create or modify tags or GitHub Releases, change repository settings, or use production credentials.

## Original Request

Move BugDrop away from push-triggered semantic-release toward a controlled weekly manual release process. After approving the specification and detailed implementation plan, begin the migration, merge the production safety freeze through the queue, and prepare the next step.

## Intake Summary

- Input shape: `existing_plan`
- Audience: BugDrop maintainers and release implementers.
- Authority: `approved` for the bounded repository work and canary merge described by this tranche; production and operator cutover remain unauthorized.
- Proof type: `test` plus GitHub audit evidence.
- Completion proof: Planning PR #262 merges through the queue as a documentation-only canary with zero production-release runs; a fresh worktree starts from that exact `main`; the Work Package 1 planning/identity engine passes its focused adversarial tests and repository gates; and a final Judge audit maps the result to the approved plan without finding production side effects.
- Goal oracle: GitHub shows the freeze still active and no production workflow run for the canary merge, while deterministic WP1 tests prove immutable controller/candidate identity, SemVer/frontier modeling, completed/partial-plan handling, canonical identities, and stale revalidation.
- Likely misfire: Treating the already-observed freeze merge as the required documentation-only canary, implementing only happy-path SemVer calculation, trusting candidate-controlled release code, using mutable or abbreviated SHAs, reading nondeterministic runtime values inside identities, or beginning workflow/deployment wiring before the engine is reviewed.
- Blind spots considered: PR #262 is still open and must land before its board is available on `main`; WP1 must operate on older main ancestors that lack release helpers; GitHub tags, Releases, drafts, and ancestry can disagree; network uncertainty must fail closed; same-version retries must distinguish complete, partial, changed, and contained plans; production remains intentionally disabled.
- Existing plan facts: WP0 merged as PR #263 at `57317afd387f057706ca8e36383957a774218bba`. The approved implementation plan requires a documentation-only post-freeze canary before engine work and defines exact WP1 files, cases, verification, rollback, and acceptance-criterion coverage.

## Goal Oracle

The oracle for this tranche is:

`PR #262 merges through the queue without any Production Release run; the freeze remains dispatch-only and read-only on main; WP1 is implemented from the post-canary main snapshot entirely within its approved scope; all focused adversarial tests and repository gates pass; and a final skeptical audit finds no production or publication side effect.`

The PM must test this oracle after the canary, after implementation, and at final audit. A green happy path, local-only proof, an open PR, or a plausible data model is not enough.

## Goal Kind

`existing_plan`

## Current Tranche

1. Queue and monitor documentation-only planning PR #262 as the required post-freeze canary.
2. Prove from GitHub Actions and the merge SHA that no production-release workflow started and the freeze remains intact.
3. Create a fresh WP1 worktree and `codex/` branch from the resulting `origin/main`.
4. Revalidate the approved WP1 Worker package against that snapshot.
5. Implement and skeptically review the deterministic planning and identity engine.
6. Stop after a final tranche audit; Work Packages 2–8 require a later continuation.

## Non-Negotiable Constraints

- Never dispatch `.github/workflows/deploy.yml` merely to prove the freeze.
- The canary is PR #262 only; it may contain only `docs/goals/weekly-manual-release-cadence/**`.
- If any production-release run starts for the canary merge, cancel it if possible, preserve evidence, and stop before WP1.
- Start WP1 from the exact post-canary `origin/main`, not the stale planning or WP0 branches.
- Keep production disabled. Do not edit release workflows, live-test/Discord workflows, Wrangler configuration, product deployment code, secrets, environments, repository variables, tags, Releases, or Cloudflare state.
- WP1 may change only the files named by its approved Worker task. Stop if another file is required.
- Controller and candidate identities must be full immutable main-history SHAs; candidate content must not control credentialed release logic.
- Identity code must be deterministic and must not read clocks, run IDs, artifact IDs, or ambient environment values directly.
- Network/API ambiguity must produce a typed non-mutating failure, never an inferred empty state.
- Preserve the manual read-only production freeze throughout this tranche.

## Stop Rule

Stop only when a final Judge or PM audit records that the canary proof and WP1 implementation satisfy this tranche's oracle. Do not continue into static assets, deployment, publication, workflow wiring, dependency cleanup, or operator cutover.

## Slice Sizing

The documentation canary is a small but mandatory safety gate. WP1 is one coherent Worker slice: schemas, canonical identity, planning/frontier/state modeling, fixtures, tests, and repository integration should be implemented and reviewed together rather than split into helper-sized tasks.

## Board Health

The PM owns board health. If the board looks stale, misleading, offline, or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.2/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/weekly-manual-release-cadence
```

## Canonical Board

Machine truth lives at:

`docs/goals/weekly-manual-release-cadence/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/weekly-manual-release-cadence/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract.
2. Read `state.yaml` and work only on its active task.
3. Re-check the tranche oracle, the approved specification/plan, and the production-freeze boundary.
4. Assign PM, Judge, or Worker according to the task card; use only one active task.
5. Record a compact receipt with exact SHAs, commands, checks, and external evidence.
6. Stop immediately on unexpected production activity or required scope expansion.
7. Before completion, run GoalBuddy's stop gate and the final audit task.
