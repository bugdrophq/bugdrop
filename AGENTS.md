# BugDrop agent instructions

## Start and verify

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and test commands.

- Fetch `origin/main` and use a fresh worktree for new PR work. Keep each PR
  independently reviewable. Track only `docs/website/` under `docs/`.
- For new behavior, start with a focused test at the public entry point. Assert
  an observable outcome, confirm it fails for the expected reason, then make it
  pass. Cover the most consequential failure or compatibility case when applicable.
- Reproduce bugs through the entry point users actually use. Before handoff,
  try to disprove the fix with the strongest realistic failure case. Record
  what you exercised, what you observed, and any remaining verification gaps.
- For code changes, run `npm run validate` and the relevant focused checks.
  Use `make check` for CI, dependency, or release tooling changes. Run
  `npm run build:widget` before browser tests and use a named host such as
  `bugdrop.localhost` when starting or sharing a local server.

## Pull requests and merge

- Use conventional commits. Put the user-visible change, linked issue,
  compatibility impact, and verification evidence in the PR. Identify the
  tested commit and browser or environment where it matters.
- Before merge, run `codex-pr-review-toolkit:review-pull-request` against the
  actual PR base, including for bot PRs. Resolve verified blockers and refresh
  affected review and tests when the diff changes materially.
- Merge through the GitHub queue. Inspect required checks on the current PR
  and merge candidate. For runtime changes, confirm the queue exercised the
  expected preview build and independently verified and cleaned up the
  synthetic Issue. Let CI determine which checks a docs-only change can skip.

## Code Review Rules

- For behavior changes, check that the regression test would fail if the
  behavior were missing or wrong. If that is unclear from the diff, run the
  test with the relevant change reverted or deliberately broken.
- For widget, API, or routing changes, exercise the affected entry point with
  existing installs or pinned widgets. Use the legacy and default-flow
  compatibility suites where applicable. Preserve historical fixtures and
  explain any intentional baseline change.
- For dependency and workflow changes, review the resolved lockfile and
  action pins. Verify the affected workflow on its real trigger. Coordinate
  Wrangler updates with the release adapter, fixtures, and capability drill.
- For retries, fallbacks, and external writes, check the result after a
  timeout or lost response. Verify that retries and cleanup respect the
  intended repository, environment, and run identity.

## Automation and releases

- For authorized automation, carry one identified run through completion.
  Give follow-ups a stop condition. Inspect external state before retrying a
  write, verify cleanup or restoration, and retire the follow-up when done.
- Treat merge and release as separate milestones. Release through
  `deploy.yml` using an exact `main` SHA, an explicit SemVer bump, a verified
  dry run, and the production approval gates. Verify the published release
  and live deployment before reporting that a fix shipped.
