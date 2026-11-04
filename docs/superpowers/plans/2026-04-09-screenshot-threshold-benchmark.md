# Screenshot Threshold Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright benchmark that measures full-page screenshot capture duration and success/failure across a range of DOM node counts, producing data to set the threshold for hiding the Full Page and Select Area buttons.

**Architecture:** A parameterized HTML test fixture generates N DOM nodes via query param. A standalone Playwright spec drives the widget through the capture flow at each node count, times it, and writes results to JSON + stdout table. Runs outside CI — contributors run it locally and share results.

**Tech Stack:** Playwright, HTML/JS test fixture, wrangler dev server

**Note on pixel ratios:** The spec mentions testing at both `pixelRatio: 2` and `pixelRatio: 1` (16 total cases). The plan simplifies to 8 cases using real widget behavior: below 3k nodes, `getPixelRatio` returns 2 (the default); above 3k, it auto-reduces to 1. This matches what users actually experience and avoids needing to bypass the widget's internal logic. The results table will implicitly show both regimes.

---

### Task 1: Parameterize the complex DOM test fixture

**Files:**
- Modify: `public/test/complex-dom.html`

- [ ] **Step 1: Update the node generation script to read `?nodes=N`**

Replace the entire `<script>` block (lines 18–30) in `public/test/complex-dom.html`:

```html
<script>
  // Read target node count from query param, default to 4000
  const params = new URLSearchParams(window.location.search);
  const TARGET_NODES = parseInt(params.get('nodes') || '4000', 10);
  const CHILDREN_PER_GROUP = 10;
  const root = document.getElementById('complex-root');

  let created = 0;
  while (created < TARGET_NODES) {
    const group = document.createElement('div');
    group.className = 'group';
    const groupSize = Math.min(CHILDREN_PER_GROUP, TARGET_NODES - created);
    for (let i = 0; i < groupSize; i++) {
      const el = document.createElement('span');
      el.className = 'node';
      el.textContent = `Item ${created + i}`;
      group.appendChild(el);
      created++;
    }
    root.appendChild(group);
  }

  document.getElementById('node-count').textContent =
    document.body.querySelectorAll('*').length;
</script>
```

- [ ] **Step 2: Add the `.group` CSS class**

In the `<style>` block, add after the `.node` rule:

```css
.group { margin: 4px 0; }
```

- [ ] **Step 3: Verify existing E2E tests still pass**

Run: `npx playwright test e2e/widget.spec.ts -g "complex DOM" --project chromium`
Expected: passes — default is still 4000 nodes, same as before.

- [ ] **Step 4: Manual sanity check**

Run: `npm run dev` then open `http://localhost:8787/test/complex-dom.html?nodes=100` — should show ~100 nodes.
Open `http://localhost:8787/test/complex-dom.html` — should show ~4000 nodes (default).

- [ ] **Step 5: Commit**

```bash
git add public/test/complex-dom.html
git commit -m "feat: parameterize complex-dom.html with ?nodes=N query param"
```

---

### Task 2: Create the benchmark Playwright config

**Files:**
- Create: `benchmarks/playwright.config.ts`

- [ ] **Step 1: Create the config file**

```ts
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8787';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL,
  },
  projects: [
    {
      name: 'benchmark',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:8787',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
```

Key differences from main config: single worker, no retries, 90s timeout, `reuseExistingServer: true` always (so it picks up an already-running `wrangler dev`), `list` reporter for clean stdout.

- [ ] **Step 2: Commit**

```bash
git add benchmarks/playwright.config.ts
git commit -m "chore: add Playwright config for benchmarks"
```

---

### Task 3: Create the benchmark spec

**Files:**
- Create: `benchmarks/screenshot-threshold.spec.ts`
- Create: `benchmarks/results/.gitkeep`

- [ ] **Step 1: Create the results directory**

```bash
mkdir -p benchmarks/results
touch benchmarks/results/.gitkeep
```

- [ ] **Step 2: Write the benchmark spec**

```ts
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NODE_COUNTS = [1000, 2000, 3000, 5000, 7000, 10000, 12000, 15000];

interface BenchmarkResult {
  nodes: number;
  actualNodes: number;
  durationMs: number;
  outcome: 'success' | 'error' | 'timeout';
}

const results: BenchmarkResult[] = [];

// Navigate widget to the "Full Page" capture button and click it.
// Returns the timestamp immediately after clicking.
async function navigateToFullPageCapture(page: Page): Promise<number> {
  const host = page.locator('#bugdrop-host');

  // Open widget
  const trigger = host.locator('css=.bd-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();

  // Welcome screen — click through
  const getStartedBtn = host.locator('css=[data-action="continue"]');
  await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  await getStartedBtn.click();

  // Fill minimal form
  const titleInput = host.locator('css=#title');
  await expect(titleInput).toBeVisible({ timeout: 5_000 });
  await titleInput.fill('Benchmark test');

  // Ensure screenshot checkbox is checked
  const screenshotCheckbox = host.locator('css=#include-screenshot');
  await screenshotCheckbox.check();

  // Submit form
  const submitBtn = host.locator('css=#submit-btn');
  await submitBtn.click();

  // Click "Full Page"
  const captureBtn = host.locator('css=[data-action="capture"]');
  await expect(captureBtn).toBeVisible({ timeout: 5_000 });

  const startTime = Date.now();
  await captureBtn.click();

  return startTime;
}

for (const nodeCount of NODE_COUNTS) {
  test(`capture at ${nodeCount} nodes`, async ({ page }) => {
    // Navigate to fixture with target node count
    await page.goto(`/test/complex-dom.html?nodes=${nodeCount}`, {
      waitUntil: 'networkidle',
    });

    // Verify actual node count
    const actualNodes = await page.evaluate(() =>
      document.body.querySelectorAll('*').length
    );

    // Drive the widget to Full Page capture
    const startTime = await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const annotationCanvas = host.locator('css=#annotation-canvas');
    const errorMessage = host.locator('css=.bd-error-message__text');

    try {
      // Wait for either success (annotation step) or failure (error modal)
      // Use 60s inner timeout — Playwright's 90s timeout is the outer safety net
      await Promise.race([
        annotationCanvas.waitFor({ state: 'visible', timeout: 60_000 }),
        errorMessage.waitFor({ state: 'visible', timeout: 60_000 }),
      ]);

      const durationMs = Date.now() - startTime;
      const succeeded = await annotationCanvas.isVisible();

      results.push({
        nodes: nodeCount,
        actualNodes,
        durationMs,
        outcome: succeeded ? 'success' : 'error',
      });
    } catch {
      // Neither appeared within 60s — hard freeze / timeout
      const durationMs = Date.now() - startTime;
      results.push({
        nodes: nodeCount,
        actualNodes,
        durationMs,
        outcome: 'timeout',
      });
    }
  });
}

test.afterAll(() => {
  if (results.length === 0) return;

  // Print markdown table to stdout
  const header = '| Nodes | Actual | Duration (ms) | Outcome |';
  const divider = '|------:|-------:|--------------:|---------|';
  const rows = results.map(
    r =>
      `| ${r.nodes} | ${r.actualNodes} | ${r.durationMs} | ${r.outcome} |`
  );

  console.log('\n## Screenshot Threshold Benchmark Results\n');
  console.log(header);
  console.log(divider);
  rows.forEach(row => console.log(row));
  console.log('');

  // Save JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = join(__dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `screenshot-threshold-${timestamp}.json`);

  const output = {
    timestamp: new Date().toISOString(),
    userAgent: 'Playwright Chromium (headless)',
    results,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to: ${outPath}\n`);
});
```

- [ ] **Step 3: Run the benchmark to verify it works**

Run: `npx playwright test --config benchmarks/playwright.config.ts`
Expected: 8 tests run sequentially. Low node counts pass quickly, high counts may timeout. A markdown table prints to stdout and a JSON file appears in `benchmarks/results/`.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/screenshot-threshold.spec.ts benchmarks/results/.gitkeep
git commit -m "feat: add screenshot threshold benchmark spec"
```

---

### Task 4: Add npm script and gitignore entries

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add the npm script to `package.json`**

In the `"scripts"` section, add after the `"test:e2e:ui"` line:

```json
"benchmark:screenshot": "npx playwright test --config benchmarks/playwright.config.ts",
```

- [ ] **Step 2: Add gitignore entry for benchmark results**

Append to `.gitignore`:

```
# Benchmark results (machine-specific)
benchmarks/results/*.json
```

- [ ] **Step 3: Verify the npm script works**

Run: `npm run benchmark:screenshot`
Expected: Same output as running the Playwright command directly.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add benchmark:screenshot script and gitignore results"
```

---

### Task 5: Write the benchmark README

**Files:**
- Create: `benchmarks/README.md`

- [ ] **Step 1: Write the README**

```markdown
# Screenshot Threshold Benchmark

Measures how long `html-to-image` takes to capture a full-page screenshot at
various DOM node counts. Used to determine the threshold at which the widget
should hide the Full Page and Select Area buttons (issue #101).

## Prerequisites

- Node.js 20+
- `npm install`
- `npm run build:widget` (the benchmark loads the real widget bundle)

## Running

```bash
npm run benchmark:screenshot
```

This starts `wrangler dev` automatically if it isn't already running, then runs
8 test cases (1k to 15k DOM nodes) sequentially in headless Chromium.

Takes ~2-5 minutes depending on your machine.

## Output

**Stdout** — a markdown table:

| Nodes | Actual | Duration (ms) | Outcome |
|------:|-------:|--------------:|---------|
|  1000 |   1023 |           420 | success |
|  3000 |   3034 |          1850 | success |
| 10000 |  10012 |         48200 | timeout |
| ...   |    ... |           ... | ...     |

**JSON file** — saved to `benchmarks/results/screenshot-threshold-<timestamp>.json`
with full results and metadata. These files are gitignored.

## Sharing Results

To help us pick the right threshold across different machines, share your results
by pasting the JSON file contents in issue #101 or a linked discussion.

## What It Measures

Each test case:
1. Generates N DOM nodes on a test page (nested divs with styled leaf nodes)
2. Opens the BugDrop widget and triggers a full-page screenshot capture
3. Measures wall-clock time from the "Full Page" click to either:
   - **success** — annotation canvas appears (capture completed)
   - **error** — error modal appears (capture failed gracefully)
   - **timeout** — neither appeared within 60s (main thread frozen)

The widget's existing `pixelRatio` reduction kicks in automatically above 3,000
nodes, so results above that threshold reflect `pixelRatio: 1` behavior.
```

- [ ] **Step 2: Commit**

```bash
git add benchmarks/README.md
git commit -m "docs: add benchmark README with contributor instructions"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Build the widget**

Run: `npm run build:widget`
Expected: `public/widget.js` is created.

- [ ] **Step 2: Run existing E2E tests to confirm no regressions**

Run: `npx playwright test e2e/widget.spec.ts -g "complex DOM" --project chromium`
Expected: passes — the `complex-dom.html` default is still 4000 nodes.

- [ ] **Step 3: Run the full benchmark**

Run: `npm run benchmark:screenshot`
Expected: 8 tests execute. Markdown table printed. JSON file created in `benchmarks/results/`.

- [ ] **Step 4: Verify JSON output**

Check that `benchmarks/results/` contains one `.json` file and that it's well-formed:

```bash
ls benchmarks/results/*.json
cat benchmarks/results/screenshot-threshold-*.json | head -20
```

- [ ] **Step 5: Verify gitignore works**

Run: `git status`
Expected: The JSON results file does NOT appear in untracked files. `.gitkeep` does if not yet tracked.

- [ ] **Step 6: Final commit if any fixes were needed**

If any changes were made during verification:

```bash
git add -A
git commit -m "fix: address issues found during benchmark verification"
```
