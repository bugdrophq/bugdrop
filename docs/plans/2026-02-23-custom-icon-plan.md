# Custom Icon (`data-icon`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to replace the default 🐛 emoji with a custom image via `data-icon` attribute.

**Architecture:** Add `iconUrl` to `WidgetConfig`, extract a `getTriggerIconHtml()` helper used by both trigger button creation sites, add `<img>` CSS sizing rules, create a test HTML page, and add E2E tests.

**Tech Stack:** TypeScript, Shadow DOM CSS, Playwright E2E

---

### Task 1: Create test page for custom icon

**Files:**
- Create: `public/test/icon-custom.html`

**Step 1: Create the test HTML page**

Follow the pattern from `public/test/color-custom.html`. Create a minimal page that loads the widget with `data-icon` pointing to a known image. Use a data URI for a simple 1x1 green PNG so the test is self-contained with no external dependencies:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BugDrop Custom Icon Test</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      padding: 2rem;
      background: #1a1b26;
      color: #c0caf5;
    }
    h1 { margin-bottom: 1rem; }
    p { color: #787c99; margin-bottom: 1rem; }
    .info {
      background: rgba(125, 207, 255, 0.1);
      border: 1px solid rgba(125, 207, 255, 0.2);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <h1>Custom Icon Test</h1>
  <div class="info">
    <p><strong>Test:</strong> This page loads BugDrop with <code>data-icon</code> set to a data URI image.</p>
    <p>The feedback button should show a custom image instead of the default 🐛 emoji.</p>
  </div>

  <!-- Load BugDrop WITH custom icon (1x1 green PNG as data URI) -->
  <script src="/widget.js" data-repo="neonwatty/feedback-widget-test" data-theme="dark" data-icon="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="></script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add public/test/icon-custom.html
git commit -m "Add test page for custom icon feature"
```

---

### Task 2: Add CSS rule for custom icon images

**Files:**
- Modify: `src/widget/ui.ts:130-133` (after `.bd-trigger-icon` block)

**Step 1: Add the img sizing rule**

In `src/widget/ui.ts`, find the `.bd-trigger-icon` CSS rule (around line 130-133). After it, add:

```css
    .bd-trigger-icon img {
      width: 18px;
      height: 18px;
      object-fit: contain;
      display: block;
    }
```

**Step 2: Add mobile responsive rule**

In the `@media (max-width: 640px)` block (around line 750), find `.bd-trigger-icon` (around line 758-760). After it, add:

```css
      .bd-trigger-icon img {
        width: 16px;
        height: 16px;
      }
```

**Step 3: Commit**

```bash
git add src/widget/ui.ts
git commit -m "Add CSS sizing rules for custom icon images"
```

---

### Task 3: Add iconUrl to config and implement getTriggerIconHtml helper

**Files:**
- Modify: `src/widget/index.ts:10-28` (WidgetConfig interface)
- Modify: `src/widget/index.ts:179-200` (config parsing)
- Modify: `src/widget/index.ts:279` (initWidget trigger creation)
- Modify: `src/widget/index.ts:398` (createTriggerButton trigger creation)

**Step 1: Add iconUrl to WidgetConfig**

In `src/widget/index.ts`, find the `WidgetConfig` interface (line 10). Add after `accentColor`:

```typescript
  // Custom icon URL (replaces default bug emoji)
  iconUrl?: string;
```

**Step 2: Parse data-icon from script tag**

In the config object (around line 199), add after `accentColor`:

```typescript
  // Custom icon URL
  iconUrl: script?.dataset.icon || undefined,
```

**Step 3: Add getTriggerIconHtml helper function**

Add this function before `initWidget` (before line 247):

```typescript
// Build the trigger button icon HTML - custom image with emoji fallback, or default emoji
function getTriggerIconHtml(config: WidgetConfig): string {
  if (config.iconUrl) {
    return `<img src="${config.iconUrl}" alt="" onerror="this.style.display='none';this.nextSibling.style.display=''"><span style="display:none">🐛</span>`;
  }
  return '🐛';
}
```

**Step 4: Use helper in initWidget**

Replace line 279:
```typescript
    trigger.innerHTML = '<span class="bd-trigger-icon">🐛</span><span class="bd-trigger-label">Feedback</span>';
```
With:
```typescript
    trigger.innerHTML = `<span class="bd-trigger-icon">${getTriggerIconHtml(config)}</span><span class="bd-trigger-label">Feedback</span>`;
```

**Step 5: Use helper in createTriggerButton**

Replace line 398:
```typescript
  trigger.innerHTML = '<span class="bd-trigger-icon">🐛</span><span class="bd-trigger-label">Feedback</span>';
```
With:
```typescript
  trigger.innerHTML = `<span class="bd-trigger-icon">${getTriggerIconHtml(config)}</span><span class="bd-trigger-label">Feedback</span>`;
```

**Step 6: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat: add data-icon support for custom trigger button icon"
```

---

### Task 4: Add E2E tests for custom icon

**Files:**
- Modify: `e2e/widget.spec.ts` (add tests in the Custom Accent Color section or create new section)

**Step 1: Add test for custom icon rendering**

Find the custom color test section (around line 1076). After the last test in that `describe` block, add a new describe block:

```typescript
test.describe('Custom Icon', () => {
  test('custom icon renders img element with correct src', async ({ page }) => {
    await page.goto('/test/icon-custom.html');
    await page.waitForTimeout(500);

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Should have an img inside the trigger icon
    const img = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon img');
    await expect(img).toBeVisible();

    // Img src should contain the data URI
    const src = await img.getAttribute('src');
    expect(src).toContain('data:image/png;base64,');
  });

  test('broken icon URL falls back to default emoji', async ({ page }) => {
    // Navigate to a page and inject widget with broken icon URL
    await page.goto('/test/icon-custom.html');
    await page.waitForTimeout(500);

    // Modify the page to use a broken URL by evaluating script
    await page.evaluate(() => {
      const host = document.getElementById('bugdrop-host');
      if (host) host.remove();

      const script = document.createElement('script');
      script.src = '/widget.js';
      script.dataset.repo = 'neonwatty/feedback-widget-test';
      script.dataset.theme = 'dark';
      script.dataset.icon = 'https://invalid.example.com/nonexistent.png';
      document.body.appendChild(script);
    });
    await page.waitForTimeout(1000);

    const triggerIcon = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon');
    await expect(triggerIcon).toBeVisible({ timeout: 5000 });

    // The img should be hidden (display:none from onerror) and fallback emoji visible
    const fallbackText = await triggerIcon.textContent();
    expect(fallbackText).toContain('🐛');
  });

  test('default emoji shows when no data-icon is set', async ({ page }) => {
    await page.goto('/test/index.html');
    await page.waitForTimeout(500);

    const triggerIcon = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon');
    await expect(triggerIcon).toBeVisible({ timeout: 5000 });

    // Should NOT have an img element
    const img = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon img');
    await expect(img).not.toBeAttached();

    // Should have the default emoji
    const text = await triggerIcon.textContent();
    expect(text).toContain('🐛');
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `cd /tmp/bugdrop && npx playwright test e2e/widget.spec.ts --grep "Custom Icon" -v`
Expected: All 3 tests PASS

**Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: add E2E tests for custom icon feature"
```

---

### Task 5: Update README documentation

**Files:**
- Modify: `README.md:50-63` (Widget Options table)

**Step 1: Add data-icon row to the Widget Options table**

In `README.md`, find the Widget Options table (around line 50). Add a new row after `data-color`:

```markdown
| `data-icon` | Image URL | (bug emoji) |
```

The full table should look like:
```
| Attribute | Values | Default |
|-----------|--------|---------|
| `data-repo` | `owner/repo` | required |
| `data-theme` | `light`, `dark`, `auto` | `auto` |
| `data-position` | `bottom-right`, `bottom-left` | `bottom-right` |
| `data-color` | Hex color (e.g. `#FF6B35`) | `#14b8a6` (teal) |
| `data-icon` | Image URL | (bug emoji) |
| `data-show-name` | `true`, `false` | `false` |
```

**Step 2: Add a usage example after the existing color example**

After the example code block (around line 71), add:

```markdown

### Custom Icon

Replace the default bug emoji with your own image:

```html
<script src="https://bugdrop.neonwatty.workers.dev/widget.js"
        data-repo="owner/repo"
        data-icon="https://example.com/my-logo.svg"></script>
```

The image is displayed at 18px (16px on mobile). If the image fails to load, the default bug emoji is shown as a fallback.
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add data-icon to widget options documentation"
```

---

### Task 6: Run full test suite and verify

**Step 1: Run all E2E tests**

Run: `cd /tmp/bugdrop && npx playwright test`
Expected: All tests pass, including existing tests (no regressions)

**Step 2: Run linting**

Run: `cd /tmp/bugdrop && npm run lint`
Expected: No errors

**Step 3: Run type checking**

Run: `cd /tmp/bugdrop && npx tsc --noEmit`
Expected: No errors

**Step 4: If any failures, fix and re-run**

**Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test/lint issues from custom icon feature"
```
