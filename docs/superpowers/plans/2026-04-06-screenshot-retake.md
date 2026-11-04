# Screenshot Retake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Retake" button to the annotation step that loops the user back to the screenshot options modal, allowing them to recapture before submitting.

**Architecture:** Change `showAnnotationStep` to return `string | 'retake'`, add a Retake button, and wrap the screenshot flow in `startFeedbackFlow` in a `while` loop that reruns on retake.

**Tech Stack:** TypeScript, esbuild, Playwright (E2E)

**Spec:** `docs/superpowers/specs/2026-04-06-screenshot-retake-design.md`

---

## File Structure

| File | Action | Change |
|------|--------|--------|
| `src/widget/index.ts` | Modify | Add Retake button to annotation step, wrap screenshot flow in while loop |
| `e2e/widget.spec.ts` | Modify | E2E test for Retake button |

---

### Task 1: Add Retake button to `showAnnotationStep`

**Files:**
- Modify: `src/widget/index.ts:1009-1077`

- [ ] **Step 1: Change return type and add Retake button**

In `src/widget/index.ts`, change the `showAnnotationStep` function signature at line 1009 from:

```typescript
function showAnnotationStep(
  root: HTMLElement,
  screenshot: string,
  config?: WidgetConfig
): Promise<string> {
```

to:

```typescript
function showAnnotationStep(
  root: HTMLElement,
  screenshot: string,
  config?: WidgetConfig
): Promise<string | 'retake'> {
```

In the modal content template (lines 1026-1029), change the actions div from:

```html
        <div class="bd-actions">
          <button class="bd-btn bd-btn-secondary" data-action="skip">Skip Annotations</button>
          <button class="bd-btn bd-btn-primary" data-action="done">Done</button>
        </div>
```

to:

```html
        <div class="bd-actions">
          <button class="bd-btn bd-btn-secondary" data-action="retake">Retake</button>
          <button class="bd-btn bd-btn-secondary" data-action="skip">Skip Annotations</button>
          <button class="bd-btn bd-btn-primary" data-action="done">Done</button>
        </div>
```

- [ ] **Step 2: Add Retake button query selector and click handler**

After the existing button query selectors (line 1056), add:

```typescript
    const retakeBtn = modal.querySelector('[data-action="retake"]') as HTMLElement;
```

After the `skipBtn` click handler (after line 1068), add:

```typescript
    retakeBtn?.addEventListener('click', () => {
      annotator.destroy();
      modal.remove();
      resolve('retake');
    });
```

- [ ] **Step 3: Build the widget**

Run: `npm run build:widget`
Expected: Builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat: add Retake button to annotation step"
```

---

### Task 2: Wrap screenshot flow in while loop for retake

**Files:**
- Modify: `src/widget/index.ts:593-633`

- [ ] **Step 1: Wrap the screenshot flow in a while loop**

In `startFeedbackFlow`, the screenshot flow currently starts at line 593 with `let screenshot: string | null = null;`. Replace the entire block from line 593 through line 633 (ending after `screenshot = await showAnnotationStep(...)`) with:

```typescript
  let screenshot: string | null = null;
  let elementSelector: string | null = null;

  // Step 3: Screenshot flow (if user opted in)
  if (formResult.includeScreenshot) {
    let retake = true;
    while (retake) {
      retake = false;
      screenshot = null;
      elementSelector = null;

      const screenshotChoice = await showScreenshotOptions(root);
      const pickerStyle = {
        accentColor: config.accentColor,
        font: config.font,
        radius: config.radius,
        borderWidth: config.borderWidth,
        bgColor: config.bgColor,
        textColor: config.textColor,
        borderColor: config.borderColor,
        theme: config.theme,
      };

      if (screenshotChoice === 'capture') {
        screenshot = await captureWithLoading(root, undefined, config.screenshotScale);
      } else if (screenshotChoice === 'element') {
        const element = await createElementPicker(pickerStyle);
        if (element) {
          screenshot = await captureWithLoading(root, element, config.screenshotScale);
          elementSelector = getElementSelector(element);
        }
      } else if (screenshotChoice === 'area') {
        const rect = await createAreaPicker(pickerStyle);
        if (rect) {
          const pixelRatio = getPixelRatio(true, config.screenshotScale);
          const fullPage = await captureWithLoading(root, undefined, config.screenshotScale);
          if (fullPage) {
            screenshot = await cropScreenshot(fullPage, rect, pixelRatio);
          }
        }
      }

      // Step 4: Annotate (if screenshot exists)
      if (screenshot) {
        const result = await showAnnotationStep(root, screenshot, config);
        if (result === 'retake') {
          retake = true;
        } else {
          screenshot = result;
        }
      }
    }
  }
```

The key differences from the original:
- `let retake = true; while (retake)` loop wraps the entire screenshot flow
- `screenshot` and `elementSelector` are reset to `null` at the top of each iteration
- `pickerStyle` is now inside the loop (reconstructed each iteration — same values, but scoped correctly)
- After annotation, if `result === 'retake'`, set `retake = true` to loop again
- Otherwise, `screenshot = result` as before and the loop exits

- [ ] **Step 2: Build the widget**

Run: `npm run build:widget`
Expected: Builds successfully.

- [ ] **Step 3: Run unit tests**

Run: `npm test`
Expected: All tests pass (no unit tests touch this flow).

- [ ] **Step 4: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat: wrap screenshot flow in retake loop"
```

---

### Task 3: Add E2E test for Retake button

**Files:**
- Modify: `e2e/widget.spec.ts`

- [ ] **Step 1: Add E2E test for retake flow**

Add this test inside the `Widget Interaction` describe block, after the existing area picker test:

```typescript
  test('retake button on annotation step returns to screenshot options', async ({ page }) => {
    // Mock html-to-image to return a small valid PNG
    await page.addInitScript(() => {
      (window as any).__bugdropMockScreenshot = true;
    });

    await page.route('**/api/check/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Click through welcome
    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Fill form and submit with screenshot
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test retake');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const submitBtn = host.locator('css=#submit-btn');
    await submitBtn.click();

    // Click "Full Page" to capture
    const fullPageBtn = host.locator('css=[data-action="capture"]');
    await expect(fullPageBtn).toBeVisible({ timeout: 5000 });
    await fullPageBtn.click();

    // Wait for annotation step to appear
    const retakeBtn = host.locator('css=[data-action="retake"]');
    await expect(retakeBtn).toBeVisible({ timeout: 15000 });

    // Click Retake
    await retakeBtn.click();

    // Should be back at screenshot options
    await expect(fullPageBtn).toBeVisible({ timeout: 5000 });

    // All 4 screenshot options should be available
    const skipBtn = host.locator('css=[data-action="skip"]');
    const elementBtn = host.locator('css=[data-action="element"]');
    const areaBtn = host.locator('css=[data-action="area"]');
    await expect(skipBtn).toBeVisible();
    await expect(elementBtn).toBeVisible();
    await expect(areaBtn).toBeVisible();
  });
```

Note: The annotation step timeout is 15000ms because the full-page screenshot capture can take several seconds on the test page.

- [ ] **Step 2: Build widget and run the test**

Run: `npm run build:widget && npx playwright test e2e/widget.spec.ts --grep "retake button"`
Expected: Test passes.

- [ ] **Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: add E2E test for screenshot retake flow"
```

---

### Task 4: Run full test suite

- [ ] **Step 1: Run linting**

Run: `npm run lint`
Expected: No errors (warnings are pre-existing).

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Run full E2E suite**

Run: `npx playwright test`
Expected: All local tests pass (live tests expected to fail locally).

- [ ] **Step 4: Fix any failures**

If any tests fail, diagnose and fix. Re-run until green.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test failures from retake changes"
```
