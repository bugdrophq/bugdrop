# Welcome Screen Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable welcome screen behavior (show-once default, host disable, programmatic skip), default screenshot checkbox to checked, and display BugDrop version in every modal footer.

**Architecture:** All changes are in the widget frontend layer. `WidgetConfig` gains a `welcome` field parsed from `data-welcome`. localStorage persistence (`bugdrop_welcomed_{repo}`) gates the welcome screen. `createModal()` in `ui.ts` gains a version footer injected at build time via esbuild `--define`. The build script injects `__BUGDROP_VERSION__` as a compile-time constant.

**Tech Stack:** TypeScript, esbuild, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-04-03-welcome-screen-controls-design.md`

---

### Task 1: Add `welcome` field to `WidgetConfig` and parse from `data-welcome`

**Files:**
- Modify: `src/widget/index.ts:10-41` (WidgetConfig interface)
- Modify: `src/widget/index.ts:196-230` (config parsing)
- Test: `test/welcomeConfig.test.ts`

- [ ] **Step 1: Write unit tests for config parsing logic**

Create `test/welcomeConfig.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

type WelcomeMode = 'once' | 'always' | 'never';

function parseWelcome(value: string | undefined): WelcomeMode {
  if (value === 'false' || value === 'never') return 'never';
  if (value === 'always') return 'always';
  return 'once';
}

describe('Welcome config parsing', () => {
  it('defaults to "once" when omitted', () => {
    expect(parseWelcome(undefined)).toBe('once');
  });

  it('returns "never" for "false"', () => {
    expect(parseWelcome('false')).toBe('never');
  });

  it('returns "never" for "never"', () => {
    expect(parseWelcome('never')).toBe('never');
  });

  it('returns "always" for "always"', () => {
    expect(parseWelcome('always')).toBe('always');
  });

  it('defaults to "once" for unrecognized values', () => {
    expect(parseWelcome('banana')).toBe('once');
    expect(parseWelcome('')).toBe('once');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run test/welcomeConfig.test.ts`
Expected: PASS (tests use a local helper defined inline)

- [ ] **Step 3: Add `welcome` to WidgetConfig interface**

In `src/widget/index.ts`, add after line 40 (`shadow?: string;`):

```typescript
  // Welcome screen behavior
  welcome: 'once' | 'always' | 'never';
```

- [ ] **Step 4: Parse `data-welcome` in config block**

In `src/widget/index.ts`, add after line 229 (`shadow: script?.dataset.shadow || undefined,`):

```typescript
  // Welcome screen behavior (default: 'once')
  welcome: (() => {
    const val = script?.dataset.welcome;
    if (val === 'false' || val === 'never') return 'never' as const;
    if (val === 'always') return 'always' as const;
    return 'once' as const;
  })(),
```

- [ ] **Step 5: Run unit tests**

Run: `npx vitest run`
Expected: All existing + new tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/widget/index.ts test/welcomeConfig.test.ts
git commit -m "feat: add welcome config field and data-welcome parsing"
```

---

### Task 2: Add localStorage helpers for welcome-seen state

**Files:**
- Modify: `src/widget/index.ts:70-71` (constants area)
- Modify: `src/widget/index.ts` (after `dismissButton()` function, ~line 187)
- Test: `test/welcomeState.test.ts`

- [ ] **Step 1: Write unit tests for localStorage helpers**

Create `test/welcomeState.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

const BUGDROP_WELCOMED_PREFIX = 'bugdrop_welcomed_';

function hasSeenWelcome(repo: string): boolean {
  try {
    return localStorage.getItem(BUGDROP_WELCOMED_PREFIX + repo) !== null;
  } catch {
    return false;
  }
}

function markWelcomeSeen(repo: string): void {
  try {
    localStorage.setItem(BUGDROP_WELCOMED_PREFIX + repo, Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}

describe('Welcome state persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false when welcome has not been seen', () => {
    expect(hasSeenWelcome('owner/repo')).toBe(false);
  });

  it('returns true after marking welcome as seen', () => {
    markWelcomeSeen('owner/repo');
    expect(hasSeenWelcome('owner/repo')).toBe(true);
  });

  it('scopes welcome state per repo', () => {
    markWelcomeSeen('owner/repo-a');
    expect(hasSeenWelcome('owner/repo-a')).toBe(true);
    expect(hasSeenWelcome('owner/repo-b')).toBe(false);
  });

  it('stores a numeric timestamp', () => {
    markWelcomeSeen('owner/repo');
    const stored = localStorage.getItem(BUGDROP_WELCOMED_PREFIX + 'owner/repo');
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run test/welcomeState.test.ts`
Expected: PASS

- [ ] **Step 3: Add constant and helpers to widget source**

In `src/widget/index.ts`, add after line 71 (`const BUGDROP_DISMISSED_KEY = 'bugdrop_dismissed';`):

```typescript
const BUGDROP_WELCOMED_PREFIX = 'bugdrop_welcomed_';
```

In `src/widget/index.ts`, add after the `dismissButton()` function (~line 187):

```typescript
// Check if user has already seen the welcome screen for this repo
function hasSeenWelcome(repo: string): boolean {
  try {
    return localStorage.getItem(BUGDROP_WELCOMED_PREFIX + repo) !== null;
  } catch {
    return false;
  }
}

// Mark the welcome screen as seen for this repo
function markWelcomeSeen(repo: string): void {
  try {
    localStorage.setItem(BUGDROP_WELCOMED_PREFIX + repo, Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}
```

- [ ] **Step 4: Run all unit tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/widget/index.ts test/welcomeState.test.ts
git commit -m "feat: add localStorage helpers for welcome-seen state"
```

---

### Task 3: Wire welcome gate into `openFeedbackFlow`

**Files:**
- Modify: `src/widget/index.ts:384-387` (BugDrop.open API)
- Modify: `src/widget/index.ts:487-507` (openFeedbackFlow)
- Modify: `src/widget/index.ts:672-707` (showWelcomeScreen)

- [ ] **Step 1: Update `openFeedbackFlow` signature to accept options**

In `src/widget/index.ts`, change the function signature at line 487 from:

```typescript
async function openFeedbackFlow(root: HTMLElement, config: WidgetConfig) {
```

to:

```typescript
async function openFeedbackFlow(root: HTMLElement, config: WidgetConfig, opts?: { skipWelcome?: boolean }) {
```

- [ ] **Step 2: Replace the welcome gate logic**

In `src/widget/index.ts`, replace lines 502-507:

```typescript
  // Step 1: Welcome screen
  const continueFlow = await showWelcomeScreen(root);
  if (!continueFlow) {
    _isModalOpen = false;
    return;
  }
```

with:

```typescript
  // Step 1: Welcome screen (conditional)
  const skipWelcome =
    opts?.skipWelcome ||
    config.welcome === 'never' ||
    (config.welcome === 'once' && hasSeenWelcome(config.repo));

  if (!skipWelcome) {
    const continueFlow = await showWelcomeScreen(root, config.repo);
    if (!continueFlow) {
      _isModalOpen = false;
      return;
    }
  }
```

- [ ] **Step 3: Update `showWelcomeScreen` to accept repo and persist**

In `src/widget/index.ts`, change line 672 from:

```typescript
function showWelcomeScreen(root: HTMLElement): Promise<boolean> {
```

to:

```typescript
function showWelcomeScreen(root: HTMLElement, repo: string): Promise<boolean> {
```

Then update the continue button handler (line 702-704) from:

```typescript
    continueBtn?.addEventListener('click', () => {
      modal.remove();
      resolve(true);
    });
```

to:

```typescript
    continueBtn?.addEventListener('click', () => {
      markWelcomeSeen(repo);
      modal.remove();
      resolve(true);
    });
```

- [ ] **Step 4: Update `BugDrop.open()` to pass `skipWelcome: true`**

In `src/widget/index.ts`, change lines 384-387 from:

```typescript
    open: () => {
      if (!_isModalOpen) {
        openFeedbackFlow(root, config);
      }
    },
```

to:

```typescript
    open: () => {
      if (!_isModalOpen) {
        openFeedbackFlow(root, config, { skipWelcome: true });
      }
    },
```

- [ ] **Step 5: Run all unit tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat: wire welcome gate with once/always/never modes and programmatic skip"
```

---

### Task 4: Default screenshot checkbox to checked

**Files:**
- Modify: `src/widget/index.ts:778` (screenshot checkbox)

- [ ] **Step 1: Add `checked` attribute to the screenshot checkbox**

In `src/widget/index.ts`, change line 778 from:

```typescript
            <input type="checkbox" id="include-screenshot" style="width: 18px; height: 18px; accent-color: var(--bd-primary); cursor: pointer;" />
```

to:

```typescript
            <input type="checkbox" id="include-screenshot" checked style="width: 18px; height: 18px; accent-color: var(--bd-primary); cursor: pointer;" />
```

- [ ] **Step 2: Run unit tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat: default screenshot checkbox to checked"
```

---

### Task 5: Inject version at build time and display in modal footer

**Files:**
- Modify: `scripts/build-widget.js:36-39` (esbuild command)
- Modify: `src/widget/ui.ts:1013-1034` (createModal function)
- Modify: `src/widget/index.ts` (add declare for `__BUGDROP_VERSION__`)

- [ ] **Step 1: Add `__BUGDROP_VERSION__` declaration to widget source**

In `src/widget/index.ts`, add after the imports (after line 8, before the WidgetConfig interface):

```typescript
declare const __BUGDROP_VERSION__: string;
```

- [ ] **Step 2: Modify build script to inject version via `--define`**

In `scripts/build-widget.js`, replace lines 36-39:

```javascript
execSync(
  'npx esbuild src/widget/index.ts --bundle --minify --format=iife --outfile=public/widget.js',
  { cwd: rootDir, stdio: 'inherit' }
);
```

with:

```javascript
execSync(
  `npx esbuild src/widget/index.ts --bundle --minify --format=iife --define:__BUGDROP_VERSION__='"${version}"' --outfile=public/widget.js`,
  { cwd: rootDir, stdio: 'inherit' }
);
```

Note: The `version` variable comes from `package.json` (line 24), not user input. This is safe from injection.

- [ ] **Step 3: Add `__BUGDROP_VERSION__` declaration to `ui.ts`**

In `src/widget/ui.ts`, add at the top of the file (before line 1):

```typescript
declare const __BUGDROP_VERSION__: string;
```

- [ ] **Step 4: Add version footer to `createModal` in `ui.ts`**

In `src/widget/ui.ts`, replace lines 1020-1030:

```typescript
  overlay.innerHTML = `
    <div class="bd-modal">
      <div class="bd-header">
        <h2 class="bd-title">${title}</h2>
        <button class="bd-close">&times;</button>
      </div>
      <div class="bd-body">
        ${content}
      </div>
    </div>
  `;
```

with:

```typescript
  const widgetVersion = typeof __BUGDROP_VERSION__ !== 'undefined' ? __BUGDROP_VERSION__ : 'dev';
  overlay.innerHTML = `
    <div class="bd-modal">
      <div class="bd-header">
        <h2 class="bd-title">${title}</h2>
        <button class="bd-close">&times;</button>
      </div>
      <div class="bd-body">
        ${content}
      </div>
      <div class="bd-version">BugDrop v${widgetVersion}</div>
    </div>
  `;
```

- [ ] **Step 5: Add `.bd-version` CSS rule**

In `src/widget/ui.ts`, find the `.bd-body` CSS rule in the styles. After that rule block, add:

```css
    .bd-version {
      text-align: center;
      padding: 4px 0;
      font-size: 0.7rem;
      color: var(--bd-text-secondary);
      opacity: 0.5;
    }
```

- [ ] **Step 6: Run unit tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 7: Build widget to verify esbuild define works**

Run: `make build-widget`
Expected: Build succeeds without errors.

- [ ] **Step 8: Commit**

```bash
git add src/widget/index.ts src/widget/ui.ts scripts/build-widget.js
git commit -m "feat: display BugDrop version in modal footer"
```

---

### Task 6: Update E2E tests for welcome-once default behavior

**Files:**
- Modify: `e2e/widget.spec.ts` (add new welcome behavior tests)
- Create: `public/test/welcome-disabled.html`

The existing E2E tests click "Get Started" on the welcome screen. Since each Playwright test navigates to a fresh page with clean localStorage, the welcome will still appear on first open. Existing tests should pass without changes.

- [ ] **Step 1: Add E2E test for welcome show-once behavior**

In `e2e/widget.spec.ts`, add a new test inside the `'Widget Interaction'` describe block:

```typescript
  test('welcome screen only shows once per repo (default behavior)', async ({ page }) => {
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // First open: welcome should appear
    await button.click();
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Form should appear
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Close the modal
    const cancelBtn = page.locator('#bugdrop-host').locator('css=[data-action="cancel"]');
    await cancelBtn.click();
    await page.waitForTimeout(300);

    // Second open: welcome should be skipped, form appears directly
    await button.click();
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Verify "Get Started" button is NOT present (welcome was skipped)
    await expect(getStartedBtn).not.toBeVisible();
  });
```

- [ ] **Step 2: Create test HTML page for `data-welcome="false"`**

Create `public/test/welcome-disabled.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BugDrop - Welcome Disabled Test</title>
</head>
<body>
  <h1>Welcome Disabled Test</h1>
  <p>This page tests data-welcome="false" -- the welcome screen should never appear.</p>
  <script src="/widget.js" data-repo="neonwatty/feedback-widget-test" data-theme="dark" data-welcome="false"></script>
</body>
</html>
```

- [ ] **Step 3: Add E2E test for `data-welcome="false"`**

In `e2e/widget.spec.ts`, add:

```typescript
  test('data-welcome="false" skips welcome entirely', async ({ page }) => {
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/welcome-disabled.html');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    await button.click();

    // Form should appear directly, no welcome screen
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Welcome "Get Started" button should NOT be present
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).not.toBeVisible();
  });
```

- [ ] **Step 4: Add E2E test for screenshot checkbox default**

In `e2e/widget.spec.ts`, add:

```typescript
  test('screenshot checkbox is checked by default', async ({ page }) => {
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Click through welcome
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Verify screenshot checkbox is checked by default
    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await expect(screenshotCheckbox).toBeChecked();
  });
```

- [ ] **Step 5: Add E2E test for version footer**

In `e2e/widget.spec.ts`, add:

```typescript
  test('version number appears in modal footer', async ({ page }) => {
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Version should appear in the modal
    const versionEl = page.locator('#bugdrop-host').locator('css=.bd-version');
    await expect(versionEl).toBeVisible({ timeout: 5000 });
    const versionText = await versionEl.textContent();
    expect(versionText).toMatch(/^BugDrop v/);
  });
```

- [ ] **Step 6: Build widget and run E2E tests**

Run:
```bash
make build-widget && npx playwright test
```
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add e2e/widget.spec.ts public/test/welcome-disabled.html
git commit -m "test: add E2E tests for welcome modes, screenshot default, and version footer"
```

---

### Task 7: Update landing page config table

**Files:**
- Modify: `public/index.html:840-865` (config table)

- [ ] **Step 1: Add `data-welcome` row to the config table**

In `public/index.html`, add after the `data-position` row (after line 844, before the `data-color` row):

```html
          <tr>
            <td><code>data-welcome</code></td>
            <td>once, always, false/never</td>
            <td>once</td>
          </tr>
```

- [ ] **Step 2: Verify page renders correctly**

Start dev server and visually confirm the new row appears in the config table.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "docs: add data-welcome attribute to landing page config table"
```

---

### Task 8: Final integration verification

**Files:** None (verification only)

- [ ] **Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 2: Build everything**

Run: `make build-all`
Expected: Build succeeds

- [ ] **Step 3: Run full E2E suite**

Run: `npx playwright test`
Expected: All PASS

- [ ] **Step 4: Manual smoke test**

Start dev server with `make dev`, then:
1. Open test page, click widget -- welcome appears
2. Click "Get Started", cancel form, click widget again -- welcome is skipped, form appears directly
3. Open welcome-disabled test page, click widget -- form appears directly, no welcome
4. Verify "BugDrop v..." appears in footer of every modal
5. Verify screenshot checkbox is checked by default on the form

- [ ] **Step 5: Run linting and type checks**

Run: `make check`
Expected: All PASS
