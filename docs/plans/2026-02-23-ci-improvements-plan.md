# CI Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic-release for automated versioning/changelog, npm audit for dependency security scanning, and ESLint size limit rules.

**Architecture:** Three independent additions to the CI pipeline. Semantic-release runs as a new job after tests pass on main, creating GitHub Releases that trigger the existing deploy workflow. Security audit is a new step in the existing check job. ESLint rules are warn-level to avoid blocking CI on two legacy large files.

**Tech Stack:** semantic-release, GitHub Actions, ESLint 9 flat config, npm audit, Makefile

---

### Task 1: Add ESLint size limit rules

**Files:**
- Modify: `eslint.config.js:17-24` (rules object)

**Step 1: Add the size limit rules**

In `eslint.config.js`, add two rules to the `rules` object after the existing `@typescript-eslint/no-explicit-any` rule:

```javascript
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
    },
```

**Step 2: Verify lint runs without errors**

Run: `cd /tmp/bugdrop && npx eslint .`
Expected: Warnings for `src/widget/index.ts` and `src/widget/ui.ts` (too many lines), but NO errors. Exit code 0.

**Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "chore: add max-lines and max-lines-per-function ESLint rules as warnings"
```

---

### Task 2: Add npm audit security check to CI

**Files:**
- Modify: `Makefile:39-41` (after lint target)
- Modify: `Makefile:53` (check target)
- Modify: `.github/workflows/ci.yml:43-44` (check job steps)

**Step 1: Add audit target to Makefile**

In `Makefile`, after the `lint-fix` target (around line 44), add:

```makefile
audit:
	npm audit --audit-level=high
```

**Step 2: Add audit to the check target**

In `Makefile`, change the `check` target from:

```makefile
check: lint typecheck knip
	@echo "✓ All checks passed"
```

To:

```makefile
check: lint typecheck knip audit
	@echo "✓ All checks passed"
```

**Step 3: Add audit to .PHONY**

In `Makefile`, add `audit` to the `.PHONY` line at the top (line 1).

**Step 4: Add audit to help output**

In the "Code Quality" section of the help target, add after the knip line:

```makefile
	@echo "    make audit            - Run npm security audit"
```

**Step 5: Verify audit runs**

Run: `cd /tmp/bugdrop && make audit`
Expected: Exit code 0 (or shows vulnerabilities if any exist — high/critical would fail).

**Step 6: Verify check still works**

Run: `cd /tmp/bugdrop && make check`
Expected: All checks pass including the new audit step.

**Step 7: Commit**

```bash
git add Makefile
git commit -m "chore: add npm audit security check to CI pipeline"
```

---

### Task 3: Set up semantic-release

**Files:**
- Create: `.releaserc.json`
- Modify: `package.json:3` (version field)
- Modify: `.github/workflows/ci.yml` (add release job)

**Step 1: Fix package.json version**

In `package.json`, change the version from `"1.1.0"` to `"1.14.0"` to match the latest git tag (v1.14.0).

**Step 2: Install semantic-release packages**

Run:
```bash
cd /tmp/bugdrop && npm install --save-dev semantic-release @semantic-release/changelog @semantic-release/git
```

**Step 3: Create .releaserc.json**

Create `.releaserc.json` in the project root:

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", {
      "changelogFile": "CHANGELOG.md"
    }],
    ["@semantic-release/npm", {
      "npmPublish": false
    }],
    ["@semantic-release/git", {
      "assets": ["CHANGELOG.md", "package.json", "package-lock.json"],
      "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }],
    "@semantic-release/github"
  ]
}
```

Notes:
- `@semantic-release/commit-analyzer` — determines version bump from conventional commits
- `@semantic-release/release-notes-generator` — generates release notes
- `@semantic-release/changelog` — appends to CHANGELOG.md
- `@semantic-release/npm` with `npmPublish: false` — only updates package.json version, no npm publish
- `@semantic-release/git` — commits the version bump + CHANGELOG back to main
- `@semantic-release/github` — creates the GitHub Release (which triggers deploy)

**Step 4: Add release job to CI workflow**

In `.github/workflows/ci.yml`, add a new `release` job after the existing `e2e` job (before the `deploy` job). This job runs only on push to main (not PRs, not release events):

```yaml
  # Automated release via semantic-release (only on push to main)
  release:
    name: Release
    runs-on: ubuntu-latest
    needs: [test, e2e]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: make install

      - name: Run semantic-release
        run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Step 5: Verify the config is valid JSON**

Run: `cd /tmp/bugdrop && node -e "require('./.releaserc.json'); console.log('Valid')"`
Expected: `Valid`

**Step 6: Verify semantic-release can find the config**

Run: `cd /tmp/bugdrop && npx semantic-release --dry-run --no-ci 2>&1 | head -20`
Expected: Should show it loading the config and analyzing commits (may show auth errors since we're not in CI — that's fine).

**Step 7: Commit**

```bash
git add .releaserc.json package.json package-lock.json .github/workflows/ci.yml
git commit -m "feat: add semantic-release for automated versioning and changelog"
```

---

### Task 4: Run full validation and fix any issues

**Step 1: Run type checking**

Run: `cd /tmp/bugdrop && npm run typecheck`
Expected: No errors.

**Step 2: Run lint**

Run: `cd /tmp/bugdrop && make lint`
Expected: Only warnings (from the two large widget files), no errors. Exit code 0.

**Step 3: Run audit**

Run: `cd /tmp/bugdrop && make audit`
Expected: Exit code 0.

**Step 4: Run full check**

Run: `cd /tmp/bugdrop && make check`
Expected: All checks pass.

**Step 5: Run unit tests**

Run: `cd /tmp/bugdrop && make test`
Expected: All tests pass.

**Step 6: Build and run E2E tests**

Run: `cd /tmp/bugdrop && make build-widget && make install-playwright && make test-e2e`
Expected: All E2E tests pass.

**Step 7: If any failures, fix and commit**

```bash
git add -A
git commit -m "fix: address issues from CI improvements"
```
