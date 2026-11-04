# Runtime Theme Switching API

**Issue:** #104
**Date:** 2026-04-15

## Problem

When embedded in apps that expose their own light/dark/system toggle, the BugDrop
widget stays on whatever theme was resolved at init. `data-theme="auto"` reads the
OS preference exactly once inside `injectStyles` (`ui.ts:29`) and bakes a `bd-dark`
class onto the shadow-DOM root wrapper — there is no `matchMedia` listener, and
there is no runtime JavaScript API to change themes after the widget has loaded.

Concrete use case: Seatify has an in-app light/dark/system toggle. The widget
initializes correctly based on OS preference, but doesn't follow when the user
switches mode mid-session.

## Approach

Ship two coupled changes in one PR:

1. **New imperative API**: `window.BugDrop.setTheme('light' | 'dark' | 'auto')`. Host
   code (Seatify, etc.) calls this whenever its theme toggle changes, and the widget
   updates synchronously.
2. **Fix the latent `'auto'` bug**: attach a `matchMedia('(prefers-color-scheme: dark)')`
   listener at init, so that widgets in `'auto'` mode (whether set at init or via
   `setTheme('auto')`) track OS-level theme changes from then on.

Both changes flow through the same extracted helpers, so adding `setTheme` and
fixing the `auto` bug costs less as a pair than either would alone.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Return value | `void` | Consistent with existing `open`/`close`/`hide`/`show`. |
| Invalid input | `console.warn` + no-op | Matches house style (`[BugDrop] Missing data-repo attribute`). Non-breaking for the host app, debuggable for the widget integrator. |
| Event emission | None | YAGNI — Seatify is the caller, so it already knows. Cheap to add later if a real consumer appears. |
| `setTheme('auto')` semantics | Reactive (tracks OS changes from then on) | Matches the user mental model of "system" in modern theme pickers. |
| `matchMedia` listener lifecycle | Always-on, gated by a mode check | One persistent listener is simpler than attach/detach per mode change. Cost is one string compare per OS theme change. |
| `bgColor` edge case | Re-derive `color-mix` inline styles on every theme change | Users combining `data-bg` with runtime theme switching would otherwise see wrong secondary/tertiary backgrounds. Extracting `applyCustomStyles` makes this Just Work. |

## Architecture

New module: **`src/widget/theme.ts`** (~120 lines, single-purpose).

### Exports

```ts
export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

// Pure. Unit-testable. Takes the system probe as a parameter so tests inject a fake.
export function resolveTheme(
  mode: ThemeMode,
  getSystem?: () => ResolvedTheme,
): ResolvedTheme;

// Pure predicate. Narrows the type for setTheme input validation.
export function isValidTheme(value: unknown): value is ThemeMode;

// Reads window.matchMedia once. Falls back to 'light' in non-browser environments.
export function getSystemTheme(): ResolvedTheme;

// Toggles `.bd-dark` on the given root element.
export function applyThemeClass(root: HTMLElement, resolved: ResolvedTheme): void;

// Extracted from injectStyles: applies all custom-color inline styles that
// depend on the resolved theme. Called at init AND on every runtime theme change.
export function applyCustomStyles(
  root: HTMLElement,
  config: WidgetConfig,
  resolved: ResolvedTheme,
): void;

// Registers a matchMedia('(prefers-color-scheme: dark)') listener.
// Returns a cleanup function. Safe to call without matchMedia (no-ops gracefully).
export function attachSystemThemeListener(
  onSystemChange: (resolved: ResolvedTheme) => void,
): () => void;
```

### Consumers

**`src/widget/ui.ts`**

- Imports `resolveTheme` and `applyCustomStyles` from `theme.ts`.
- `injectStyles` delegates the inline-style block (currently spanning roughly
  `ui.ts:984-1040`, covering `accentColor`, `bgColor`, `textColor`, and border/shadow
  branches) to `applyCustomStyles` instead of inlining the logic. Net extraction is
  ~50 lines of logic plus whatever fold-in happens in `applyCustomStyles` itself.
- `getSystemTheme` moves out of `ui.ts` entirely; callers import from `theme.ts`.

**`src/widget/index.ts`**

- Imports `resolveTheme`, `applyThemeClass`, `applyCustomStyles`,
  `attachSystemThemeListener`, `isValidTheme`, and the two types from `theme.ts`.
- Adds a module-level `_currentMode: ThemeMode`, initialized from `config.theme`.
  Same pattern as existing `_triggerButton`, `_isModalOpen`, `_pullTab`.
- Adds a module-level `_detachSystemListener: (() => void) | null`. Assigned to
  the cleanup function returned by `attachSystemThemeListener` at init. Not called
  from this PR — exists so a future teardown path (e.g. a hypothetical
  `BugDrop.destroy()`) has a handle, and so that the ownership story is explicit
  rather than "the listener leaks."
- Inside `exposeBugDropAPI` (the existing function `initWidget` already calls after
  the shadow root and `.bd-root` wrapper exist), calls `attachSystemThemeListener`
  exactly once with a callback that checks `_currentMode` against `'auto'` and, if
  matching, applies the new resolved theme via `applyThemeClass` + `applyCustomStyles`.
  For explicit `'light'` / `'dark'` modes the callback no-ops.
- Extends the `BugDropAPI` interface and `exposeBugDropAPI` with `setTheme`.

## Data Flow

### Path A — Widget init

```
1. index.ts reads config.theme from script[data-theme] (default 'auto')
2. _currentMode = config.theme
3. initWidget creates the shadow host
4. injectStyles(shadow, config):
   - resolved = resolveTheme(config.theme)
   - creates <div class="bd-root"> and calls applyThemeClass(root, resolved)
   - calls applyCustomStyles(root, config, resolved)
5. exposeBugDropAPI(root, config):
   - adds setTheme to window.BugDrop
   - calls attachSystemThemeListener(onSystemChange)
   - stores the returned cleanup on _detachSystemListener
6. window.dispatchEvent('bugdrop:ready')
```

The matchMedia listener is attached exactly once per widget init, regardless of
`config.theme`. If the mode is `'light'` or `'dark'`, the listener still fires on
OS changes but the callback no-ops (Path C).

### Path B — Host calls `window.BugDrop.setTheme(mode)`

```
1. setTheme(mode):
   - if (!isValidTheme(mode)): console.warn + return
   - _currentMode = mode
   - resolved = resolveTheme(mode)
   - applyThemeClass(root, resolved)
   - applyCustomStyles(root, config, resolved)
```

Synchronous. Returns `void`. No event dispatched.

### Path C — OS theme changes while widget is running

```
1. Browser fires the MediaQueryList 'change' event
2. The handler installed by attachSystemThemeListener runs:
   - if (_currentMode !== 'auto') return   ← no-op for explicit modes
   - resolved = (event.matches ? 'dark' : 'light')
   - applyThemeClass(root, resolved)
   - applyCustomStyles(root, config, resolved)
```

## Error Handling & Edge Cases

### Invalid input to `setTheme`

```ts
if (!isValidTheme(mode)) {
  console.warn(
    `[BugDrop] Invalid theme ${JSON.stringify(mode)}. Expected 'light' | 'dark' | 'auto'.`
  );
  return;
}
```

`JSON.stringify` handles `undefined`, `null`, objects, numbers, and booleans
without blowing up, and preserves type visibility (`"5"` vs `5`) for debuggability.

### `window.matchMedia` unavailable

`attachSystemThemeListener` short-circuits and returns a no-op cleanup. Matches
the existing `getSystemTheme` guard at `ui.ts:20`. Test harnesses and old
browsers degrade gracefully — `setTheme` still works, only the `'auto'` auto-follow
path is silently skipped.

### Legacy `MediaQueryList.addListener` API

Safari < 14 and some older mobile browsers only expose the deprecated
`.addListener` / `.removeListener` methods on `MediaQueryList`. **Decision: do not
support.** The widget's E2E suite runs Chromium only, `html-to-image` already
requires modern browsers, and `setTheme` itself does not depend on matchMedia. A
user on an old browser loses the OS-change auto-follow behavior but retains
imperative `setTheme` — a reasonable graceful degradation.

### `setTheme` called before widget init

`window.BugDrop` doesn't exist until `exposeBugDropAPI` runs, so the call throws
`TypeError: undefined is not an object`. Same behavior as calling
`window.BugDrop.open()` pre-init today. Host code needing a race-safe entry point
should listen for the existing `bugdrop:ready` event.

### Same-mode no-op

`setTheme('light')` when already `'light'` runs the full path. `classList.toggle`
is idempotent, and `applyCustomStyles` re-sets inline properties to the same
values. Cheaper than adding a compare-and-skip guard.

### `setTheme` during screenshot capture

`html-to-image` walks the DOM synchronously (~200ms). Racing `setTheme` against
capture could yield mixed styling in the output. **Decision: not worth handling.**
Realistically the host won't race its own calls. If this ever becomes a real
complaint, queue `setTheme` during `_captureInFlight` as a future fix.

### `bgColor` + `'auto'` + OS change (the compound edge case)

User sets `data-bg="#custom"` and `data-theme="auto"`. OS flips dark → light. The
matchMedia callback calls `applyCustomStyles`, which re-runs the `color-mix`
derivation for `--bd-bg-secondary` and `--bd-bg-tertiary` against the new `isDark`
value. **This works correctly** because the style application is consolidated into
one function. This is the whole point of Approach B's `applyCustomStyles` extraction.

## Testing

### Unit: `test/theme.test.ts` (new, vitest)

Covers the pure helpers in `theme.ts`. Uses jsdom `document.createElement('div')`
for class/inline-style assertions; mocks `window.matchMedia` for listener tests.

- `resolveTheme` — `'light'`/`'dark'` passthrough; `'auto'` via explicitly-injected
  probe (both branches); `'auto'` via the default-parameter fallback path (exercises
  the real `getSystemTheme` with a mocked `window.matchMedia`)
- `isValidTheme` — accept `'light'|'dark'|'auto'`; reject empty string, other
  strings, `undefined`, `null`, numbers, objects, booleans
- `applyThemeClass` — adds/removes `bd-dark`, idempotent
- `applyCustomStyles` — no-op when no custom colors; correct `color-mix` branch
  for `isDark=true` (white) vs `isDark=false` (black); overwrite behavior when
  called twice; accent/text colors unaffected by theme
- `attachSystemThemeListener` — no-op cleanup when `matchMedia` missing; callback
  fires with correct resolved theme on change; stops firing after cleanup

### E2E: `e2e/theme.spec.ts` (new, Playwright, joins existing sharded runs)

Covers the full pipeline in a real browser through the real shadow DOM.

- `setTheme('dark')` flips the root class
- `setTheme('light')` removes `bd-dark`
- `setTheme('auto')` resolves to the current system preference via
  `page.emulateMedia({ colorScheme })`
- Invalid input triggers `console.warn` and does not change the class
- **Auto mode follows OS theme changes after init** — init with
  `data-theme="auto"` and system=light, assert no `bd-dark`, call
  `page.emulateMedia({ colorScheme: 'dark' })`, assert `bd-dark` is added. This
  validates the matchMedia listener end-to-end.
- **`bgColor` + `setTheme` re-derives secondary/tertiary bgs** — init with
  `data-bg="#custom"` and `data-theme="light"`, read `--bd-bg-secondary` inline
  style, call `setTheme('dark')`, read it again, assert it differs.

### Not tested

- **Visual regression**: maintenance cost exceeds value here; unit tests pin the
  style derivation.
- **Cross-browser matchMedia compat**: Chromium-only per existing E2E config,
  and we declined to ship the `.addListener` fallback.
- **Event emission**: no events to test.

### Test file sizes

- `test/theme.test.ts` — ~150 lines
- `e2e/theme.spec.ts` — ~120 lines
- No new dependencies.

## File Size Impact (CLAUDE.md soft limit: 300 lines)

| File | Before | After | Delta |
|---|---|---|---|
| `src/widget/theme.ts` | — | ~120 | new ✅ |
| `src/widget/ui.ts` | 1143 | ~1090 | −50 (still over, slightly better) |
| `src/widget/index.ts` | 1257 | ~1300 | +40 (still over, not this PR's problem) |

## Release & Validation

This PR is a `feat:` (minor version bump via semantic-release). Beyond shipping
the feature, it serves as the first validation of the new `deploy.yml` with-release
path from PR #111 — the post-merge deploy should fire, `release` should publish a
new minor tag, and `deploy` should rebuild with the new VERSION and ship to
Cloudflare Workers.

## Out of Scope

- `getTheme()` getter — deferred until a real consumer needs to query state
- `bugdrop:themechange` event emission — deferred per YAGNI
- `.addListener` legacy matchMedia fallback — graceful degradation is sufficient
- Screenshot-capture racing protection — not a real complaint yet
- Multi-widget-instance support — widget is single-instance by design
- Moving other module-level widget state into proper state containers — existing
  pattern, not this PR's problem
