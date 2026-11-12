# Contributing

## Development Setup

Use a current Node.js 22 release. If you use nvm, run `nvm install` and
`nvm use` from the checkout to select the version in [.nvmrc](.nvmrc).

```bash
git clone https://github.com/bugdrophq/bugdrop
cd bugdrop
npm ci
npx playwright install chromium
```

On Linux, use `make install-playwright` to install Chromium and its system dependencies.

To try the widget locally, run `npm run build:widget` and `make dev`, then
open <http://bugdrop.localhost:8787/test/?localQa=1>. This mode stores
submissions in your browser. To test real GitHub Issue creation, configure a
test GitHub App and repository using the [self-hosting guide](SELF_HOSTING.md),
then open `/test/` with the QA flag omitted.

## Running Tests

- Run `npm run validate` for lint, formatting, type checking, and Vitest.
- Run `make check` for changes to dependencies, CI, or release tooling.
- Run `make test-e2e` for local Chromium tests. Playwright builds the widget
  and starts its own server on port 8787. Stop any manually started server
  first so the tests use the current checkout.
- Use `make ci` to run the local checks, builds, and Chromium suite together.
  GitHub Actions also runs additional browser projects and the merge-queue
  preview checks.

Start new behavior with a test that fails for the expected reason. For examples,
see the [Vitest capture flow tests](test/captureFlow.test.ts) and the
[Playwright compatibility tests](e2e/default-flow-compatibility.spec.ts).
The browser tests open the real widget and intercept its API requests so they
can assert both the visible outcome and the submitted data without creating
a GitHub Issue.

## Pull Request Guidelines

- Work on a feature branch. If you lack push access, use a fork.
- Keep the PR focused and use conventional commits.
- Describe the user-visible change, link the issue, and note any compatibility
  impact. Update user-facing docs when behavior changes.
- Record the checks you ran, the results, and any verification gaps. Name the
  tested commit and browser or environment where they matter.

See [AGENTS.md](AGENTS.md) for the repository's review, merge, and release gates.

### Production heartbeat recovery after merging

- For each merge to `main`, review the exact new SHA against the watchdog's
  approved pin, including workflow, admission, and resolved dependency changes.
- If the revision is approved, update the watchdog pin and verify the live
  recovery gates. Keep four-hour scheduling enabled. A fresh scheduled
  heartbeat can coexist with a blocked automatic recovery gate.

## Code Style

- Regenerate `package-lock.json` with npm when changing dependencies.
- TypeScript strict mode
- No unused exports (enforced by knip)
- Prefer explicit types over inference for function signatures

## Project Structure

```
src/
├── index.ts           # Worker entry point
├── routes/api.ts      # API endpoints
├── lib/github.ts      # GitHub API client
└── widget/            # Client-side widget
    ├── index.ts       # Widget entry
    ├── ui.ts          # UI components + theming
    ├── screenshot.ts  # Screen capture
    └── annotator.ts   # Drawing tools
```

## Questions?

Open an issue or start a discussion.
