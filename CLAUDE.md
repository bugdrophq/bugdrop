# BugDrop — Claude Code Instructions

## Project Overview

BugDrop is an in-app feedback widget that creates GitHub Issues with screenshots and
annotations. The backend is a Cloudflare Worker (Hono), the widget is vanilla TypeScript
bundled with esbuild, and the test venue is `mean-weasel/bugdrop-widget-test` on Vercel.

- **Backend**: `src/` — Hono on Cloudflare Workers
- **Widget**: `src/widget/` — esbuild → `public/widget.js` (gitignored, must `npm run build:widget` before E2E)
- **Unit tests**: `test/` — Vitest
- **E2E tests**: `e2e/` — Playwright (sharded), runs against `wrangler dev` at localhost:8787
- **CI**: `.github/workflows/ci.yml` — lint, unit, E2E, deploy preview, live tests
- **Release**: explicit operator dispatch of `.github/workflows/deploy.yml`; production is
  fail-closed unless its two external capability gates and protected approval are satisfied

---

## Workflow: Starting Any Task

Before writing code, use `/brainstorming` to explore the problem space. This is
especially important for bug fixes (to identify root causes before jumping to solutions)
and for new features (to consider design alternatives).

For non-trivial tasks, follow up with plan mode (`/plan`) to create a step-by-step
implementation plan before writing code.

---

## Workflow: Writing Code

### Use Superpowers Skills Liberally

Invoke these skills at the appropriate moments — don't skip them:

- **`/brainstorming`** — Before starting any non-trivial task. Explore the problem space,
  consider alternatives, identify risks.
- **`/validate`** — After completing a logical chunk of work. Validates the implementation
  against project conventions and catches issues early.
- **`/simplify`** — After writing or modifying code. Simplifies for clarity, consistency,
  and maintainability while preserving functionality.
- **`/superpowers`** — When unsure which skill applies. The meta-skill that routes to the
  right workflow.

### Generate Tests with `/gen-test`

Use `/gen-test <file>` to generate tests following project conventions. The skill
includes example patterns for both Vitest (unit) and Playwright (E2E).

For bug fixes: write a failing test first that reproduces the bug, then fix it.
For new features: consider writing the test interface first to drive the API design.

### Build Before E2E

Widget source changes require `npm run build:widget` before E2E tests will reflect them.
The built files (`public/widget.js`, `public/widget.v*.js`) are gitignored.

---

## Workflow: Pre-PR Review Gate

Before creating any pull request, run these **pr-review-toolkit** agents **in parallel**:

1. **`pr-review-toolkit:code-reviewer`** — Bugs, logic errors, security issues, adherence
   to project conventions
2. **`pr-review-toolkit:pr-test-analyzer`** — Test coverage completeness, edge cases,
   missing assertions
3. **`pr-review-toolkit:code-simplifier`** — Simplification opportunities, duplication,
   unnecessary complexity

**Also run these when relevant:**

4. **`pr-review-toolkit:silent-failure-hunter`** — When changes involve error handling,
   catch blocks, fallback logic, or Promise patterns
5. **`pr-review-toolkit:comment-analyzer`** — When adding or modifying documentation
   comments or docstrings
6. **`pr-review-toolkit:type-design-analyzer`** — When introducing new TypeScript types
   or interfaces

**Process:**

- Launch agents 1-3 as background tasks in parallel
- Wait for all results
- Address all critical and important findings
- Re-run affected agents if fixes were substantial
- Only then create the PR

---

## Workflow: Creating PRs

Use the `/pr-creator` skill when creating pull requests. It handles branch naming,
commit organization, and PR description formatting.

Follow conventional commit format for readable history. Prefixes do not select a release
version; the operator chooses the SemVer bump in the manual release dispatch.

- `fix:` — bug fixes
- `feat:` — new features
- `test:` — test-only changes (no release)
- `chore:` — maintenance (no release)
- `docs:` — documentation (no release)

See `docs/releasing.md` for the on-demand dry-run, live-release, and recovery procedure.

---

## Workflow: Debugging

Use `/systematic-debugging` for any non-obvious bug. Don't guess — form hypotheses,
test them systematically, and narrow down root causes before writing fixes.

---

## Workflow: Code Review (Receiving)

When the user shares PR feedback or review comments, use `/receiving-code-review` to
process the feedback systematically and address each point.

---

## Code Conventions

- **Formatting**: Prettier (single quotes, 2-space indent, trailing commas, 100 char width)
- **Linting**: ESLint with typescript-eslint (no unused vars, warn on `any`)
- **File size limits**: max 300 lines per file, max 150 lines per function (ESLint warns)
- **Commits**: Conventional commits enforced by commitlint via husky
- **TypeScript**: Strict mode. Prefer explicit types at function boundaries.
- **No `any`**: Use `unknown` + type narrowing instead of `any` where possible.

---

## CI Pipeline

6 required status checks must pass before merge:

- Lint
- Unit Tests
- E2E Tests (2 shards)
- Deploy Preview
- Live Preview Tests

The merge queue runs a subset of these. Don't bypass CI — fix failures at the source.

---

## Onboarding

Run `/setup-dev` to set up the development environment. It checks prerequisites,
installs dependencies, builds the widget, and runs all tests to verify the setup.

---

## Repo-Specific Knowledge

- Widget computes `apiUrl` from `script.src` using regex: `/\/widget(?:\.v[\d.]+)?\.js$/`
- GitHub App slug: `neonwatty-bugdrop` (name `bugdrop` was reserved by a defunct app)
- Repo is in the `bugdrophq` org (transferred from `mean-weasel` on 2026-09-14)
- `html-to-image` library bundled into widget.js via esbuild (static import, not CDN-loaded)
- Complex DOM pages (>3000 nodes) get reduced pixelRatio; pages with >10k nodes have Full Page and Select Area buttons hidden entirely

## Burden Of Proof

Before declaring work complete, try to disprove the change. Identify the
strongest realistic failure mode, verify it with a command, test, trace,
screenshot, audit record, diff, or direct inspection, and include that evidence
in the final handoff.

Treat `done`, `tests passed`, worker claims, passing happy-path tests, generated
summaries, and optimistic UI as claims, not proof. Treat unverified assumptions
as blockers or explicit follow-ups.

Keep this section synchronized with `AGENTS.md` whenever either file changes.
