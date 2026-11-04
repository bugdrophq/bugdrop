# Screenshot Threshold Benchmark

**Issue:** #101
**Date:** 2026-04-09

## Problem

We need to determine the DOM node count threshold at which full-page screenshot capture
should be disabled. The current `DOM_COMPLEXITY_THRESHOLD` (3,000 nodes) reduces `pixelRatio`
but doesn't prevent capture attempts. Issue #101 reports that pages with 11,500+ nodes freeze
the tab entirely because `html-to-image` blocks the main thread during DOM cloning.

We need empirical data — not guesses — to set the threshold where we hide the Full Page and
Select Area buttons. This benchmark produces that data.

## Approach

A standalone Playwright benchmark (not part of CI) that measures screenshot capture duration
and success/failure across a range of DOM node counts. Contributors can run it on their own
machines and share results to build a cross-machine dataset.

## Parameterized Test Fixture

Extend `public/test/complex-dom.html` to accept a `?nodes=N` query parameter. Default stays
at 4,000 so existing E2E tests are unaffected.

Generated DOM structure:
- Nested hierarchy: container divs each holding 10 child elements (mirrors real-world trees)
- Each leaf node gets a CSS class with `padding`, `border`, `font-size` (forces computed
  style cloning in `html-to-image`)
- Text content in every leaf (forces text node creation)
- Display the actual post-generation node count in `#node-count` (already exists)

## Benchmark Script

`benchmarks/screenshot-threshold.spec.ts` — a Playwright test file that runs outside the
main E2E suite.

**Test matrix:**
- Node counts: `[1000, 2000, 3000, 5000, 7000, 10000, 12000, 15000]`
- Pixel ratios: both `pixelRatio: 2` (default) and `pixelRatio: 1` (current reduction for
  complex DOMs)
- Total: 16 test cases, run sequentially

**For each test case:**
1. Navigate to `/test/complex-dom.html?nodes=N`
2. Verify actual node count via `page.evaluate()`
3. Open widget, fill form, opt into screenshot, click "Full Page"
4. Start a timer at the moment "Full Page" is clicked
5. Wait for one of:
   - Annotation step appears (success)
   - Error modal appears (capture failed)
   - 60s Playwright timeout (hard freeze)
6. Record: `{ nodes, pixelRatio, durationMs, outcome: 'success' | 'error' | 'timeout' }`

**Output:**
- Markdown table printed to stdout for quick reading
- JSON saved to `benchmarks/results/screenshot-threshold-<timestamp>.json` for sharing

## Benchmark Playwright Config

`benchmarks/playwright.config.ts` — minimal config:
- `testDir: './benchmarks'`
- `testMatch: '**/*.spec.ts'`
- Single worker (sequential for consistent timing)
- 90s timeout per test (accommodates slow captures + navigation overhead)
- No retries
- Same `baseURL` and `webServer` setup as main config

## npm Script

```
"benchmark:screenshot": "npx playwright test --config benchmarks/playwright.config.ts"
```

## Benchmark README

`benchmarks/README.md` — short doc covering:
- What the benchmark measures and why
- Prerequisites (`npm install`, `npm run build:widget`)
- How to run (`npm run benchmark:screenshot`)
- How to read results (stdout table + JSON file)
- How to share results (paste JSON or open a discussion)

## Files Changed

- **Modify:** `public/test/complex-dom.html` — add `?nodes=N` query param support
- **Create:** `benchmarks/playwright.config.ts` — benchmark-specific Playwright config
- **Create:** `benchmarks/screenshot-threshold.spec.ts` — the benchmark script
- **Create:** `benchmarks/README.md` — contributor instructions
- **Create:** `benchmarks/results/.gitkeep` — empty results dir (JSON output is gitignored)
- **Modify:** `package.json` — add `benchmark:screenshot` script
- **Modify:** `.gitignore` — add `benchmarks/results/*.json`

## What This Does NOT Do

- Does not bundle `html-to-image` — benchmark measures the current CDN-loaded behavior
- Does not run in CI — results are machine-dependent and the benchmark is slow (~2-3 min)
- Does not test element capture — expected to work fine (small subtree cloning)
- Does not test area capture separately — it uses the same full-page capture path
