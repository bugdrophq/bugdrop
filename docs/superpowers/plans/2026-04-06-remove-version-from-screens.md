# Remove Version Number from Non-Essential Screens

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the widget version badge only on welcome, success, and error screens — not on workflow screens like the form, screenshot options, loading spinners, or annotation view.

**Architecture:** Add an optional `showVersion` boolean (default `false`) to `createModal()`. Callers that want the version pass `true`. The version `<div>` is conditionally rendered, not hidden with CSS.

**Tech Stack:** TypeScript, esbuild (widget build), Vitest (unit), Playwright (E2E)

**Spec:** `docs/superpowers/specs/2026-04-06-remove-version-from-screens-design.md`

---

### Task 1: Add `showVersion` parameter to `createModal`

**Files:**
- Modify: `src/widget/ui.ts:1060-1078`

- [ ] **Step 1: Add `showVersion` parameter and conditional rendering**

In `src/widget/ui.ts` at line 1060, add a 4th parameter `showVersion: boolean = false` to the `createModal` function signature.

Then at line 1073, replace the unconditional version div:
```
<div class="bd-version">BugDrop v${widgetVersion}</div>
```
with a conditional expression:
```
${showVersion ? `<div class="bd-version">BugDrop v${widgetVersion}</div>` : ''}
```

No other changes to this function. The existing template string and DOM construction stay the same.

- [ ] **Step 2: Verify the build succeeds**

Run: `npm run build:widget`
Expected: Build completes with no errors. All existing callers still work because the new param defaults to `false`.

- [ ] **Step 3: Commit**

```bash
git add src/widget/ui.ts
git commit -m "feat: add showVersion param to createModal (default false)"
```

---

### Task 2: Pass `showVersion: true` at welcome, success, and error call sites

**Files:**
- Modify: `src/widget/ui.ts:1100` (success modal)
- Modify: `src/widget/index.ts:665,735,762,1137` (error screens + welcome)

For each call site below, add `true` as the 4th argument to the `createModal(container, title, content)` call. Do not change any other arguments.

- [ ] **Step 1: Update `showSuccessModal` in `ui.ts`**

At `src/widget/ui.ts:1100`, the `createModal(container, 'Feedback Submitted!', ...)` call inside `showSuccessModal`. Add `true` after the content template literal argument.

- [ ] **Step 2: Update `showWelcomeScreen` in `index.ts`**

At `src/widget/index.ts:762`, the `createModal(root, 'Share Your Feedback', ...)` call inside `showWelcomeScreen`. Add `true` after the content argument.

- [ ] **Step 3: Update capture error modal in `index.ts`**

At `src/widget/index.ts:665`, the `createModal(root, 'Capture Failed', ...)` call inside `captureWithLoading`'s catch block. Add `true` after the content argument.

- [ ] **Step 4: Update `showInstallPrompt` in `index.ts`**

At `src/widget/index.ts:735`, the `createModal(root, title, ...)` call inside `showInstallPrompt`. Add `true` after the content argument.

- [ ] **Step 5: Update `showSubmitError` in `index.ts`**

At `src/widget/index.ts:1137`, the `createModal(root, 'Submission Failed', ...)` call inside `showSubmitError`. Add `true` after the content argument.

- [ ] **Step 6: Verify no other call sites need updating**

Confirm these call sites keep the default `false` (no version shown):
- `captureWithLoading` loading modal (~line 645, title "Capturing...")
- `showFeedbackFormWithScreenshotOption` (~line 833, title "Send Feedback")
- `showScreenshotOptions` (~line 946, title "Capture Screenshot")
- `showAnnotationStep` (~line 992, title "Annotate Screenshot")
- `submitFeedback` loading modal (~line 1058, title "Submitting...")

- [ ] **Step 7: Build the widget**

Run: `npm run build:widget`
Expected: Build completes with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/widget/ui.ts src/widget/index.ts
git commit -m "feat: show version only on welcome, success, and error screens"
```

---

### Task 3: Update E2E test for version badge

**Files:**
- Modify: `e2e/widget.spec.ts:369-389`

The existing test at line 369 (`version number appears in modal footer`) checks that the version appears on the welcome screen. We need to extend it to also verify the version disappears on the feedback form screen.

- [ ] **Step 1: Update the existing version test**

Replace the test at lines 369-389 with a new test named `'version number appears on welcome screen but not on form'`. The test should:

1. Route `**/api/check/**` to return `{ installed: true }` (same as current test)
2. Navigate to `/test/`
3. Click the trigger button to open the widget
4. Assert `.bd-version` is visible and matches `/^BugDrop v/` (same as current)
5. Click `[data-action="continue"]` to advance past welcome
6. Wait for `#title` input to be visible (form is showing)
7. Assert `.bd-version` is NOT visible

Use `#bugdrop-host` as the root locator, same as existing tests. Full test code:

```typescript
  test('version number appears on welcome screen but not on form', async ({ page }) => {
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

    // Version should appear on the welcome screen
    const versionEl = host.locator('css=.bd-version');
    await expect(versionEl).toBeVisible({ timeout: 5000 });
    const versionText = await versionEl.textContent();
    expect(versionText).toMatch(/^BugDrop v/);

    // Advance to feedback form
    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await getStartedBtn.click();

    // Version should NOT appear on the form screen
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await expect(versionEl).not.toBeVisible();
  });
```

- [ ] **Step 2: Build the widget and run the updated test**

Run: `npm run build:widget && npx playwright test e2e/widget.spec.ts --grep "version number"`
Expected: Test passes — version visible on welcome, hidden on form.

- [ ] **Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: verify version badge visibility per screen type"
```

---

### Task 4: Run full test suite

- [ ] **Step 1: Run linting**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Run full E2E suite**

Run: `npx playwright test`
Expected: All tests pass, including the updated version badge test.

- [ ] **Step 4: Fix any failures**

If any tests fail, diagnose and fix. Re-run until green.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test failures from version badge changes"
```
