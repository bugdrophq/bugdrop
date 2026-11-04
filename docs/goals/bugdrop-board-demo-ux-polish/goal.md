# BugDrop Board Demo UX Polish

## Objective

Make the live BugDrop Board demo feel obvious, organic, and easy to use for a first-time
closed-beta viewer.

## Original Request

> great - use goalbuddy prep board to do all

## Intake Summary

- Input shape: `specific`
- Audience: closed-beta evaluators and prospective self-hosters seeing BugDrop Board for the
  first time
- Authority: `requested`
- Proof type: `demo`
- Completion proof: live/local demo walkthroughs show a simple, user-facing embedded feedback board
  with clear create and upvote affordances, realistic content, reduced clutter, and responsive
  behavior.
- Goal oracle: a Chrome/Playwright review of the demo must disprove the prior critique by showing
  that a new viewer can understand the board purpose, add/request flow, vote counts, and status
  grouping without debug language or metadata noise.
- Likely misfire: polishing colors while leaving dogfood/debug content, exposed GitHub metadata,
  an oversized form, and empty kanban lanes that still make the board feel cluttered.
- Blind spots considered: the fix spans the widget package and the BugDrop host page; live production
  deploys and package publishing are separate authority boundaries; realistic demo data may require
  either non-mutating fixtures or carefully-scoped dogfood issue/status setup.
- Existing plan facts: independent UX reviewers identified issues with dogfood framing, missing
  purpose copy, unclear `Prioritize` voting language, empty kanban lanes, noisy sample data, form
  dominance, embedded-app fit, mobile lane behavior, and customization proof.

## Goal Oracle

The oracle for this goal is:

`A desktop and mobile browser walkthrough of the BugDrop Board demo proves the experience reads as
a simple embeddable feature board, with user-facing copy, obvious upvote counts, realistic demo
items, non-noisy cards, adaptive lanes, and no layout overlap or broken states.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice,
or a prettier screenshot is not enough. The goal finishes only when a final Judge/PM audit maps
receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Complete successive safe verified slices until the demo no longer feels like an internal dogfood
artifact. The first tranche should discover the exact implementation surface, then ship the largest
safe useful UX package across widget/demo code with focused tests and visual proof.

## Non-Negotiable Constraints

- Preserve the current GitHub-backed, signed-token, upvote-only product model.
- Do not add hosted control plane, billing, realtime, comments, downvotes, or GitHub Projects.
- Do not publish npm packages, bump package versions, deploy Cloudflare production, rotate secrets,
  or mutate production credentials without explicit approval.
- Do not perform destructive dogfood cleanup without explicit approval.
- Keep changes scoped to demo UX, widget ergonomics needed by the demo, docs/examples needed to prove
  customization, and tests for those changes.
- Use existing repo stacks and validation gates.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package when the broader owner outcome still has safe
local follow-up work. Advance the board to the next highest-leverage safe Worker package and
continue unless a phase, risk, rejected-verification, ambiguity, or final-completion review is due.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A good task is the largest safe useful slice: a working demo screen, a working widget behavior
improvement, a verified responsive flow, or a coherent documentation/example package.

## Canonical Board

Machine truth lives at:

`docs/goals/bugdrop-board-demo-ux-polish/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task,
receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/bugdrop-board-demo-ux-polish/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without
   blocking.
4. Re-check the intake, constraints, likely misfire, and UX critique evidence.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If safe local work remains, choose the next largest reversible Worker package and continue unless
   blocked.
10. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the
    original user outcome and records `full_outcome_complete: true`.
