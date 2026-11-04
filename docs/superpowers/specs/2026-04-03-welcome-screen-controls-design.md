# Welcome Screen Controls & UX Improvements

**Date:** 2026-04-03
**Status:** Approved

## Summary

Four changes to the BugDrop widget UX:

1. **Welcome screen show-once default** — Welcome appears only on the user's first interaction per repo, not every time
2. **Host-level welcome control** — New `data-welcome` attribute to configure or disable the welcome entirely
3. **Screenshot checkbox defaults to checked** — Since the next screen allows skipping, default to including screenshots
4. **Version number in modal footer** — Display BugDrop version in every modal for debugging

## 1. `data-welcome` Attribute

### Config

Add `welcome` to `WidgetConfig`:

```typescript
welcome: 'once' | 'always' | 'never';  // default: 'once'
```

Parsed from `data-welcome` on the script tag. Values:

| Value | Behavior |
|-------|----------|
| omitted / `"once"` | Show welcome on first open per repo, skip thereafter (default) |
| `"false"` / `"never"` | Never show the welcome screen |
| `"always"` | Show welcome every time (legacy behavior) |

`"false"` is treated as an alias for `"never"` for ergonomic HTML usage:
```html
<script src="/widget.js" data-repo="owner/repo" data-welcome="false"></script>
```

### Parsing

In the config block (~line 196), add:

```typescript
welcome: (() => {
  const val = script?.dataset.welcome;
  if (val === 'false' || val === 'never') return 'never';
  if (val === 'always') return 'always';
  return 'once'; // default
})(),
```

## 2. Show-Once Persistence

### localStorage Key

```
bugdrop_welcomed_{repo}
```

Example: `bugdrop_welcomed_neonwatty/bugdrop`

### Helper Functions

```typescript
const BUGDROP_WELCOMED_PREFIX = 'bugdrop_welcomed_';

function hasSeenWelcome(repo: string): boolean {
  try {
    return localStorage.getItem(BUGDROP_WELCOMED_PREFIX + repo) !== null;
  } catch { return false; }
}

function markWelcomeSeen(repo: string): void {
  try {
    localStorage.setItem(BUGDROP_WELCOMED_PREFIX + repo, Date.now().toString());
  } catch { /* blocked storage */ }
}
```

Follows the same try-catch pattern as the existing `bugdrop_dismissed` logic.

### When to Persist

Call `markWelcomeSeen(config.repo)` when the user clicks "Get Started" on the welcome screen (inside `showWelcomeScreen`, on the continue button handler).

## 3. `openFeedbackFlow` Welcome Gate

Replace the current unconditional welcome (lines 502-507) with:

```typescript
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

`showWelcomeScreen` gains a `repo` parameter so it can call `markWelcomeSeen(repo)` on continue.

### `BugDrop.open()` Behavior

Programmatic opens via `BugDrop.open()` always skip the welcome screen, regardless of `data-welcome` value. The host app is controlling the experience directly.

Implementation: Pass an optional `skipWelcome` flag through `openFeedbackFlow`, set to `true` when called from `BugDrop.open()`.

```typescript
async function openFeedbackFlow(
  root: HTMLElement,
  config: WidgetConfig,
  opts?: { skipWelcome?: boolean }
)
```

The welcome gate checks `opts?.skipWelcome` first.

## 4. Screenshot Checkbox Default

In the feedback form (~line 778), add the `checked` attribute:

```html
<input type="checkbox" id="include-screenshot" checked ... />
```

The screenshot options screen already provides "Skip Screenshot", so defaulting to checked doesn't force users into screenshots.

## 5. Version Number in Modal Footer

### Build-Time Injection

Modify the esbuild invocation in `scripts/build-widget.js` to inject the version as a compile-time constant via `--define`:

```
--define:__BUGDROP_VERSION__='"${version}"'
```

Note: The build script uses `execSync` with a hardcoded command string (no user input). The security hook about `exec` vs `execFile` is noted but not applicable here since the version comes from `package.json`, not user input.

Add a TypeScript declaration in the widget source:

```typescript
declare const __BUGDROP_VERSION__: string;
```

### Display

Modify `createModal()` in `ui.ts` to include a footer after the body:

```html
<div class="bd-modal">
  <div class="bd-header">...</div>
  <div class="bd-body">...</div>
  <div class="bd-version">BugDrop v${typeof __BUGDROP_VERSION__ !== 'undefined' ? __BUGDROP_VERSION__ : 'dev'}</div>
</div>
```

Style the version line:

```css
.bd-version {
  text-align: center;
  padding: 4px 0;
  font-size: 0.7rem;
  color: var(--bd-text-secondary);
  opacity: 0.5;
}
```

This appears on every modal: welcome, form, screenshot options, annotation, and success.

For local dev (where `__BUGDROP_VERSION__` may not be defined), fall back to `'dev'`.

## 6. Testing

### Unit Tests

- **Welcome mode logic**: Test that `hasSeenWelcome`/`markWelcomeSeen` correctly read/write localStorage
- **Config parsing**: Test that `data-welcome` values (`"once"`, `"always"`, `"never"`, `"false"`, omitted) parse correctly
- **Skip logic**: Test the `skipWelcome` computation for all combinations of config + localStorage state + programmatic flag

### E2E Tests

- **Default (once)**: Open widget, verify welcome appears. Close. Open again, verify welcome is skipped and form appears directly.
- **`data-welcome="false"`**: Open widget, verify form appears immediately with no welcome.
- **`data-welcome="always"`**: Open widget twice, verify welcome appears both times.
- **`BugDrop.open()`**: Call API, verify welcome is skipped regardless of config.
- **Screenshot checkbox**: Verify it is checked by default on the feedback form.
- **Version footer**: Verify `BugDrop v` text appears in modal footer.

### Existing Tests

Update any existing tests that assert on the welcome screen flow or modal step count.

## 7. Documentation

Update the config table on the landing page and README with:

| Attribute | Values | Default | Description |
|-----------|--------|---------|-------------|
| `data-welcome` | `"once"`, `"always"`, `"false"` / `"never"` | `"once"` | Controls the welcome screen. `"once"` shows it on first use per repo. `"false"` disables it entirely. |

Include a clear example for disabling:
```html
<script src="/widget.js" data-repo="owner/repo" data-welcome="false"></script>
```
