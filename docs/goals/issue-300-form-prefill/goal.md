# Implement Issue #300 Form Prefills

## Objective

Implement the built-in BugDrop form prefill request from
[Issue #300](https://github.com/bugdrophq/bugdrop/issues/300) on the fresh
`codex/issue-300-prefill-plan` worktree. Deliver working nickname and optional email defaults,
category-specific editable description templates, safe Issue rendering, user-facing integration
documentation, tests, and a reviewable PR when verified.

## Original Request

The owner asked to check whether Issue #300 was already solved, plan a feasible implementation on a
fresh worktree, explain how host apps could pass nickname/email safely, include honest language
that this is not proof of identity, ensure user documentation is updated in the PR, and then
"implement as goalbuddy prep board?"

## Intake Summary

- Input shape: `existing_plan`. Preserve and validate
  `docs/plans/2026-09-30-issue-300-form-prefill.md` before code changes.
- Audience: BugDrop integrators and feedback submitters.
- Authority: `requested` for implementation, documentation, tests, and a reviewable PR; no merge,
  deployment, or issue closure requested.
- Proof type: `test`, browser demo, review, and documentation artifact.
- Completion proof: The final implementation demonstrates both built-in opening paths and all three
  category templates; edited text survives category and screenshot transitions; default behavior
  stays compatible; untrusted submitter values cannot spoof Issue formatting; docs show a working
  host integration and state the identity/privacy boundary; a final audit covers the exact diff.
- Likely misfire: Finish a plan, custom variant, or green happy-path test while the built-in form
  still lacks the feature, loses edited text, or claims a supplied email is verified.
- Blind spots: `BugDrop.open()` must keep ignoring arguments; the default widget has fixed and
  private-flow runtimes; email may be visible in public GitHub Issues; existing server formatting
  inserts name/email into Markdown; the original checkout has unrelated dirty changes.
- Existing plan facts: Use a per-open host callback via `data-prefill-provider`; keep name/email
  optional and editable; use category templates without overwriting reporter edits; add email
  disclosure; do not make a verified-identity claim; update configuration, JavaScript API, and
  security/FAQ docs.

## Goal Oracle

The oracle is a browser walkthrough and test set against the final diff that proves a host app can
prefill the built-in form through both the trigger and `BugDrop.open()`, select each category, edit
and clear the description without loss, return from screenshot capture with values intact, and
reopen after a host-account change with fresh values. API tests must prove submitter name/email
are bounded and rendered as literal text. Documentation must contain a usable host callback example
and say plainly that these fields are unverified suggestions included in the GitHub Issue.

After each Worker package and at final audit, compare evidence with this oracle. A passing unit
suite alone or a written plan is insufficient. Record `full_outcome_complete: true` only after a
final Judge or PM audit maps all receipts and verification to this full outcome.

## Goal Kind

`existing_plan`

## Current Tranche

Validate the existing plan against the fresh worktree, then implement the whole Issue #300 feature,
backend safety boundary, docs, tests, and reviewable PR. Start with the largest safe bounded Worker
package, review at the trust-boundary phase, and continue until the complete outcome is proven.

## Non-Negotiable Constraints

- Work in `/Users/neonwatty/.codex/worktrees/issue-300-prefill-plan/bugdrop`; preserve the
  unrelated dirty primary checkout.
- Treat `docs/plans/2026-09-30-issue-300-form-prefill.md` as a plan to validate, not as proof.
- Keep legacy `BugDrop.open()` synchronous and continue ignoring its arguments, including events
  and arbitrary objects. Existing script tags must still render an empty built-in form.
- Prefilled nickname/email are untrusted editable defaults, not verified identity. Do not infer
  them from cookies, GitHub, or token claims, and do not add a `verified` attribution claim.
- Email remains opt-in through existing display configuration and is visible before submission.
  Do not place personal values in attributes, URLs, local storage, or diagnostic logs.
- Keep both built-in default-flow runtimes and screenshot-return behavior equivalent.
- Before any PR, follow `CLAUDE.md`'s pre-PR review-agent gate; before any merge, run the repo's
  pull-request review skill. Do not merge or deploy unless separately requested.
- Satisfy the repository's burden of proof by trying the strongest realistic failure modes and
  recording direct evidence, not only passing happy-path tests.
- If local servers are started, use a named `.localhost` subdomain.

## Stop Rule

Goal prep stops after creating this board. The later `/goal` execution must not stop after plan
validation or one implementation package while safe required work remains. Stop execution only
after final audit proves the full owner outcome, or an exact terminal approval wait is recorded.

## Slice Sizing

Prefer a coherent widget vertical slice that includes the public callback, form behavior, tests,
and integration documentation. Keep Worker file scopes bounded. Handle backend validation and
Markdown formatting as a separate risk boundary if the plan-validating PM/Judge confirms that is
the largest safe split. Do not create a Worker task for only a tiny helper or doc note unless it
unblocks the feature.

## Board Health

Machine truth lives at `docs/goals/issue-300-form-prefill/state.yaml`. If the visual board looks
stale, compare it with the state file and run:

```bash
node /Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/issue-300-form-prefill
```

## Run Command

```text
Codex: /goal Follow docs/goals/issue-300-form-prefill/goal.md.
Claude Code: /goalbuddy Follow docs/goals/issue-300-form-prefill/goal.md.
```

## PM Loop

On every execution continuation, read the GoalBuddy execution contract at
`/Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/references/goal-execution.md`
and the current `state.yaml`. Work only on the active task; dispatch its assigned role; require a
receipt; update the board; verify at phase/risk/final boundaries; then activate the next safe
task. Before ending, run the bundled `check-can-stop.mjs` against this goal. Treat a nonzero result
as evidence that required safe work remains.
