# Merge Queue Cross-Browser Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add merge-queue-only preview smoke tests that run the deployed widget against Chromium, Firefox, and Playwright WebKit before code reaches `main`.

**Architecture:** Keep the existing full `chromium-live` suite unchanged. Add a smaller `*.cross-browser-live.spec.ts` suite with browser-stable smoke coverage, then run it in a parallel GitHub Actions matrix after the preview Worker deployment is ready. The WebKit leg intentionally validates the complex-page screenshot option behavior from issue #158 without starting full-page capture.

**Tech Stack:** GitHub Actions `merge_group`, Cloudflare Workers preview deployment, Vercel preview venue, Playwright projects for Chromium/Firefox/WebKit, TypeScript.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `playwright.config.ts` | Add cross-browser live Playwright projects that match only `*.cross-browser-live.spec.ts`. |
| Create | `e2e/widget.cross-browser-live.spec.ts` | Browser-stable live smoke tests for widget load, submit-without-screenshot, and complex screenshot options. |
| Modify | `.github/workflows/ci.yml` | Add a merge-queue-only matrix job for Chromium, Firefox, and WebKit after `deploy-preview`. |
| Optional Modify | `Makefile` | Add a local helper for running one cross-browser live project. |

## Task 1: Add Cross-Browser Live Playwright Projects

**Files:**
- Modify: `playwright.config.ts`

- [ ] **Step 1: Confirm current live project list**

Run:

```bash
npx playwright test --list --project=chromium-live
```

Expected: lists tests from `e2e/widget.live.spec.ts`.

- [ ] **Step 2: Add cross-browser live projects**

In `playwright.config.ts`, keep the existing `chromium` and `chromium-live` projects, then add these three projects inside `projects`:

```ts
    {
      name: 'chromium-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: /.*\.cross-browser-live\.spec\.ts/,
      timeout: 60_000,
    },
    {
      name: 'firefox-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Firefox'],
      },
      testMatch: /.*\.cross-browser-live\.spec\.ts/,
      timeout: 60_000,
    },
    {
      name: 'webkit-cross-browser-live',
      fullyParallel: false,
      use: {
        ...devices['Desktop Safari'],
      },
      testMatch: /.*\.cross-browser-live\.spec\.ts/,
      timeout: 60_000,
    },
```

- [ ] **Step 3: Verify Playwright can discover the new empty projects**

Run:

```bash
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test --list --project=webkit-cross-browser-live
```

Expected before Task 2: exits successfully with no tests or reports no matching tests. The important outcome is that Playwright recognizes the project name.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts
git commit -m "test: add cross-browser live playwright projects"
```

## Task 2: Add Focused Cross-Browser Live Smoke Tests

**Files:**
- Create: `e2e/widget.cross-browser-live.spec.ts`

- [ ] **Step 1: Create the failing smoke suite**

Create `e2e/widget.cross-browser-live.spec.ts` with:

```ts
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const expectedWidgetOrigin =
  process.env.EXPECTED_WIDGET_ORIGIN ||
  (process.env.LIVE_TARGET === 'preview'
    ? 'https://bugdrop-preview.neonwatty.workers.dev'
    : process.env.LIVE_TARGET
      ? 'https://bugdrop.neonwatty.workers.dev'
      : undefined);
const expectedWidgetSha256 = process.env.EXPECTED_WIDGET_SHA256;
const venuePath = process.env.LIVE_VENUE_PATH || '/';

if (bypassSecret) {
  test.beforeEach(async ({ context }) => {
    await context.route('**/*.vercel.app/**', async route => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          'x-vercel-protection-bypass': bypassSecret,
        },
      });
    });
  });
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function mockInstalledRepo(page: Page) {
  await page.route('**/api/check/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    });
  });
}

async function openForm(page: Page) {
  const host = page.locator('#bugdrop-host');
  await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 10_000 });
  await host.locator('css=.bd-trigger').click();

  const getStartedBtn = host.locator('css=[data-action="continue"]');
  await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  await getStartedBtn.click();

  await expect(host.locator('css=#title')).toBeVisible({ timeout: 5_000 });
  return host;
}

async function padDom(page: Page, count: number) {
  await page.evaluate(nodeCount => {
    const root = document.createElement('div');
    root.id = 'cross-browser-complexity-padding';
    for (let i = 0; i < nodeCount; i++) {
      const node = document.createElement('span');
      node.textContent = `Complex item ${i}`;
      root.appendChild(node);
    }
    document.body.appendChild(root);
  }, count);
}

test.describe('Cross-Browser Live Preview Smoke', () => {
  test('loads the expected preview widget asset', async ({ page, request }) => {
    await page.goto(venuePath);

    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });
    await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 10_000 });

    const widgetSrc = await page.evaluate(() => {
      return (
        Array.from(document.scripts)
          .map(script => script.src)
          .find(src => src.includes('/widget.js')) || ''
      );
    });

    if (expectedWidgetOrigin) {
      expect(widgetSrc).toContain(`${expectedWidgetOrigin}/widget.js`);
    }

    const response = await request.get(widgetSrc);
    expect(response.ok()).toBeTruthy();

    if (expectedWidgetSha256) {
      expect(sha256(await response.body())).toBe(expectedWidgetSha256);
    }
  });

  test('submits feedback without a screenshot', async ({ page }) => {
    await mockInstalledRepo(page);
    const payloads: Array<Record<string, unknown>> = [];
    await page.route('**/feedback', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto(venuePath);
    const host = await openForm(page);

    await host.locator('css=#title').fill('Cross-browser live smoke');
    await host.locator('css=#submit-btn').click();

    const skipBtn = host.locator('css=[data-action="skip"]');
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click();
    }

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10_000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
  });

  test('handles complex-page screenshot options without starting expensive capture', async ({
    browserName,
    page,
  }) => {
    await mockInstalledRepo(page);
    await page.goto(venuePath);
    await padDom(page, 4000);

    const host = await openForm(page);
    await host.locator('css=#title').fill('Cross-browser complex screenshot smoke');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="element"]')).toBeVisible({ timeout: 5_000 });

    if (browserName === 'webkit') {
      await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
      await expect(host.locator('css=[data-action="area"]')).not.toBeAttached();
      await expect(host.locator('css=p >> text=too complex')).toBeVisible();
      return;
    }

    await expect(host.locator('css=[data-action="capture"]')).toBeVisible();
    await expect(host.locator('css=[data-action="area"]')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the Chromium smoke locally against preview**

Run:

```bash
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test e2e/widget.cross-browser-live.spec.ts --project=chromium-cross-browser-live --workers=1
```

Expected: fails only if the current preview Worker is not serving the local expected SHA. If that happens before CI wiring, rerun without `EXPECTED_WIDGET_SHA256`; in merge queue CI the SHA will be set after deployment.

- [ ] **Step 3: Run the WebKit smoke locally**

Run:

```bash
npx playwright install --with-deps webkit
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test e2e/widget.cross-browser-live.spec.ts --project=webkit-cross-browser-live --workers=1
```

Expected after PR #160 is merged into the preview deployment: WebKit passes and the complex-page test hides full-page and area capture.

- [ ] **Step 4: Commit**

```bash
git add e2e/widget.cross-browser-live.spec.ts
git commit -m "test: add cross-browser live preview smoke tests"
```

## Task 3: Run Cross-Browser Smoke in Merge Queue CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add browser matrix job after `live-preview-tests`**

In `.github/workflows/ci.yml`, add this job after the existing `live-preview-tests` job:

```yaml
  live-preview-cross-browser-tests:
    name: Live Preview Cross-Browser (${{ matrix.browser }})
    runs-on: ubuntu-latest
    needs: [deploy-preview]
    if: github.event_name == 'merge_group'
    strategy:
      fail-fast: false
      matrix:
        browser: [chromium, firefox, webkit]
    env:
      LIVE_TARGET: preview
      PLAYWRIGHT_BASE_URL: https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: make install

      - name: Get Playwright version
        id: pw-version
        run: echo "version=$(npx playwright --version | awk '{print $2}')" >> "$GITHUB_OUTPUT"

      - name: Cache Playwright browsers
        id: pw-cache
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ matrix.browser }}-${{ steps.pw-version.outputs.version }}

      - name: Install Playwright browser
        if: steps.pw-cache.outputs.cache-hit != 'true'
        run: npx playwright install --with-deps ${{ matrix.browser }}

      - name: Install Playwright system deps
        if: steps.pw-cache.outputs.cache-hit == 'true'
        run: npx playwright install-deps ${{ matrix.browser }}

      - name: Verify test venue is reachable
        run: |
          VENUE_URL="${PLAYWRIGHT_BASE_URL}"
          echo "Checking test venue at $VENUE_URL..."
          BYPASS_ARGS=""
          if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
            BYPASS_ARGS="-H x-vercel-protection-bypass:${VERCEL_AUTOMATION_BYPASS_SECRET}"
          fi
          curl -sfo /dev/null $BYPASS_ARGS "$VENUE_URL" || (echo "Test venue unreachable at $VENUE_URL" && exit 1)
          echo "Test venue reachable"
        env:
          VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}

      - name: Record expected preview widget asset
        run: |
          VERSION=$(git describe --tags --abbrev=0) npm run build:widget
          echo "EXPECTED_WIDGET_ORIGIN=https://bugdrop-preview.neonwatty.workers.dev" >> "$GITHUB_ENV"
          echo "EXPECTED_WIDGET_SHA256=$(shasum -a 256 public/widget.js | awk '{print $1}')" >> "$GITHUB_ENV"

      - name: Wait for expected preview widget asset
        run: |
          WIDGET_URL="https://bugdrop-preview.neonwatty.workers.dev/widget.js"
          echo "Waiting for $WIDGET_URL to serve $EXPECTED_WIDGET_SHA256..."
          for i in $(seq 1 30); do
            ACTUAL_SHA="$(curl -sSf "$WIDGET_URL" | shasum -a 256 | awk '{print $1}')"
            if [ "$ACTUAL_SHA" = "$EXPECTED_WIDGET_SHA256" ]; then
              echo "Preview widget asset matched after $((i * 5))s"
              exit 0
            fi
            echo "Attempt $i/30 served $ACTUAL_SHA; waiting 5s..."
            sleep 5
          done
          echo "Preview widget did not serve expected asset $EXPECTED_WIDGET_SHA256"
          exit 1

      - name: Run cross-browser live E2E tests
        run: npx playwright test e2e/widget.cross-browser-live.spec.ts --project=${{ matrix.browser }}-cross-browser-live --workers=1
        env:
          VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}

      - name: Upload cross-browser report
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-cross-browser-report-${{ matrix.browser }}
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Confirm YAML parses**

Run:

```bash
npx prettier --check .github/workflows/ci.yml
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run cross-browser live smoke tests in merge queue"
```

## Task 4: Optional Local Helper

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add a helper target**

Add this target near the existing Playwright targets:

```make
test-live-cross-browser:
	@if [ -z "$(BROWSER)" ]; then \
		echo "Usage: make test-live-cross-browser BROWSER=chromium|firefox|webkit"; \
		exit 1; \
	fi
	npx playwright test e2e/widget.cross-browser-live.spec.ts --project=$(BROWSER)-cross-browser-live --workers=1
```

Update `.PHONY` to include `test-live-cross-browser`.

- [ ] **Step 2: Run the helper once**

Run:

```bash
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app make test-live-cross-browser BROWSER=chromium
```

Expected: same result as the direct Playwright command in Task 2.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "chore: add cross-browser live test helper"
```

## Task 5: Final Verification and PR

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run static checks**

Run:

```bash
npm run format:check
npm run typecheck
npm run lint
```

Expected: all pass. Existing lint warnings are acceptable only if the command exits `0`.

- [ ] **Step 2: Run focused local browser checks**

Run:

```bash
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test e2e/widget.cross-browser-live.spec.ts --project=chromium-cross-browser-live --workers=1
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test e2e/widget.cross-browser-live.spec.ts --project=firefox-cross-browser-live --workers=1
LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://bugdrop-widget-test-git-preview-jermwatts-projects.vercel.app npx playwright test e2e/widget.cross-browser-live.spec.ts --project=webkit-cross-browser-live --workers=1
```

Expected: all pass after PR #160 is included in the deployed preview Worker. If WebKit fails only because the preview Worker has not yet received the Safari threshold fix, wait for #160 to merge and rerun.

- [ ] **Step 3: Open PR**

Run:

```bash
git push -u origin merge-queue-cross-browser-preview
gh pr create --base main --head merge-queue-cross-browser-preview --title "Add merge-queue cross-browser preview smoke tests" --body "## Summary
- add focused cross-browser live Playwright projects
- add live preview smoke coverage for Chromium, Firefox, and WebKit
- run the smoke suite in a merge-queue-only browser matrix after preview deploy

## Verification
- npm run format:check
- npm run typecheck
- npm run lint
- chromium/firefox/webkit cross-browser live smoke locally"
```

Expected: PR opens and normal PR checks run. The new cross-browser preview matrix runs only when the PR enters the merge queue.

## Self-Review

- Spec coverage: The plan adds merge-queue-only preview tests, keeps current Chromium live coverage, adds Firefox/WebKit coverage, and targets the issue #158 WebKit/Safari risk path without broadening the full suite.
- Placeholder scan: No implementation steps use TBD/TODO placeholders.
- Type consistency: Project names are consistently `chromium-cross-browser-live`, `firefox-cross-browser-live`, and `webkit-cross-browser-live`; CI uses `${{ matrix.browser }}-cross-browser-live`.
