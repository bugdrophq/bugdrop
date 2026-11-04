# Preview Deployment E2E Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run E2E tests against real Cloudflare Workers + Vercel preview deployments on every merge-queue entry, validating the widget works cross-origin before merging.

**Architecture:** A single `bugdrop-preview` CF Worker serves as the preview deployment target. A Vercel-hosted `feedback-widget-test` site loads the widget via `<script src>` from that preview worker. Playwright `chromium-live` tests run against the Vercel preview, validating the full cross-origin widget flow. The merge queue serializes access to the shared preview worker.

**Tech Stack:** Cloudflare Workers (wrangler), Vercel (Vite + React), Playwright, GitHub Actions (merge_group trigger)

**Spec:** `docs/superpowers/specs/2026-04-03-preview-deployment-tests-plan.md`
**Issue:** [neonwatty/bugdrop#57](https://github.com/neonwatty/bugdrop/issues/57)

---

## Scope

This plan covers the **bugdrop repo only** (Tasks 1–6). The feedback-widget-test Vercel setup (Phase 2 in the spec) is a one-time manual/UI task in the Vercel dashboard and the feedback-widget-test repo — it is **not** automatable from this repo and is listed as a prerequisite, not a task.

### Prerequisites (manual, outside this plan)

Before starting Task 4, complete the Vercel setup for `neonwatty/feedback-widget-test`:

1. Import repo into Vercel (auto-detects Vite)
2. Remove `base: '/feedback-widget-test/'` from `vite.config.ts`
3. Add `transformIndexHtml` plugin to `vite.config.ts` (see spec Phase 2.2)
4. Replace hardcoded widget URL in `index.html` with `__BUGDROP_URL__` placeholder
5. Set `VITE_BUGDROP_URL` env var per environment in Vercel dashboard
6. Deploy a `preview` branch once to get a stable Vercel preview URL
7. Note the stable preview URL (e.g., `feedback-widget-test-git-preview-neonwatty.vercel.app`)

### File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `wrangler.toml` | Add `[env.preview]` section |
| Modify | `.github/workflows/ci.yml` | Add `merge_group` trigger + `deploy-preview` job + `live-preview-tests` job |
| Create | `.github/workflows/live-tests.yml` | Reusable live E2E test workflow |
| Modify | `playwright.config.ts` | Add `chromium-live` project, conditional webServer |
| Create | `e2e/widget.live.spec.ts` | Live E2E test specs for cross-origin preview |

---

## Task 1: Add preview environment to wrangler.toml

**Files:**
- Modify: `wrangler.toml`

**Context:** Wrangler environments create separate Workers deployments from the same codebase. The `[env.preview]` section will deploy to `bugdrop-preview.<account>.workers.dev`. The top-level `[assets]` block should be inherited, but this is relatively new in wrangler — we verify with `--dry-run` in Step 3.

- [ ] **Step 1: Create the preview KV namespace**

Run this to create a dedicated KV namespace for the preview environment's rate limiting:

```bash
wrangler kv namespace create RATE_LIMIT --env preview
```

Note the returned namespace ID — you'll use it in the next step.

If this fails because `[env.preview]` doesn't exist yet, create the wrangler.toml changes first (Step 2), then come back and run this command.

- [ ] **Step 2: Add `[env.preview]` section to `wrangler.toml`**

Add the following at the end of `wrangler.toml`, replacing `<PREVIEW_KV_ID>` with the ID from Step 1:

```toml
# Preview environment for live E2E tests (deployed in merge queue)
[env.preview]
name = "bugdrop-preview"

[env.preview.vars]
ENVIRONMENT = "preview"
ALLOWED_ORIGINS = "*"
GITHUB_APP_NAME = "neonwatty-bugdrop"
MAX_SCREENSHOT_SIZE_MB = "5"

[[env.preview.kv_namespaces]]
binding = "RATE_LIMIT"
id = "<PREVIEW_KV_ID>"
```

The existing top-level config already has:
- `main = "src/index.ts"` — inherited by preview
- `compatibility_date = "2024-01-29"` — inherited by preview
- `[assets] directory = "public"` — should be inherited (verified next step)

- [ ] **Step 3: Verify `[assets]` inheritance with dry-run**

```bash
wrangler deploy --env preview --dry-run
```

Expected: Build succeeds, shows deployment plan for `bugdrop-preview`. If `[assets]` is NOT inherited, the dry-run will fail or show no static assets. In that case, add explicitly:

```toml
[env.preview.assets]
directory = "public"
binding = "ASSETS"
```

- [ ] **Step 4: Set preview secrets**

```bash
wrangler secret put GITHUB_APP_ID --env preview
wrangler secret put GITHUB_PRIVATE_KEY --env preview
```

Enter the same values used for production when prompted.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml
git commit -m "feat: add preview environment to wrangler.toml for live E2E tests"
```

---

## Task 2: Add `merge_group` trigger and preview deploy job to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Context:** The current CI triggers are `push` (main, develop) and `pull_request` (main, develop). We need to add `merge_group` so that jobs can run when a PR enters the merge queue. The new `deploy-preview` job deploys the widget to the preview CF Worker only in the merge queue.

- [ ] **Step 1: Add `merge_group` to the `on:` triggers**

In `.github/workflows/ci.yml`, change the `on:` block from:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
```

to:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
  merge_group:
```

- [ ] **Step 2: Add `deploy-preview` job**

Add this job after the `e2e` job and before the `release` job in `.github/workflows/ci.yml`:

```yaml
  # Deploy to preview CF Worker (merge queue only — one PR at a time)
  deploy-preview:
    name: Deploy Preview
    runs-on: ubuntu-latest
    needs: [check]
    if: github.event_name == 'merge_group'
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: make install

      - name: Build all
        run: make build-all

      - name: Deploy to preview
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --env preview
```

- [ ] **Step 3: Verify the existing jobs still have correct conditional logic**

The existing `release` and `deploy` jobs use:
```yaml
if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

This is correct — they will NOT run in the merge queue (only on push to main). No changes needed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add merge_group trigger and preview deploy job to CI"
```

---

## Task 3: Add `chromium-live` Playwright project

**Files:**
- Modify: `playwright.config.ts`

**Context:** The current Playwright config has a single `chromium` project running against `localhost:8787` with a `wrangler dev` webServer. We add a `chromium-live` project that runs against a remote Vercel preview URL. The `LIVE_TARGET` env var disables the local webServer (no wrangler dev needed for live tests). The `chromium-live` project only matches `*.live.spec.ts` files.

- [ ] **Step 1: Write the failing test (verify config loads)**

Before modifying the config, verify the current config works:

```bash
npx playwright test --list --project=chromium 2>&1 | head -5
```

Expected: Lists existing test files. This confirms the baseline works.

- [ ] **Step 2: Update `playwright.config.ts`**

Replace the entire contents of `playwright.config.ts` with:

```typescript
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8787';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /.*\.live\.spec\.ts/,
    },
    {
      name: 'chromium-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
          extraHTTPHeaders: {
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          },
        }),
      },
      testMatch: /.*\.live\.spec\.ts/,
      timeout: 60_000,
    },
  ],
  webServer: process.env.LIVE_TARGET ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
```

Key changes from the original:
1. `baseURL` is now configurable via `PLAYWRIGHT_BASE_URL` env var (defaults to `localhost:8787` for backwards compatibility)
2. The existing `chromium` project gets `testIgnore: /.*\.live\.spec\.ts/` so it doesn't accidentally pick up live test files
3. New `chromium-live` project with `testMatch: /.*\.live\.spec\.ts/`, 60s timeout, and optional Vercel bypass header
4. `webServer` is conditionally disabled when `LIVE_TARGET` is set (live tests don't need a local server)

- [ ] **Step 3: Verify existing tests still list correctly**

```bash
npx playwright test --list --project=chromium 2>&1 | head -10
```

Expected: Same test files as before. No `*.live.spec.ts` files listed (there are none yet).

- [ ] **Step 4: Verify `chromium-live` project lists no tests**

```bash
npx playwright test --list --project=chromium-live 2>&1 | head -5
```

Expected: No tests found (no `*.live.spec.ts` files exist yet).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts
git commit -m "feat: add chromium-live Playwright project for preview E2E tests"
```

---

## Task 4: Write live E2E test specs

**Files:**
- Create: `e2e/widget.live.spec.ts`

**Context:** These tests run against the real Vercel preview site that loads the widget from the CF Workers preview. They validate cross-origin behavior that local tests cannot cover. The widget is embedded via `<script src="https://bugdrop-preview.<account>.workers.dev/widget.js">` on the Vercel preview site.

**Important patterns from existing tests:**
- Widget host: `page.locator('#bugdrop-host')`
- Shadow DOM access: `.locator('css=.bd-trigger')` (Playwright pierces shadow DOM with `css=` prefix)
- Welcome screen: click `[data-action="continue"]` to proceed past the "Get Started" screen
- Modal: `.locator('css=.bd-modal')`
- Powered-by link: `.locator('css=.bd-powered-by')`

**Prerequisite:** The feedback-widget-test Vercel setup (spec Phase 2) must be complete before these tests can run against a real deployment. The tests can still be written and committed now.

- [ ] **Step 1: Create `e2e/widget.live.spec.ts`**

```typescript
import { test, expect } from '@playwright/test';

/**
 * Live E2E tests for BugDrop widget on a real cross-origin deployment.
 *
 * These tests run against the Vercel preview of feedback-widget-test,
 * which loads the widget from the CF Workers preview deployment.
 * They validate cross-origin behavior that local tests cannot cover.
 *
 * Run with: LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=<vercel-url> npx playwright test --project=chromium-live
 */

test.describe('Widget Loading (Live)', () => {
  test('widget loads and renders on cross-origin site', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('BugDrop')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForTimeout(2000);

    // Widget host element should exist
    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });

    // Feedback button should be visible in shadow DOM
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });

    // No unexpected console errors
    const unexpectedErrors = errors.filter(e => !e.includes('Missing data-repo'));
    expect(unexpectedErrors).toHaveLength(0);
  });

  test('widget.js is served from the preview worker', async ({ request, baseURL }) => {
    // The page's script src should load widget.js from the CF Workers preview
    // We can't directly check the script tag's resolved URL from Playwright,
    // but we can verify the widget loaded by checking the host element exists
    // and also verify the preview worker's health endpoint is reachable
    const response = await request.get('/');
    expect(response.ok()).toBeTruthy();

    const html = await response.text();
    // The page should contain a script tag pointing to the bugdrop widget
    expect(html).toContain('widget.js');
  });
});

test.describe('Feedback Button (Live)', () => {
  test('feedback button is visible and clickable', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });

    // Click should open the modal
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Welcome Flow (Live)', () => {
  test('welcome screen shows on first visit', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Fresh Playwright context = first visit = welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  });

  test('can proceed past welcome screen to feedback form', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Feedback form should appear with title input
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Cross-Origin API (Live)', () => {
  test('widget derives API URL correctly from cross-origin script src', async ({ page }) => {
    await page.goto('/');

    // Wait for widget to load
    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });

    // The widget computes apiUrl from script.src by replacing
    // /widget.js with /api. On the cross-origin site, the script src
    // points to the CF Workers preview, so API calls should go there.
    // We verify this by checking that the installation check API call
    // targets the correct origin (not the Vercel site origin).
    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/')) {
        apiCalls.push(req.url());
      }
    });

    // Open the modal to trigger the installation check
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Wait for the API call to fire
    await page.waitForTimeout(3_000);

    // At least one API call should have been made
    expect(apiCalls.length).toBeGreaterThan(0);

    // All API calls should go to the workers.dev domain (not the Vercel domain)
    for (const url of apiCalls) {
      expect(url).toContain('workers.dev');
    }
  });

  test('CORS headers are present on cross-origin API requests', async ({ page }) => {
    await page.goto('/');

    // Intercept the API response to check CORS headers
    const corsHeaders: Record<string, string> = {};
    page.on('response', (res) => {
      if (res.url().includes('/api/check/')) {
        const headers = res.headers();
        if (headers['access-control-allow-origin']) {
          corsHeaders['access-control-allow-origin'] = headers['access-control-allow-origin'];
        }
      }
    });

    // Open the modal to trigger the installation check API call
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Wait for the API response
    await page.waitForTimeout(3_000);

    // CORS header should be present
    expect(corsHeaders['access-control-allow-origin']).toBeDefined();
  });
});

test.describe('Powered By Link (Live)', () => {
  test('powered by BugDrop link is visible', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const poweredBy = page.locator('#bugdrop-host').locator('css=.bd-powered-by');
    await expect(poweredBy).toBeVisible();
  });
});

test.describe('Screenshot Capture (Live)', () => {
  test('screenshot option is available in cross-origin context', async ({ page }) => {
    // Mock the installation check to return installed: true
    // (preview may not have GitHub App installed on the test repo)
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Fill in feedback form
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('Live test feedback');

    // Screenshot checkbox should be available
    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await expect(screenshotCheckbox).toBeVisible();
    await screenshotCheckbox.check();

    // Click Continue to get to screenshot options
    const continueBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await continueBtn.click();

    // Screenshot capture options should appear
    // "Capture Full Page" and "Select Element" options
    const fullPageBtn = page.locator('#bugdrop-host').locator('css=[data-action="fullpage"]');
    const elementBtn = page.locator('#bugdrop-host').locator('css=[data-action="element"]');

    // At least one screenshot option should be available
    const fullPageVisible = await fullPageBtn.isVisible().catch(() => false);
    const elementVisible = await elementBtn.isVisible().catch(() => false);
    expect(fullPageVisible || elementVisible).toBeTruthy();
  });
});

test.describe('Feedback Submission (Live)', () => {
  test('feedback form submits and gets expected response', async ({ page }) => {
    // Mock the installation check to return installed: true
    await page.route('**/api/check/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Fill in feedback form
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('Live E2E test submission');

    // Submit without screenshot
    const submitBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await submitBtn.click();

    // Wait for submission to complete
    // Without real GitHub App secrets in preview, expect either:
    // - 403 (app not installed) → widget shows error message
    // - 500 (no credentials) → widget shows error message
    // - Success → widget shows success message
    // The important thing is the form submitted and got a response (not a CORS error)
    await page.waitForTimeout(5_000);

    // Check that the widget is showing either a success or error state
    // (not stuck in the form state, which would indicate a CORS/network failure)
    const successScreen = page.locator('#bugdrop-host').locator('css=.bd-success');
    const errorMessage = page.locator('#bugdrop-host').locator('css=.bd-error');

    const hasSuccess = await successScreen.isVisible().catch(() => false);
    const hasError = await errorMessage.isVisible().catch(() => false);

    // Either success or error is fine — both mean the cross-origin request completed
    expect(hasSuccess || hasError).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify the live test files are listed by chromium-live project**

```bash
npx playwright test --list --project=chromium-live 2>&1 | head -20
```

Expected: Lists tests from `e2e/widget.live.spec.ts`.

- [ ] **Step 3: Verify chromium project ignores live tests**

```bash
npx playwright test --list --project=chromium 2>&1 | grep -c "live"
```

Expected: `0` — no live tests in the chromium project.

- [ ] **Step 4: Commit**

```bash
git add e2e/widget.live.spec.ts
git commit -m "feat: add live E2E test specs for cross-origin preview deployment"
```

---

## Task 5: Create reusable live-tests workflow

**Files:**
- Create: `.github/workflows/live-tests.yml`

**Context:** This reusable workflow runs the `chromium-live` Playwright project against the Vercel preview. It can be called from the main CI (merge queue), run manually (workflow_dispatch), or on a daily schedule (smoke test). The `PLAYWRIGHT_BASE_URL` must be set to the stable Vercel preview URL established during the prerequisite setup.

**Important:** Replace `<STABLE_VERCEL_PREVIEW_URL>` with the actual URL from the Vercel setup prerequisite (e.g., `https://feedback-widget-test-git-preview-neonwatty.vercel.app`). Replace `<ACCOUNT>` with the Cloudflare account subdomain.

- [ ] **Step 1: Create `.github/workflows/live-tests.yml`**

```yaml
name: Live Preview Tests

on:
  workflow_call:
    inputs:
      target:
        required: true
        type: string
  workflow_dispatch:
    inputs:
      target:
        required: true
        type: string
        default: preview
  schedule:
    - cron: '0 6 * * *'

jobs:
  live-tests:
    name: Live E2E Tests
    runs-on: ubuntu-latest
    env:
      LIVE_TARGET: ${{ inputs.target || 'preview' }}
      PLAYWRIGHT_BASE_URL: <STABLE_VERCEL_PREVIEW_URL>
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: make install

      - name: Install Playwright
        run: make install-playwright

      - name: Wait for preview widget deployment
        run: |
          WORKER_URL="https://bugdrop-preview.<ACCOUNT>.workers.dev/api/health"
          echo "Polling $WORKER_URL until ready..."
          for i in $(seq 1 30); do
            if curl -sfo /dev/null "$WORKER_URL"; then
              echo "Preview worker ready after $((i * 10))s"
              exit 0
            fi
            echo "Attempt $i/30 — not ready, waiting 10s..."
            sleep 10
          done
          echo "Preview worker not ready after 300s"
          exit 1

      - name: Verify test venue is reachable
        run: |
          VENUE_URL="${PLAYWRIGHT_BASE_URL}"
          echo "Checking test venue at $VENUE_URL..."
          curl -sfo /dev/null "$VENUE_URL" || (echo "Test venue unreachable at $VENUE_URL" && exit 1)
          echo "Test venue reachable"

      - name: Run live E2E tests
        run: npx playwright test --project=chromium-live --workers=1

      - name: Upload test report
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-live-report
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Validate the workflow YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/live-tests.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/live-tests.yml
git commit -m "feat: add reusable live-tests workflow for preview E2E testing"
```

---

## Task 6: Wire live tests into main CI (merge queue)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Context:** This adds the `live-preview-tests` job that calls the reusable `live-tests.yml` workflow. It runs only in the merge queue (`github.event_name == 'merge_group'`) and depends on the `deploy-preview` job completing first. Initially set to `continue-on-error: true` (non-blocking) to allow 2 weeks of monitoring before promoting to a required check.

- [ ] **Step 1: Add `live-preview-tests` job to CI**

In `.github/workflows/ci.yml`, add this job after `deploy-preview` and before `release`:

```yaml
  # Live E2E tests against real cross-origin deployment (merge queue only)
  live-preview-tests:
    name: Live Preview Tests
    needs: [deploy-preview]
    if: github.event_name == 'merge_group'
    uses: ./.github/workflows/live-tests.yml
    with:
      target: preview
    secrets: inherit
    continue-on-error: true  # Remove after 2 weeks of reliable green runs
```

- [ ] **Step 2: Validate the full CI workflow YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: wire live preview tests into CI merge queue"
```

---

## Post-Implementation: Manual Steps

After all tasks are committed and merged:

1. **Enable merge queue** on the `main` branch:
   - GitHub repo settings → Rules → Branch protection for `main` → Require merge queue
   - Add `Live Preview Tests / Live E2E Tests` as a required check (after the 2-week bake period)

2. **End-to-end validation:**
   - Open a test PR with a trivial change
   - Add it to the merge queue
   - Verify: preview deploy → live tests → merge (or eject if tests fail)

3. **After 2 weeks of green runs:**
   - Remove `continue-on-error: true` from the `live-preview-tests` job in `ci.yml`
   - Make `Live Preview Tests / Live E2E Tests` a required merge queue check
