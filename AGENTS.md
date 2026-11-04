# Agent Instructions

Follow `CLAUDE.md` for repo-level agent guidance.

## Local Servers

When starting or handing off a local server, always use a named `.localhost`
subdomain (for example, `bugdrop.localhost`) instead of bare `localhost` or
`127.0.0.1`.

## Pull Request Review

For every pull request, run `codex-pr-review-toolkit:review-pull-request` against its base before merge.

## Burden Of Proof

Before declaring work complete, try to disprove the change. Identify the
strongest realistic failure mode, verify it with a command, test, trace,
screenshot, audit record, diff, or direct inspection, and include that evidence
in the final handoff.

Treat `done`, `tests passed`, worker claims, passing happy-path tests, generated
summaries, and optimistic UI as claims, not proof. Treat unverified assumptions
as blockers or explicit follow-ups.

Keep this section synchronized with `CLAUDE.md` whenever either file changes.
