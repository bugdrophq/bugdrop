# CI Improvements: Semantic Release, Security Audit, ESLint Limits

## Problem

1. **No automated releases**: CHANGELOG is manually maintained and already 3 versions behind (stops at 1.11.0, latest tag is v1.14.0). package.json version (1.1.0) is stale.
2. **No security scanning of dependencies**: CI has Gitleaks for secrets but no `npm audit` for vulnerable packages.
3. **No code size guardrails**: No limits on file or function length — `ui.ts` has a 916-line function.

## Solutions

### 1. Semantic Release

Install `semantic-release` with changelog, npm, git, and github plugins. Add a `release` job to CI that runs on push to main after all tests pass. It reads the latest git tag (v1.14.0), analyzes conventional commits, bumps version, generates CHANGELOG entry, and creates a GitHub Release — which triggers the existing deploy workflow.

Config: `.releaserc.json` targeting `main` branch.

### 2. Security Audit in CI

Add `npm audit --audit-level=high` as a step in the existing `check` job. Also add a `audit` Makefile target and include it in `make check`.

### 3. ESLint Size Limits

Add `max-lines` (300) and `max-lines-per-function` (150) as `warn` level rules. Two existing files violate these limits (`widget/index.ts` at 1042 lines, `widget/ui.ts` at 1006 lines with 916-line `injectStyles`), so `warn` prevents new oversized code without blocking CI on existing code. 9 of 11 source files already comply.

## Files Changed

- `.releaserc.json` — new, semantic-release config
- `.github/workflows/ci.yml` — add release job, add audit step
- `package.json` — fix version to 1.14.0, add semantic-release devDeps
- `Makefile` — add audit target, update check target
- `eslint.config.js` — add size limit rules
