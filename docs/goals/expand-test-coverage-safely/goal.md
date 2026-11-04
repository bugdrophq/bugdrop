# Expand BugDrop Test Coverage Safely

## Objective

Increase BugDrop's risk-weighted automated test coverage in successive reversible packages, beginning with GitHub authentication and persistence boundaries, while preserving real-browser behavior and establishing trustworthy component-level Codecov reporting.

## Original Request

"In a fresh work tree off main GitHub make a detailed implementation plan using GoalBuddyPrep for expanding our test coverage safely and efficiently."

## Intake Summary

- Input shape: `existing_plan`
- Audience: BugDrop maintainers and contributors
- Authority: `requested`
- Proof type: `test`
- Completion proof: All required repository gates and targeted real-browser tests pass; current-main coverage improves from the recorded baseline without excluding difficult files or weakening Codecov partial handling; direct tests prove the critical GitHub/JWT, submission, capture/privacy, and interaction boundaries; a final Judge maps receipts to the oracle.
- Goal oracle: A commit-pinned coverage comparison plus passing unit, type, lint, build, and Playwright gates demonstrates at least 72% Vitest line coverage and 67% branch coverage, closes the named critical zero-coverage gaps, and shows no behavioral regression or coverage gaming.
- Likely misfire: Raising the aggregate percentage with brittle jsdom/canvas mocks, broad exclusions, or script-heavy tests while GitHub credentials, submission, capture cleanup, and real pointer/canvas behavior remain weak.
- Blind spots considered: Codecov treats partial lines more strictly than Vitest; Playwright currently does not contribute coverage; subprocess scripts can be false negatives; release tooling masks weaker product coverage; source refactors change the denominator; fork and merge-queue reporting must remain safe.
- Existing plan facts: Two independent audits prioritized GitHub/JWT first, followed by submission/form lifecycle, privacy/capture leaf modules, interaction primitives, selective bootstrap seam extraction, and branch-hardening. Preserve strict Codecov partial handling, keep reporting informational until representative PR/merge-queue/public-fork evidence exists, and use targeted Playwright tests as the browser oracle.

## Goal Oracle

The oracle for this goal is:

`From a commit-pinned current-main baseline of Vitest 64.23% lines / 63.52% branches and Codecov 55.25%, receipts show risk-weighted direct tests, Vitest >=72% lines and >=67% branches without exclusions or weakened partial semantics, all repository gates pass, targeted Playwright tests preserve real-browser behavior, and a final Judge records full_outcome_complete: true.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge/PM audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Validate the audit-derived plan against fresh `origin/main`, then complete successive safe test packages: direct GitHub/JWT contracts; submission and form lifecycle; privacy/capture leaves; interaction primitives with real-browser proof; trustworthy component reporting; and only then a bounded bootstrap-seam extraction or branch-hardening package if needed to meet the oracle. Continue until the full tranche is proven complete.

## Implementation Roadmap

### Phase 0: Validate truth before writing

The active Judge reproduces both native Vitest and strict Codecov semantics on the execution commit, inventories existing tests and measurement blind spots, and converts the first Worker card from planned filenames to verified paths. The baseline receipt must include commit SHA, totals, component totals, and an explanation of partial lines. No threshold is tightened in this phase.

### Phase 1: Secure the external GitHub boundary

Add direct cryptographic and HTTP-contract tests for `src/lib/jwt.ts` and `src/lib/github.ts`. Use ephemeral RSA keys, frozen time, decoded claim assertions, actual signature verification, exact fetch contracts, installation-token failure cases, public/private repository behavior, issue-label `422` classification, branch creation, concurrent first uploads, collision handling, sanitization, and upload failures. Expected gain: roughly 1.3–1.6 native line points, with a larger risk reduction than the number suggests.

### Phase 2: Submission lifecycle and privacy/capture leaves

Test submission payload/authentication/redaction, malformed responses, duplicate-submit prevention, cancellation, retries, disposal, and reset. Then cover console serialization/redaction/bounds, capture rejection and surface validation, timeout/canvas failures, guaranteed track cleanup, screenshot-option decisions, and annotation modal teardown. Expected cumulative gain after Phase 2: roughly 3–4 native line points over baseline.

### Phase 3: Interaction primitives with browser proof

Add focused state-machine tests for picker target resolution, desktop/touch/coarse-pointer paths, cancellation and listener cleanup, area normalization/clamping/minimum size, annotation scaling/undo/outside-canvas completion, and teardown. DOM/canvas mocks may prove state transitions only; existing Playwright tests remain the behavioral oracle and at least one real output or pixel assertion must cover annotation/capture changes. Expected cumulative native line coverage: approximately 71–72%.

### Phase 4: Make reporting representative

After a read-only topology Scout and policy Judge, expose separate Codecov components for widget, backend, and scripts. Preserve partials-as-misses. If browser instrumentation produces correct source maps without duplicate bundle paths or unsafe fork credentials, upload it under a distinct `e2e` flag rather than blending it with `unit`. Keep statuses informational until representative PR, merge-queue, docs-only, and public-fork evidence exists.

### Phase 5: Conditional structural and branch hardening

Only if the oracle is still unmet and a Judge finds behaviorally useful seams, extract a small coherent portion of the widget bootstrap—configuration parsing, metadata/redaction, persistence, upload validation, trigger position, or payload construction—behind direct tests. Do not build a monolithic jsdom import harness. Then target meaningful partial branches in API/structured-feedback routes and release publication code, prioritizing malformed external responses, idempotency, concurrency, and ambiguous state. These tasks may be skipped with a Judge receipt if they would add more refactor risk than test value.

### Phase 6: Full proof and threshold recommendation

Run the complete repository gate, full browser suite, coverage report parsing, and adversarial disproof checks. The final Judge verifies no exclusions, assertion-light execution tests, weakened Codecov settings, or script-heavy denominator masking were used. It recommends—but does not externally apply—future blocking thresholds based on stable evidence.

## Non-Negotiable Constraints

- Follow `AGENTS.md` and `CLAUDE.md`, including fresh-main hygiene and burden of proof.
- Begin from `origin/main` commit `e0c5ece8edbbe5692cb5c540555fe6f3154130a7`; rebase or recreate from newer `origin/main` before implementation if main advances materially.
- Do not weaken production behavior, skip hard files, add coverage exclusions, set Codecov partials as hits, or write assertion-light execution tests merely to increase a percentage.
- Preserve existing Playwright coverage and require targeted real-browser proof for pointer, canvas, capture, Shadow DOM, mobile, or screenshot behavior.
- Keep changes reversible and split production refactors from pure test additions when practical.
- Do not install apps, create accounts or secrets, change branch protection, push, open a PR, or mutate external services without explicit owner approval.
- Use current repository pinning, CI event, fork, docs-only, merge-queue, and required-check policies as constraints for any Codecov reporting changes.
- Run `codex-pr-review-toolkit:review-pull-request` against the base before any pull request is merged.

## Verification Policy

Package-level commands are narrow for fast feedback, followed by the full oracle commands at phase boundaries:

```bash
npm test -- --coverage
npm run lint
npm run format:check
npm run typecheck
npm run build:widget
npm run test:e2e
make check
```

Coverage evidence must parse `coverage/coverage-summary.json` and `coverage/lcov.info`, record the commit SHA, compare line and branch deltas by product component, and retain Codecov's hit/partial/miss interpretation. A green upload step alone is not proof that Codecov processed the report.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if the user asks to start the execution goal and a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe local follow-up work. Advance the board to the next highest-leverage safe Worker package unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

If an exact human approval phrase is the only remaining blocker and no safe local work remains, preserve it in the blocked receipt, set `waiting_for_user_approval: true`, set the goal blocked, and clear the active task.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. Each Worker should finish a coherent behavioral boundary, not a single helper or percentage-only microtask. Judge reviews occur at security, browser-behavior, measurement-policy, and final boundaries.

## Board Health

The PM owns board health. If the board looks stale or inconsistent, run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/expand-test-coverage-safely
```

## Canonical Board

Machine truth lives at:

`docs/goals/expand-test-coverage-safely/state.yaml`

## Run Command

```text
Codex: /goal Follow docs/goals/expand-test-coverage-safely/goal.md.
Claude Code: /goalbuddy Follow docs/goals/expand-test-coverage-safely/goal.md.
```
