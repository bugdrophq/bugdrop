# Contributing

Thanks for your interest in contributing!

## Development Setup

```bash
# Clone and install
git clone https://github.com/bugdrophq/bugdrop
cd bugdrop
make install

# Configure (see SELF_HOSTING.md for GitHub App setup)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your GitHub App credentials

# Start dev server
make dev
# Visit http://localhost:8787/test/
```

## Running Tests

```bash
make test        # Unit tests
make test-e2e    # E2E tests (requires Playwright)
make check       # Lint + typecheck + knip
make ci          # Full CI pipeline
```

## Pull Request Guidelines

1. **Fork** the repo and create a feature branch
2. **Write tests** for new functionality
3. **Run `make ci`** before submitting
4. **Keep PRs focused** - one feature/fix per PR
5. **Update docs** if adding user-facing changes

## Code Style

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
