# Configurable Feedback Variants — Phase 1

## Objective

Implement and prove the compatibility and structured-headless foundation for configurable BugDrop
feedback variants, ending with one real structured GitHub Issue created from the exact merge-tip
preview, independently verified, closed, and swept without changing legacy-only behavior.

## Original Request

Proceed with Phase 1 of the approved configurable feedback variants design using GoalBuddy and
bounded sub-agents, preserving backwards compatibility and the completed Phase 0 real-Issue canary.

## Intake Summary

- Input shape: `existing_plan`
- Audience: BugDrop maintainers, contributors, and host applications such as Bleep
- Authority: `approved`
- Proof type: `test`
- Completion proof: Historical and current v1 contracts remain green; the published browser types,
  lazy sidecar, structured Worker handler, and headless submission work together; and the locked
  merge-queue canary creates, independently verifies, closes, and sweeps exactly one correctly
  formatted structured Issue from the exact preview Worker.
- Goal oracle: Immutable compatibility fixtures plus local contract suites and a successful
  merge-group structured real-Issue canary with exact widget/Worker identity and zero leaked Issues.
- Likely misfire: Stopping after planning or types, beginning Phase 2 renderers, refactoring the
  legacy wizard, weakening legacy assertions, or multiplying real-Issue canaries per UX/browser.
- Blind spots considered: Historical exact-version assets currently return 404 except the current
  release; `package.json` versioning does not track release tags; old bundles remain coupled to the
  newest Worker; browser-selected variant IDs classify labels but are not authorization; variant and
  legacy traffic share rate limits; live canary publication/merge-queue execution may require
  explicit external authority.
- Existing plan facts: Preserve
  `docs/plans/2026-08-01-configurable-feedback-variants-design.md`; Phase 0 is complete through PR
  #258/run `30724180366`/Issue #578; deliver Worker support before the widget calls it; use a lazy
  sidecar rather than a legacy runtime rewrite; send a field-agnostic Issue draft; defer rendered UX,
  evidence, dynamic registry lifecycle, and public variant events; reuse the existing canary lock,
  verifier, token boundary, and cleanup framework.

## Goal Oracle

The oracle for this goal is:

`Historical v1 and current legacy contracts pass against the candidate Worker; a typed host can
register and submit a headless structured variant while a legacy-only page performs no variant work;
and one locked zero-retry merge-tip preview canary creates, verifies, closes, and sweeps exactly one
structured GitHub Issue with the expected sections, labels, attribution, marker, widget hash, and
Worker SHA.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing helper, or a
mocked GitHub call is not enough. The goal finishes only when a final Judge audit maps current
receipts and verification to every clause and records `full_outcome_complete: true`.

## Goal Kind

`existing_plan`

## Current Tranche

Complete Phase 1 continuously through four coherent packages:

1. Freeze and test the legacy compatibility baseline, including an explicit decision and proof for
   historical exact bundles and the existing version-retention defect.
2. Add the isolated field-agnostic structured Worker contract and server-owned variant label policy.
3. Publish public declarations and add the lazy registration/headless sidecar without rendered UX.
4. Extend the existing locked canary to prove one real structured Issue and zero cleanup leaks.

Phase 2 modal, inline, rating, choice, and other rendered UX work is out of this tranche.

## Non-Negotiable Constraints

- Preserve all existing script tags, data attributes, legacy API methods, event timing, payloads,
  responses, Issue formatting, labels, storage, screenshot flows, and `widget.v1.js` behavior.
- Do not reinterpret arguments passed to legacy `BugDrop.open()`.
- Do not move the legacy wizard behind a new runtime/controller in Phase 1.
- Keep the legacy and structured Worker handlers and formatters isolated.
- Use `kind: 'bugdrop.variant-submission'` plus `schemaVersion: 1`; a legacy payload containing an
  unrelated `schemaVersion` remains legacy.
- The structured payload is field-agnostic and contains no field schema, raw labels, `labelSet`,
  screenshots, attachments, annotations, or console logs.
- Raw labels remain Worker-owned; `{repo, variantId}` mapping is classification, not authorization.
- Variant-only initialization is lazy and inert until `registerVariant()` is called.
- Publish a real `.d.ts` integration contract rather than documentation-only types.
- Add no database, queue, storage product, or backend service.
- Create only one routine real-Issue canary per merge group and reuse Phase 0 safety machinery.
- Do not run the real canary locally, manually, on pull requests, production, or ordinary live paths.
- Preserve unrelated user changes and the existing untracked GoalBuddy artifacts.
- Do not create a PR, enqueue a merge, or mutate repository settings without authority recorded on
  the board or obtained from the operator.

## Stop Rule

Stop only when a final audit proves the full Phase 1 oracle is complete.

Do not stop after planning, compatibility fixtures, Worker support, or a mocked structured request
if the next safe package can proceed. If live merge-queue proof awaits external authority, block only
that task and continue every local non-destructive verification and audit available.

## Slice Sizing

Each Worker owns one coherent reversible package: compatibility foundation, Worker structured
contract, public types/headless sidecar, or canary extension. Avoid helper-only slices and avoid
parallel writers because these contracts share the widget API, Worker route, tests, and CI boundary.

## Board Health

Machine truth lives at
`docs/goals/configurable-feedback-variants-phase-1/state.yaml`. The PM uses the bundled checker and
receipt applier and keeps exactly one active task.

## Canonical Board

`docs/goals/configurable-feedback-variants-phase-1/state.yaml`

## Run Command

```text
/goal Follow docs/goals/configurable-feedback-variants-phase-1/goal.md.
```

## PM Loop

On every continuation, read this charter, the GoalBuddy execution contract, and `state.yaml`; work
only the active task; record its receipt; advance immediately to the next safe task; and run the
final oracle plus `check-can-stop.mjs` before claiming completion.
