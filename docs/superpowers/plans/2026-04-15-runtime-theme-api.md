# Runtime Theme Switching API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `window.BugDrop.setTheme('light' | 'dark' | 'auto')` to the widget and fix the latent bug where `data-theme="auto"` never follows OS theme changes after init. Both changes go through the same extracted `theme.ts` helpers.

**Architecture:** New `src/widget/theme.ts` module holds all theme logic (pure helpers + matchMedia listener wiring). `ui.ts` delegates its custom-color inline-style block to the new module. `index.ts` wires the API method and the listener. Test-first with vitest for pure helpers + Playwright for the full pipeline.

**Tech Stack:** TypeScript (strict mode), Vitest (unit), Playwright (E2E), esbuild (widget bundle), semantic-release (versioning).

**Spec:** `docs/superpowers/specs/2026-04-15-runtime-theme-api-design.md` (authoritative — consult for "why" decisions).

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `src/widget/theme.ts` | **Create** | All theme resolution, class application, custom-style derivation, and matchMedia listener wiring. Pure module (no top-level side effects). |
| `src/widget/ui.ts` | **Modify** | `injectStyles` delegates to `theme.ts`. Local `getSystemTheme` removed. Inline-style block at `ui.ts:979-1057` collapses to a few calls. |
| `src/widget/index.ts` | **Modify** | Adds `_currentMode` and `_detachSystemListener` module state. `exposeBugDropAPI` installs matchMedia listener once and adds `setTheme` method. `BugDropAPI` interface extended. |
| `test/theme.test.ts` | **Create** | Vitest unit tests for all six `theme.ts` exports. Mocks `window.matchMedia`. |
| `e2e/theme.spec.ts` | **Create** | Playwright E2E: 6 cases covering setTheme happy path, invalid input, auto + emulateMedia, bgColor re-derivation. |

---

## Task 1: Verify branch state and scaffold empty module

**Files:**
- Create: `src/widget/theme.ts`
- Create: `test/theme.test.ts`

- [ ] **Step 1: Verify git state**

```bash
git status
git branch --show-current
git log --oneline -3
```

Expected: branch is `feat/runtime-theme-api`, HEAD is `b090fdb` (spec commit) with `fc8749e` as its parent. Working tree clean.

- [ ] **Step 2: Create `src/widget/theme.ts` with type exports and stubs**

```typescript
// src/widget/theme.ts

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

// Forward-declared so this module doesn't import from ui.ts (avoids cycle).
// The actual WidgetConfig type is defined in index.ts and ui.ts; for the
// custom-styles helper we only need the subset of fields we consume.
export interface ThemeConfigSlice {
  accentColor?: string;
  bgColor?: string;
  textColor?: string;
  borderWidth?: string;
  borderColor?: string;
  shadow?: string;
}

export function getSystemTheme(): ResolvedTheme {
  throw new Error('not implemented');
}

export function resolveTheme(
  mode: ThemeMode,
  getSystem: () => ResolvedTheme = getSystemTheme,
): ResolvedTheme {
  throw new Error('not implemented');
}

export function isValidTheme(value: unknown): value is ThemeMode {
  throw new Error('not implemented');
}

export function applyThemeClass(root: HTMLElement, resolved: ResolvedTheme): void {
  throw new Error('not implemented');
}

export function applyCustomStyles(
  root: HTMLElement,
  config: ThemeConfigSlice,
  resolved: ResolvedTheme,
): void {
  throw new Error('not implemented');
}

export function attachSystemThemeListener(
  onSystemChange: (resolved: ResolvedTheme) => void,
): () => void {
  throw new Error('not implemented');
}
```

- [ ] **Step 3: Create `test/theme.test.ts` shell**

```typescript
// test/theme.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveTheme,
  isValidTheme,
  getSystemTheme,
  applyThemeClass,
  applyCustomStyles,
  attachSystemThemeListener,
  type ThemeMode,
  type ResolvedTheme,
} from '../src/widget/theme';

describe('theme module', () => {
  it('module loads', () => {
    expect(typeof resolveTheme).toBe('function');
  });
});
```

- [ ] **Step 4: Run typecheck and the stub test**

Run: `npm run typecheck && npx vitest run test/theme.test.ts`
Expected: typecheck passes, 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): scaffold theme module and test file (#104)"
```

---

## Task 2: TDD `isValidTheme`

**Files:**
- Modify: `src/widget/theme.ts` (implement `isValidTheme`)
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('isValidTheme', () => {
  it.each(['light', 'dark', 'auto'])('accepts %s', (value) => {
    expect(isValidTheme(value)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['unknown string', 'blue'],
    ['undefined', undefined],
    ['null', null],
    ['number', 5],
    ['boolean', true],
    ['object', {}],
    ['array', []],
  ])('rejects %s', (_label, value) => {
    expect(isValidTheme(value)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run test/theme.test.ts`
Expected: 11 `isValidTheme` tests all fail with "not implemented".

- [ ] **Step 3: Implement `isValidTheme`**

In `src/widget/theme.ts`, replace the stub body:

```typescript
export function isValidTheme(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/theme.test.ts`
Expected: 12 tests pass (1 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): add isValidTheme predicate (#104)"
```

---

## Task 3: TDD `getSystemTheme` (and retire the copy in `ui.ts`)

**Files:**
- Modify: `src/widget/theme.ts` (implement `getSystemTheme`)
- Modify: `src/widget/ui.ts` (remove the duplicate, add import)
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('getSystemTheme', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function mockMatchMedia(matches: boolean) {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia;
  }

  it('returns "dark" when prefers-color-scheme matches', () => {
    mockMatchMedia(true);
    expect(getSystemTheme()).toBe('dark');
  });

  it('returns "light" when prefers-color-scheme does not match', () => {
    mockMatchMedia(false);
    expect(getSystemTheme()).toBe('light');
  });

  it('returns "light" when matchMedia is unavailable', () => {
    // @ts-expect-error - deliberately removing
    delete window.matchMedia;
    expect(getSystemTheme()).toBe('light');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run test/theme.test.ts`
Expected: 3 new failures with "not implemented".

- [ ] **Step 3: Implement `getSystemTheme` in `theme.ts`**

Replace the stub:

```typescript
export function getSystemTheme(): ResolvedTheme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}
```

This is copied verbatim from `ui.ts:19-24` (the version we're retiring in the next step).

- [ ] **Step 4: Remove `getSystemTheme` from `ui.ts` and import from `theme.ts`**

In `src/widget/ui.ts`, delete lines 18-24 (the `// Detect system dark mode preference` comment and `getSystemTheme` function). Add this import at the top, after the last existing import:

```typescript
import { getSystemTheme } from './theme';
```

(For now we only need `getSystemTheme` — more imports will be added in Task 8.)

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: typecheck passes, all vitest tests pass (including existing ones that transitively use `injectStyles`), lint passes.

- [ ] **Step 6: Commit**

```bash
git add src/widget/theme.ts src/widget/ui.ts test/theme.test.ts
git commit -m "feat(theme): move getSystemTheme into theme module (#104)"
```

---

## Task 4: TDD `resolveTheme`

**Files:**
- Modify: `src/widget/theme.ts`
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('resolveTheme', () => {
  it('returns "light" for mode "light"', () => {
    expect(resolveTheme('light')).toBe('light');
  });

  it('returns "dark" for mode "dark"', () => {
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('resolves "auto" via the injected probe (dark)', () => {
    expect(resolveTheme('auto', () => 'dark')).toBe('dark');
  });

  it('resolves "auto" via the injected probe (light)', () => {
    expect(resolveTheme('auto', () => 'light')).toBe('light');
  });

  it('resolves "auto" via the default getSystemTheme fallback when no probe is given', () => {
    // Rely on the real getSystemTheme path with a mocked matchMedia.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }) as unknown as typeof window.matchMedia;
    try {
      expect(resolveTheme('auto')).toBe('dark');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('passes "light" for explicit modes through even when getSystem would say dark', () => {
    expect(resolveTheme('light', () => 'dark')).toBe('light');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run test/theme.test.ts`
Expected: 6 new `resolveTheme` failures.

- [ ] **Step 3: Implement `resolveTheme`**

Replace the stub:

```typescript
export function resolveTheme(
  mode: ThemeMode,
  getSystem: () => ResolvedTheme = getSystemTheme,
): ResolvedTheme {
  if (mode === 'auto') return getSystem();
  return mode;
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/theme.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): add resolveTheme helper (#104)"
```

---

## Task 5: TDD `applyThemeClass`

**Files:**
- Modify: `src/widget/theme.ts`
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('applyThemeClass', () => {
  it('adds bd-dark when resolved is dark', () => {
    const root = document.createElement('div');
    root.className = 'bd-root';
    applyThemeClass(root, 'dark');
    expect(root.classList.contains('bd-dark')).toBe(true);
    expect(root.classList.contains('bd-root')).toBe(true);
  });

  it('removes bd-dark when resolved is light', () => {
    const root = document.createElement('div');
    root.className = 'bd-root bd-dark';
    applyThemeClass(root, 'light');
    expect(root.classList.contains('bd-dark')).toBe(false);
    expect(root.classList.contains('bd-root')).toBe(true);
  });

  it('is idempotent (dark twice)', () => {
    const root = document.createElement('div');
    root.className = 'bd-root';
    applyThemeClass(root, 'dark');
    applyThemeClass(root, 'dark');
    expect(root.classList.contains('bd-dark')).toBe(true);
  });

  it('is idempotent (light twice)', () => {
    const root = document.createElement('div');
    root.className = 'bd-root';
    applyThemeClass(root, 'light');
    applyThemeClass(root, 'light');
    expect(root.classList.contains('bd-dark')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run test/theme.test.ts`
Expected: 4 new failures.

- [ ] **Step 3: Implement `applyThemeClass`**

Replace the stub:

```typescript
export function applyThemeClass(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle('bd-dark', resolved === 'dark');
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/theme.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): add applyThemeClass helper (#104)"
```

---

## Task 6: TDD `applyCustomStyles` (the big extraction)

This is the most delicate task. The goal is to move the theme-dependent inline-style logic out of `injectStyles` verbatim, then verify it produces the *exact same* inline styles as before. We do not change behavior in this task.

**Files:**
- Modify: `src/widget/theme.ts`
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('applyCustomStyles', () => {
  function makeRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'bd-root';
    return root;
  }

  it('no-ops when config is empty', () => {
    const root = makeRoot();
    applyCustomStyles(root, {}, 'light');
    expect(root.getAttribute('style')).toBeFalsy();
  });

  describe('accentColor', () => {
    it('sets --bd-primary, --bd-primary-hover, --bd-border-focus', () => {
      const root = makeRoot();
      applyCustomStyles(root, { accentColor: '#ff6b35' }, 'light');
      expect(root.style.getPropertyValue('--bd-primary')).toBe('#ff6b35');
      expect(root.style.getPropertyValue('--bd-primary-hover')).toBe(
        'color-mix(in srgb, #ff6b35 85%, black)'
      );
      expect(root.style.getPropertyValue('--bd-border-focus')).toBe('#ff6b35');
    });

    it('is independent of theme', () => {
      const rootLight = makeRoot();
      const rootDark = makeRoot();
      applyCustomStyles(rootLight, { accentColor: '#ff6b35' }, 'light');
      applyCustomStyles(rootDark, { accentColor: '#ff6b35' }, 'dark');
      expect(rootLight.style.getPropertyValue('--bd-primary-hover')).toBe(
        rootDark.style.getPropertyValue('--bd-primary-hover')
      );
    });
  });

  describe('bgColor', () => {
    it('light mode derives secondary/tertiary by mixing with black', () => {
      const root = makeRoot();
      applyCustomStyles(root, { bgColor: '#fffef0' }, 'light');
      expect(root.style.getPropertyValue('--bd-bg-primary')).toBe('#fffef0');
      expect(root.style.getPropertyValue('--bd-bg-secondary')).toBe(
        'color-mix(in srgb, #fffef0 93%, black)'
      );
      expect(root.style.getPropertyValue('--bd-bg-tertiary')).toBe(
        'color-mix(in srgb, #fffef0 85%, black)'
      );
    });

    it('dark mode derives secondary/tertiary by mixing with white', () => {
      const root = makeRoot();
      applyCustomStyles(root, { bgColor: '#0a0a0a' }, 'dark');
      expect(root.style.getPropertyValue('--bd-bg-primary')).toBe('#0a0a0a');
      expect(root.style.getPropertyValue('--bd-bg-secondary')).toBe(
        'color-mix(in srgb, #0a0a0a 85%, white)'
      );
      expect(root.style.getPropertyValue('--bd-bg-tertiary')).toBe(
        'color-mix(in srgb, #0a0a0a 70%, white)'
      );
    });

    it('re-running with different theme overwrites secondary/tertiary', () => {
      const root = makeRoot();
      applyCustomStyles(root, { bgColor: '#fffef0' }, 'light');
      const lightSecondary = root.style.getPropertyValue('--bd-bg-secondary');
      applyCustomStyles(root, { bgColor: '#fffef0' }, 'dark');
      const darkSecondary = root.style.getPropertyValue('--bd-bg-secondary');
      expect(lightSecondary).not.toBe(darkSecondary);
      expect(darkSecondary).toContain('white');
    });
  });

  describe('textColor', () => {
    it('uses bgColor when provided for the bgBase fallback', () => {
      const root = makeRoot();
      applyCustomStyles(
        root,
        { textColor: '#1a1a1a', bgColor: '#fffef0' },
        'light',
      );
      expect(root.style.getPropertyValue('--bd-text-secondary')).toBe(
        'color-mix(in srgb, #1a1a1a 65%, #fffef0)'
      );
    });

    it('falls back to theme default in light mode when no bgColor', () => {
      const root = makeRoot();
      applyCustomStyles(root, { textColor: '#1a1a1a' }, 'light');
      expect(root.style.getPropertyValue('--bd-text-secondary')).toBe(
        'color-mix(in srgb, #1a1a1a 65%, #fafaf9)'
      );
    });

    it('falls back to theme default in dark mode when no bgColor', () => {
      const root = makeRoot();
      applyCustomStyles(root, { textColor: '#f1f5f9' }, 'dark');
      expect(root.style.getPropertyValue('--bd-text-secondary')).toBe(
        'color-mix(in srgb, #f1f5f9 65%, #0f172a)'
      );
    });
  });

  describe('border', () => {
    it('sets --bd-border and --bd-border-style when borderWidth is provided', () => {
      const root = makeRoot();
      applyCustomStyles(root, { borderWidth: '4' }, 'light');
      expect(root.style.getPropertyValue('--bd-border-style')).toBe(
        '4px solid var(--bd-border)'
      );
    });

    it('uses explicit borderColor when provided', () => {
      const root = makeRoot();
      applyCustomStyles(root, { borderWidth: '2', borderColor: '#000' }, 'light');
      expect(root.style.getPropertyValue('--bd-border')).toBe('#000');
      expect(root.style.getPropertyValue('--bd-border-style')).toBe('2px solid #000');
    });
  });

  describe('shadow', () => {
    it('shadow: none sets all shadow vars to none', () => {
      const root = makeRoot();
      applyCustomStyles(root, { shadow: 'none' }, 'light');
      expect(root.style.getPropertyValue('--bd-shadow-sm')).toBe('none');
      expect(root.style.getPropertyValue('--bd-shadow-md')).toBe('none');
      expect(root.style.getPropertyValue('--bd-shadow-lg')).toBe('none');
      expect(root.style.getPropertyValue('--bd-shadow-glow')).toBe('none');
    });

    it('shadow: hard in light mode uses #1a1a1a fallback for shadowColor', () => {
      const root = makeRoot();
      applyCustomStyles(root, { shadow: 'hard' }, 'light');
      expect(root.style.getPropertyValue('--bd-shadow-sm')).toContain('#1a1a1a');
    });

    it('shadow: hard in dark mode uses #000 fallback for shadowColor', () => {
      const root = makeRoot();
      applyCustomStyles(root, { shadow: 'hard' }, 'dark');
      expect(root.style.getPropertyValue('--bd-shadow-sm')).toContain('#000');
    });
  });
});
```

- [ ] **Step 2: Run, confirm all failures**

Run: `npx vitest run test/theme.test.ts`
Expected: ~16 new failures.

- [ ] **Step 3: Implement `applyCustomStyles`**

This function is a direct extraction of the inline-style block at `ui.ts:983-1053`. Replace the stub in `src/widget/theme.ts`:

```typescript
export function applyCustomStyles(
  root: HTMLElement,
  config: ThemeConfigSlice,
  resolved: ResolvedTheme,
): void {
  const isDark = resolved === 'dark';

  // Apply custom accent color if provided
  if (config.accentColor) {
    const color = config.accentColor;
    root.style.setProperty('--bd-primary', color);
    root.style.setProperty('--bd-primary-hover', `color-mix(in srgb, ${color} 85%, black)`);
    root.style.setProperty('--bd-border-focus', color);
  }

  // Apply custom background color if provided
  if (config.bgColor) {
    root.style.setProperty('--bd-bg-primary', config.bgColor);
    if (isDark) {
      root.style.setProperty(
        '--bd-bg-secondary',
        `color-mix(in srgb, ${config.bgColor} 85%, white)`
      );
      root.style.setProperty(
        '--bd-bg-tertiary',
        `color-mix(in srgb, ${config.bgColor} 70%, white)`
      );
    } else {
      root.style.setProperty(
        '--bd-bg-secondary',
        `color-mix(in srgb, ${config.bgColor} 93%, black)`
      );
      root.style.setProperty(
        '--bd-bg-tertiary',
        `color-mix(in srgb, ${config.bgColor} 85%, black)`
      );
    }
  }

  // Apply custom text color if provided
  if (config.textColor) {
    root.style.setProperty('--bd-text-primary', config.textColor);
    const bgBase = config.bgColor || (isDark ? '#0f172a' : '#fafaf9');
    root.style.setProperty(
      '--bd-text-secondary',
      `color-mix(in srgb, ${config.textColor} 65%, ${bgBase})`
    );
    root.style.setProperty(
      '--bd-text-muted',
      `color-mix(in srgb, ${config.textColor} 40%, ${bgBase})`
    );
  }

  // Apply custom border styling if provided
  const borderW = config.borderWidth ? parseInt(config.borderWidth, 10) : null;
  const borderC = config.borderColor || null;
  if (borderW !== null || borderC !== null) {
    const bw = borderW !== null ? `${borderW}px` : '1px';
    const bc = borderC || 'var(--bd-border)';
    root.style.setProperty('--bd-border', bc);
    root.style.setProperty('--bd-border-style', `${bw} solid ${bc}`);
  }

  // Apply shadow preset if provided
  const shadowPreset = config.shadow || null;
  if (shadowPreset === 'none') {
    root.style.setProperty('--bd-shadow-sm', 'none');
    root.style.setProperty('--bd-shadow-md', 'none');
    root.style.setProperty('--bd-shadow-lg', 'none');
    root.style.setProperty('--bd-shadow-glow', 'none');
  } else if (shadowPreset === 'hard') {
    const shadowColor = borderC || (isDark ? '#000' : '#1a1a1a');
    const offset = borderW !== null ? `${borderW + 2}px` : '6px';
    root.style.setProperty('--bd-shadow-sm', `${shadowColor} 2px 2px 0 0`);
    root.style.setProperty('--bd-shadow-md', `${shadowColor} ${offset} ${offset} 0 0`);
    root.style.setProperty('--bd-shadow-lg', `${shadowColor} ${offset} ${offset} 0 0`);
    root.style.setProperty('--bd-shadow-glow', 'none');
  }
}
```

- [ ] **Step 4: Run, confirm all pass**

Run: `npx vitest run test/theme.test.ts && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): add applyCustomStyles helper (#104)"
```

---

## Task 7: TDD `attachSystemThemeListener`

**Files:**
- Modify: `src/widget/theme.ts`
- Modify: `test/theme.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/theme.test.ts`:

```typescript
describe('attachSystemThemeListener', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function mockMatchMedia() {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const mql = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn((_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.add(cb);
      }),
      removeEventListener: vi.fn((_type: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.delete(cb);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    };
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
    return {
      fire(matches: boolean) {
        listeners.forEach((cb) =>
          cb({ matches, media: '(prefers-color-scheme: dark)' } as MediaQueryListEvent)
        );
      },
      mql,
      listeners,
    };
  }

  it('returns a no-op cleanup when matchMedia is missing', () => {
    // @ts-expect-error deliberately remove
    delete window.matchMedia;
    const cleanup = attachSystemThemeListener(() => {});
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('invokes callback with "dark" when the media query starts matching', () => {
    const harness = mockMatchMedia();
    const cb = vi.fn();
    attachSystemThemeListener(cb);
    harness.fire(true);
    expect(cb).toHaveBeenCalledWith('dark');
  });

  it('invokes callback with "light" when the media query stops matching', () => {
    const harness = mockMatchMedia();
    const cb = vi.fn();
    attachSystemThemeListener(cb);
    harness.fire(false);
    expect(cb).toHaveBeenCalledWith('light');
  });

  it('stops invoking the callback after cleanup()', () => {
    const harness = mockMatchMedia();
    const cb = vi.fn();
    const cleanup = attachSystemThemeListener(cb);
    cleanup();
    harness.fire(true);
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run test/theme.test.ts`
Expected: 4 new failures.

- [ ] **Step 3: Implement `attachSystemThemeListener`**

Replace the stub:

```typescript
export function attachSystemThemeListener(
  onSystemChange: (resolved: ResolvedTheme) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {
      /* no-op cleanup */
    };
  }
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    onSystemChange(e.matches ? 'dark' : 'light');
  };
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: all tests pass, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/widget/theme.ts test/theme.test.ts
git commit -m "feat(theme): add attachSystemThemeListener wiring (#104)"
```

---

## Task 8: Refactor `injectStyles` to delegate to `theme.ts`

This is a behavior-preserving refactor. The goal is that existing tests and the built widget behave identically, with `injectStyles` collapsed into a few calls.

**Files:**
- Modify: `src/widget/ui.ts`

- [ ] **Step 1: Add imports**

In `src/widget/ui.ts`, update the `theme.ts` import added in Task 3:

```typescript
import { resolveTheme, applyThemeClass, applyCustomStyles } from './theme';
```

(The bare `import { getSystemTheme } from './theme';` from Task 3 can be removed if `ui.ts` no longer calls `getSystemTheme` directly — `resolveTheme` owns that call now.)

- [ ] **Step 2: Collapse the theme resolution**

Replace `ui.ts:28-30` (the lines that currently read):

```typescript
  // Resolve 'auto' to actual theme based on system preference
  const resolvedTheme = config.theme === 'auto' ? getSystemTheme() : config.theme;
  const isDark = resolvedTheme === 'dark';
```

with:

```typescript
  const resolved = resolveTheme(config.theme);
  const isDark = resolved === 'dark';
```

(`isDark` is still useful inside `injectStyles` for the style *string* injection — the `<style>` block at `ui.ts:58-977` reads `isDark` to build CSS text. We're only migrating the inline-style block below.)

- [ ] **Step 3: Replace the root-wrapper creation and inline-style block**

Replace `ui.ts:979-1053` (from the `// Create root wrapper with theme class` comment through the end of the `shadow preset` block, **but not** the `shadow.appendChild(root)` on line 1055 or the `return root` on line 1057) with:

```typescript
  // Create root wrapper and apply theme class + custom styles
  const root = document.createElement('div');
  root.className = 'bd-root';
  applyThemeClass(root, resolved);
  applyCustomStyles(root, config, resolved);
```

The surrounding code (`shadow.appendChild(root)` and `return root`) stays.

- [ ] **Step 4: Run full test suite**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all vitest tests pass (including existing tests for `welcomeConfig`, `widgetApiUrl`, etc.), typecheck clean, lint clean.

- [ ] **Step 5: Build widget and spot-check**

Run: `npm run build:widget`
Expected: build succeeds. No runtime errors printed.

- [ ] **Step 6: Commit**

```bash
git add src/widget/ui.ts
git commit -m "refactor(widget): delegate theme resolution and custom styles to theme module (#104)"
```

Note: this is a `refactor:` not a `feat:` — no user-visible change, so no release triggered by this commit alone. The `feat:` commit comes later.

---

## Task 9: Extend `BugDropAPI` interface and add module-level state

**Files:**
- Modify: `src/widget/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/widget/index.ts`, after the existing imports, add:

```typescript
import {
  resolveTheme,
  applyThemeClass,
  applyCustomStyles,
  attachSystemThemeListener,
  isValidTheme,
  type ThemeMode,
} from './theme';
```

- [ ] **Step 2: Extend `BugDropAPI` interface**

At `src/widget/index.ts:52-59`, replace:

```typescript
interface BugDropAPI {
  open: () => void;
  close: () => void;
  hide: () => void;
  show: () => void;
  isOpen: () => boolean;
  isButtonVisible: () => boolean;
}
```

with:

```typescript
interface BugDropAPI {
  open: () => void;
  close: () => void;
  hide: () => void;
  show: () => void;
  isOpen: () => boolean;
  isButtonVisible: () => boolean;
  setTheme: (mode: ThemeMode) => void;
}
```

- [ ] **Step 3: Add module-level state near existing widget state**

Find the existing module-level state declarations (`_triggerButton`, `_isModalOpen`, `_pullTab`) and add alongside them:

```typescript
let _currentMode: ThemeMode = 'auto';
let _detachSystemListener: (() => void) | null = null;
```

- [ ] **Step 4: Initialize `_currentMode` at widget init**

In the top-level config assembly (around `src/widget/index.ts:224-269`), after `config` is fully built, set:

```typescript
_currentMode = config.theme;
```

This must happen before `initWidget(config)` is called.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: error at `exposeBugDropAPI` because `setTheme` is now required on `BugDropAPI` but not implemented. This is fine — fix in the next task.

- [ ] **Step 6: Do NOT commit yet** (the tree is broken — typecheck fails). Move directly to Task 10.

---

## Task 10: Implement `setTheme` in `exposeBugDropAPI`

**Files:**
- Modify: `src/widget/index.ts`

- [ ] **Step 1: Add `setTheme` to the returned API object**

Inside `exposeBugDropAPI` (around `src/widget/index.ts:443-500`), in the object passed to `window.BugDrop = { ... }`, add this method alongside `isButtonVisible`:

```typescript
    // Set the widget theme at runtime.
    // Accepts 'light' | 'dark' | 'auto'. Invalid input warns and no-ops.
    setTheme: (mode: unknown) => {
      if (!isValidTheme(mode)) {
        console.warn(
          `[BugDrop] Invalid theme ${JSON.stringify(mode)}. Expected 'light' | 'dark' | 'auto'.`
        );
        return;
      }
      _currentMode = mode;
      const resolved = resolveTheme(mode);
      applyThemeClass(root, resolved);
      applyCustomStyles(root, config, resolved);
    },
```

(Note: `mode: unknown` in the impl, but the public `BugDropAPI` interface declares it as `ThemeMode`. This is deliberate — TypeScript callers get type safety, JavaScript callers that bypass types still hit the runtime `isValidTheme` guard.)

- [ ] **Step 2: Typecheck and run unit tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 3: Build widget and run lint**

Run: `npm run build:widget && npm run lint`
Expected: build succeeds, lint clean.

- [ ] **Step 4: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat(widget): add window.BugDrop.setTheme runtime API (#104)"
```

---

## Task 11: Wire up the matchMedia listener in `exposeBugDropAPI`

**Files:**
- Modify: `src/widget/index.ts`

- [ ] **Step 1: Install the listener inside `exposeBugDropAPI`**

Inside `exposeBugDropAPI`, after the `window.BugDrop = { ... }` assignment but before the function returns, add:

```typescript
  // Fix for data-theme="auto" not following OS changes after init.
  // One persistent listener gated by _currentMode === 'auto'.
  _detachSystemListener = attachSystemThemeListener((resolved) => {
    if (_currentMode !== 'auto') return;
    applyThemeClass(root, resolved);
    applyCustomStyles(root, config, resolved);
  });
```

- [ ] **Step 2: Typecheck and run unit tests**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 3: Build widget**

Run: `npm run build:widget`
Expected: builds clean. The bundle `public/widget.js` should be regenerated.

- [ ] **Step 4: Commit**

```bash
git add src/widget/index.ts
git commit -m "feat(widget): auto-follow OS theme changes via matchMedia listener (#104)"
```

---

## Task 12: E2E — scaffold `e2e/theme.spec.ts` and add first three cases

Pre-req: `npm run build:widget` has been run (Task 11). E2E uses `public/widget.js` which is gitignored.

**Files:**
- Create: `e2e/theme.spec.ts`

- [ ] **Step 1: Create the test file**

```typescript
// e2e/theme.spec.ts
import { test, expect, type Page } from '@playwright/test';

/**
 * Helper: initialize the widget with the given data-* attributes by navigating
 * to test/index.html with a URL fragment the harness page reads to rewrite the
 * script tag. If test/index.html doesn't already support this pattern, update
 * the harness to read `?theme=...&bg=...` and inject the matching attributes.
 */
async function gotoWidget(page: Page, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  await page.goto(`/test/index.html${qs ? '?' + qs : ''}`);
  await page.waitForFunction(() => (window as unknown as { BugDrop?: unknown }).BugDrop != null);
}

async function rootClassList(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-bugdrop-host]') as HTMLElement | null;
    const shadow = host?.shadowRoot;
    const root = shadow?.querySelector('.bd-root') as HTMLElement | null;
    return root ? Array.from(root.classList) : [];
  });
}

test.describe('Runtime theme switching', () => {
  test('setTheme("dark") adds bd-dark to the root', async ({ page }) => {
    await gotoWidget(page, { theme: 'light' });
    expect(await rootClassList(page)).not.toContain('bd-dark');
    await page.evaluate(() => window.BugDrop!.setTheme('dark'));
    expect(await rootClassList(page)).toContain('bd-dark');
  });

  test('setTheme("light") removes bd-dark from the root', async ({ page }) => {
    await gotoWidget(page, { theme: 'dark' });
    expect(await rootClassList(page)).toContain('bd-dark');
    await page.evaluate(() => window.BugDrop!.setTheme('light'));
    expect(await rootClassList(page)).not.toContain('bd-dark');
  });

  test('invalid input warns and does not change the class', async ({ page }) => {
    await gotoWidget(page, { theme: 'light' });
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    await page.evaluate(() => window.BugDrop!.setTheme('blue' as unknown as 'light'));
    expect(await rootClassList(page)).not.toContain('bd-dark');
    expect(warnings.some((w) => w.includes('[BugDrop] Invalid theme'))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify the test harness supports query-param theme injection**

Check `test/index.html`: the existing file (per earlier exploration) has a hardcoded `data-theme="light"`. The helper above assumes the harness reads URL params and injects them as `data-*`. If it doesn't, you have two options:

**Option A (minimal):** write a small inline script at the top of `test/index.html` that reads `location.search` and sets `document.currentScript.dataset.theme`/`data-bg` on the BugDrop script tag before it loads. Add this to `test/index.html` before shipping.

**Option B (simpler for E2E):** spin up separate minimal HTML files in `e2e/fixtures/` for each theme case. More files, but test/index.html stays untouched.

**Recommendation:** Option A. Keeps E2E fixtures colocated with tests and test/index.html gains a small (~10 line) harness tweak. If it turns out test/index.html already supports query params (check the file first), skip this step.

- [ ] **Step 3: Run the new E2E tests**

Run: `npm run test:e2e -- e2e/theme.spec.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/theme.spec.ts test/index.html  # include test/index.html if you edited it in Step 2
git commit -m "test(e2e): add setTheme happy-path and invalid-input cases (#104)"
```

---

## Task 13: E2E — auto mode follows OS theme changes via `page.emulateMedia`

**Files:**
- Modify: `e2e/theme.spec.ts`

- [ ] **Step 1: Append the test**

Inside the existing `test.describe('Runtime theme switching', ...)`, add:

```typescript
  test('auto mode follows OS theme changes via page.emulateMedia', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoWidget(page, { theme: 'auto' });
    expect(await rootClassList(page)).not.toContain('bd-dark');

    await page.emulateMedia({ colorScheme: 'dark' });
    // Give the matchMedia change event a tick to propagate
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-bugdrop-host]') as HTMLElement | null;
      const root = host?.shadowRoot?.querySelector('.bd-root') as HTMLElement | null;
      return root?.classList.contains('bd-dark') === true;
    });
    expect(await rootClassList(page)).toContain('bd-dark');
  });

  test('setTheme("auto") resolves to current emulated OS theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoWidget(page, { theme: 'light' });
    expect(await rootClassList(page)).not.toContain('bd-dark');
    await page.evaluate(() => window.BugDrop!.setTheme('auto'));
    expect(await rootClassList(page)).toContain('bd-dark');
  });
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- e2e/theme.spec.ts`
Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/theme.spec.ts
git commit -m "test(e2e): verify auto mode follows OS theme changes (#104)"
```

---

## Task 14: E2E — `bgColor` + `setTheme` re-derives secondary/tertiary

**Files:**
- Modify: `e2e/theme.spec.ts`

- [ ] **Step 1: Append the test**

```typescript
  test('bgColor + setTheme re-derives --bd-bg-secondary via color-mix', async ({ page }) => {
    await gotoWidget(page, { theme: 'light', bg: '#fffef0' });

    const readSecondary = () =>
      page.evaluate(() => {
        const host = document.querySelector('[data-bugdrop-host]') as HTMLElement | null;
        const root = host?.shadowRoot?.querySelector('.bd-root') as HTMLElement | null;
        return root?.style.getPropertyValue('--bd-bg-secondary') ?? '';
      });

    const lightValue = await readSecondary();
    expect(lightValue).toContain('black'); // light-mode mix

    await page.evaluate(() => window.BugDrop!.setTheme('dark'));
    const darkValue = await readSecondary();
    expect(darkValue).toContain('white'); // dark-mode mix
    expect(darkValue).not.toBe(lightValue);
  });
```

Note: this test requires the `test/index.html` harness (or fixture approach) to support a `bg` query param that maps to `data-bg` on the BugDrop script tag. If you took Option A in Task 12, extend the harness script to include `bg`; if Option B, create a new fixture with `data-bg="#fffef0"`.

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- e2e/theme.spec.ts`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/theme.spec.ts test/index.html  # if harness touched
git commit -m "test(e2e): verify bgColor re-derives on runtime theme change (#104)"
```

---

## Task 15: Full local verification

**Files:** (none modified)

- [ ] **Step 1: Run the full check suite**

Run:

```bash
npm run lint && \
npm run typecheck && \
npm test && \
npm run build:widget && \
npm run test:e2e
```

Expected: every command exits 0. This mirrors what CI will run.

- [ ] **Step 2: Sanity-check bundle size**

Run: `ls -lh public/widget.js`
Expected: size within a few KB of its previous value. A big delta (>10 KB) suggests something went wrong in the extraction.

- [ ] **Step 3: Manual smoke test (optional but recommended)**

Run: `npx wrangler dev` and open `http://localhost:8787/test/index.html` in a browser. In the console:

```javascript
window.BugDrop.setTheme('dark');     // widget turns dark
window.BugDrop.setTheme('light');    // widget turns light
window.BugDrop.setTheme('auto');     // widget matches OS
window.BugDrop.setTheme('blue');     // console.warn, no change
window.BugDrop.setTheme(null);       // console.warn, no change
window.BugDrop.setTheme(undefined);  // console.warn, no change
```

Then toggle your OS theme (or use devtools Rendering panel → Emulate CSS media feature prefers-color-scheme) while the widget is in `'auto'` mode — it should follow.

- [ ] **Step 4: No commit here.** All changes are already committed.

---

## Task 16: Pre-PR review gate (required by CLAUDE.md)

**Files:** (none modified unless review surfaces issues)

- [ ] **Step 1: Launch three `pr-review-toolkit` agents in parallel**

Dispatch these agents **in a single message with multiple Agent tool calls** so they run concurrently:

1. `pr-review-toolkit:code-reviewer` — bugs, logic errors, adherence to project conventions. Focus on: the `applyCustomStyles` extraction (did we miss a branch or change behavior?), the matchMedia listener lifecycle, the `setTheme` validation path.

2. `pr-review-toolkit:pr-test-analyzer` — test coverage completeness, missing edge cases. Prompt it specifically to check whether the `bgColor + setTheme` case has a test, whether the matchMedia `auto` path is covered end-to-end, and whether invalid-input handling is verified in both unit and E2E.

3. `pr-review-toolkit:code-simplifier` — duplication, unnecessary complexity. Ask it specifically whether `_detachSystemListener` is actually used anywhere (it shouldn't be called in this PR but should exist per the spec).

- [ ] **Step 2: Also launch `pr-review-toolkit:silent-failure-hunter` in parallel**

This PR adds error handling (the `isValidTheme` guard) and a listener pattern that *could* swallow errors. Specifically ask the agent to check:
- Does the matchMedia callback have any try/catch that could mask real errors?
- Does `setTheme` silently succeed for edge inputs that should warn?
- Does `attachSystemThemeListener`'s no-op fallback hide a real environmental problem?

- [ ] **Step 3: Also launch `pr-review-toolkit:type-design-analyzer`**

We added new types (`ThemeMode`, `ResolvedTheme`, `ThemeConfigSlice`). Ask the analyzer to check encapsulation, invariant expression, and whether `ThemeConfigSlice` is the right boundary (vs. re-using the full `WidgetConfig`).

- [ ] **Step 4: Address findings**

Triage each agent's findings:
- **Critical / important**: fix inline before PR.
- **Nit**: fix if cheap, defer if not.
- **Out of scope**: note in PR description under "deferred".

If fixes were substantial (e.g. renamed a type, changed a function signature), re-run only the agents whose concerns were affected. Don't re-run all four.

- [ ] **Step 5: Commit any review-driven fixes**

If any code changed during review:

```bash
git add <changed files>
git commit -m "fix(theme): address review feedback — <short summary>"
```

- [ ] **Step 6: Re-run the full check suite once more**

Run:

```bash
npm run lint && npm run typecheck && npm test && npm run build:widget && npm run test:e2e
```

Expected: all green.

---

## Task 17: Push branch and open PR

**Files:** (none — just git/gh operations)

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/runtime-theme-api
```

- [ ] **Step 2: Open PR with conventional-commit title**

Use the `/pr-creator` skill if available, or run `gh pr create` directly:

```bash
gh pr create --title "feat: runtime theme switching API" --body "$(cat <<'EOF'
Closes #104

## Summary

- Adds `window.BugDrop.setTheme('light' | 'dark' | 'auto')` so host apps can sync the
  widget theme when their own theme toggle changes (concrete use case: Seatify).
- Fixes the latent bug that `data-theme="auto"` never followed OS theme changes after
  init — the widget now installs a `matchMedia('(prefers-color-scheme: dark)')`
  listener at init and updates automatically when `_currentMode === 'auto'`.
- Extracts all theme-dependent inline-style logic out of `injectStyles` into a new
  focused `src/widget/theme.ts` module. `ui.ts` shrinks by ~50 lines.

## Design

Full design spec: `docs/superpowers/specs/2026-04-15-runtime-theme-api-design.md`.

**Locked-in decisions**: `void` return, `console.warn` on invalid input, no events
(YAGNI), always-on matchMedia listener gated by mode check, `bgColor` derived styles
re-applied on every theme change via a consolidated `applyCustomStyles` helper.

## Test plan

- [x] `test/theme.test.ts` — unit tests for all six exports from `theme.ts`
      (isValidTheme, resolveTheme, getSystemTheme, applyThemeClass, applyCustomStyles,
      attachSystemThemeListener). Mocks `window.matchMedia`.
- [x] `e2e/theme.spec.ts` — 6 Playwright cases:
  - `setTheme('dark')` adds `bd-dark`
  - `setTheme('light')` removes `bd-dark`
  - Invalid input warns + no-ops
  - `auto` mode follows OS theme changes via `page.emulateMedia`
  - `setTheme('auto')` resolves to current emulated OS theme
  - `bgColor` + `setTheme` re-derives `--bd-bg-secondary` via `color-mix`
- [x] Local: `npm run lint && npm run typecheck && npm test && npm run build:widget && npm run test:e2e` all clean.
- [x] Manual browser smoke-test with `wrangler dev` covering valid/invalid input and OS theme toggle.

## Release validation

This PR is a `feat:` (minor version bump). Beyond shipping the feature, it's the first
real-world validation of the new `deploy.yml` with-release path from #111 — the
post-merge deploy should fire, `release` should publish a new minor tag, and `deploy`
should rebuild with the new VERSION and ship to Cloudflare Workers.

## Out of scope (per spec)

- `getTheme()` getter (no concrete consumer yet)
- `bugdrop:themechange` event emission (YAGNI)
- Legacy `.addListener` matchMedia fallback (graceful degradation sufficient)
- Screenshot-capture racing protection
EOF
)"
```

- [ ] **Step 3: Verify CI kicks off**

Run: `gh pr checks <pr-number>` (or open the PR URL in a browser). Expected checks:
- Lint
- Unit Tests & Build
- E2E Tests (Shard 1/2)
- E2E Tests (Shard 2/2)

(`Deploy Preview` and `Live Preview Tests` only run in the merge queue.)

- [ ] **Step 4: After CI passes, add to the merge queue**

Once all required checks are green, add the PR to the merge queue via the GitHub UI. The merge queue will run `Deploy Preview` and `Live Preview Tests`. After it merges:

1. `.github/workflows/deploy.yml` fires on `push: main`.
2. `release` job publishes a new minor tag.
3. `deploy` job builds with the new `VERSION` and ships to Cloudflare Workers.
4. Capture wall-clock for this run — it's the baseline we were waiting for from PR #111.

---

## Self-Review

**Spec coverage check** — every requirement from `2026-04-15-runtime-theme-api-design.md`:

- [x] New `src/widget/theme.ts` with 6 exports + 2 types + `ThemeConfigSlice`: Tasks 1-7.
- [x] `resolveTheme` pure, parameter-injectable, `'auto'` branch + passthrough: Task 4.
- [x] `isValidTheme` type guard rejecting non-strings and bad values: Task 2.
- [x] `getSystemTheme` moved from `ui.ts`, graceful fallback: Task 3.
- [x] `applyThemeClass` toggles `bd-dark` idempotently: Task 5.
- [x] `applyCustomStyles` covers accent/bg/text/border/shadow with theme-dependent branches (including `textColor` `bgBase` fallback and `shadow: hard` `shadowColor` fallback): Task 6.
- [x] `attachSystemThemeListener` with no-op fallback and cleanup return: Task 7.
- [x] `ui.ts injectStyles` delegates to extracted helpers: Task 8.
- [x] `BugDropAPI` interface extended with `setTheme`: Task 9.
- [x] `_currentMode` and `_detachSystemListener` module state: Tasks 9, 11.
- [x] `setTheme` implementation with `isValidTheme` guard + `console.warn`: Task 10.
- [x] matchMedia listener installed once in `exposeBugDropAPI`, gated by `_currentMode === 'auto'`: Task 11.
- [x] Unit tests for all helpers: Tasks 2-7.
- [x] E2E: 6 cases including auto+emulateMedia and bgColor re-derivation: Tasks 12-14.
- [x] Full verification including `build:widget` before E2E: Task 15.
- [x] Pre-PR review gate (3+ agents) per CLAUDE.md: Task 16.
- [x] PR with conventional-commit `feat:` title (triggers minor release) + closes #104: Task 17.

**Placeholder scan**: no `TBD`, `TODO`, `implement later`, `similar to task N`, or hand-wavy steps. Every code step shows the actual code.

**Type consistency**: `ThemeMode` and `ResolvedTheme` are used consistently across all tasks. `ThemeConfigSlice` is declared in Task 1 and consumed by `applyCustomStyles` in Task 6, then in `ui.ts` and `index.ts` via the full `WidgetConfig` (which is structurally assignable to `ThemeConfigSlice`). Method names (`resolveTheme`, `isValidTheme`, `applyThemeClass`, `applyCustomStyles`, `attachSystemThemeListener`, `getSystemTheme`, `setTheme`) match between spec, interface declaration, implementation, and tests.

One thing to watch during implementation: **Task 12 Step 2 is contingent on `test/index.html`'s current harness capabilities**. The planner hasn't opened the file to confirm what query-param support exists. Implementation should start Task 12 by reading `test/index.html` and picking Option A or Option B based on what's actually there.
