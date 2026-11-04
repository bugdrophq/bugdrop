# Screenshot Privacy Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a developer-configured screenshot masking primitive that paints opaque rectangles over `data-bugdrop-mask` elements (and password/credit-card inputs by default) on the captured PNG before the annotator opens.

**Architecture:** A new `src/widget/mask.ts` module exposes `collectMaskRects(root)` (DOM walk → document-coordinate rects) and `applyMaskToImage(dataUrl, rects, pixelRatio, originOffset?)` (canvas blit). `captureScreenshot` chains these between `html-to-image` and the existing return path. No DOM mutation, no annotator changes, no new public API.

**Tech Stack:** TypeScript, esbuild widget bundle, `html-to-image` (already bundled), Vitest with jsdom for unit tests, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-05-10-screenshot-privacy-masking-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/widget/mask.ts` | Create | Pure DOM-walk + canvas-blit logic. ~120 lines. |
| `src/widget/screenshot.ts` | Modify | Wire mask collection + application into `captureScreenshot`. |
| `test/mask.test.ts` | Create | Unit tests for `collectMaskRects` + `translateMaskRect` math. |
| `public/test/masking-basic.html` | Create | E2E fixture: single masked div + password input. |
| `public/test/masking-nested.html` | Create | E2E fixture: nested masks + mixed siblings. |
| `e2e/widget.spec.ts` | Modify | New `Screenshot Masking` describe block. |
| `docs/website/security.mdx` | Modify | "Screenshot masking" subsection under Privacy. |
| `docs/website/installation.mdx` | Modify | Brief "Protecting sensitive data" section. |
| `README.md` | Modify | One-paragraph mention with example. |

`src/widget/index.ts` is intentionally unchanged — masks are baked into the PNG by `captureScreenshot`, so the existing annotator and area-crop flows pick them up for free.

---

## Conventions Worth Knowing

- **Vitest env:** default is `node`. Tests using DOM start with `// @vitest-environment jsdom` (see `test/cropScreenshot.test.ts:1`).
- **Test seam:** `window.__bugdropMockToPng` is read in `src/widget/screenshot.ts:33` and lets tests stub the underlying `html-to-image.toPng`. Same pattern works for masking E2E.
- **E2E fixture pages:** lives in `public/test/`, served by `wrangler dev` at `http://localhost:8787/test/<file>.html`. Existing examples: `public/test/annotation-preview-size.html`.
- **Build before E2E:** widget changes require `npm run build:widget` to regenerate `public/widget.js` (gitignored).
- **Commit messages:** conventional commits enforced by commitlint. `feat:` for new behavior, `test:` for tests-only, `docs:` for docs-only.
- **DOM cleanup in unit tests:** prefer `document.body.replaceChildren()` over `innerHTML = ''` — the project's pre-write security hook flags any `innerHTML` assignment, even empty-string.

---

## Task 1: Create `mask.ts` skeleton with types and signatures

**Files:**
- Create: `src/widget/mask.ts`
- Create: `test/mask.test.ts`

- [ ] **Step 1: Write a smoke test that mask.ts exports the expected names**

Create `test/mask.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { collectMaskRects, applyMaskToImage } from '../src/widget/mask';

describe('mask module exports', () => {
  it('exports collectMaskRects', () => {
    expect(typeof collectMaskRects).toBe('function');
  });

  it('exports applyMaskToImage', () => {
    expect(typeof applyMaskToImage).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to see the import fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — `Cannot find module '../src/widget/mask'`.

- [ ] **Step 3: Create the mask.ts skeleton**

Create `src/widget/mask.ts`:

```ts
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function collectMaskRects(_root: Element): MaskRect[] {
  return [];
}

export async function applyMaskToImage(
  dataUrl: string,
  _rects: MaskRect[],
  _pixelRatio: number,
  _originOffset?: { x: number; y: number }
): Promise<string> {
  return dataUrl;
}
```

- [ ] **Step 4: Run the test to see it pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — both export checks succeed.

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: scaffold screenshot mask module"
```

---

## Task 2: Implement `collectMaskRects` for explicit `data-bugdrop-mask`

**Files:**
- Modify: `src/widget/mask.ts`
- Modify: `test/mask.test.ts`

- [ ] **Step 1: Add a test helper and tests for the basic explicit-attribute case**

Update the imports at the top of `test/mask.test.ts` to include `beforeEach`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
```

Append to `test/mask.test.ts`:

```ts
function withRect(el: HTMLElement, x: number, y: number, w: number, h: number): HTMLElement {
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width: w,
      height: h,
      top: y,
      left: x,
      bottom: y + h,
      right: x + w,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  return el;
}

describe('collectMaskRects — explicit attribute', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('returns empty array for clean DOM', () => {
    expect(collectMaskRects(document.body)).toEqual([]);
  });

  it('returns rect for a single masked div', () => {
    const div = withRect(document.createElement('div'), 10, 20, 100, 50);
    div.setAttribute('data-bugdrop-mask', '');
    document.body.appendChild(div);

    expect(collectMaskRects(document.body)).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
  });

  it('returns rects for multiple sibling masked elements', () => {
    const a = withRect(document.createElement('div'), 0, 0, 50, 50);
    a.setAttribute('data-bugdrop-mask', '');
    const b = withRect(document.createElement('div'), 100, 0, 50, 50);
    b.setAttribute('data-bugdrop-mask', '');
    document.body.append(a, b);

    expect(collectMaskRects(document.body)).toEqual([
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 100, y: 0, w: 50, h: 50 },
    ]);
  });
});
```

- [ ] **Step 2: Run the new tests to see them fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — the two attribute tests get `[]` but expect rects.

- [ ] **Step 3: Implement explicit-attribute collection**

Replace the body of `collectMaskRects` in `src/widget/mask.ts`:

```ts
const MASK_SELECTOR = '[data-bugdrop-mask]';

export function collectMaskRects(root: Element): MaskRect[] {
  const rects: MaskRect[] = [];
  const matches = root.querySelectorAll<HTMLElement>(MASK_SELECTOR);
  for (const el of matches) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  }
  return rects;
}
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — 5 tests (2 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: collect mask rects for [data-bugdrop-mask] elements"
```

---

## Task 3: Add password and credit-card autocomplete defaults

**Files:**
- Modify: `src/widget/mask.ts`
- Modify: `test/mask.test.ts`

- [ ] **Step 1: Add tests for the built-in defaults**

Append to `test/mask.test.ts`:

```ts
describe('collectMaskRects — built-in defaults', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('masks input[type="password"] without explicit attribute', () => {
    const input = withRect(document.createElement('input'), 0, 0, 200, 30);
    input.type = 'password';
    document.body.appendChild(input);

    expect(collectMaskRects(document.body)).toEqual([{ x: 0, y: 0, w: 200, h: 30 }]);
  });

  it('masks credit-card autocomplete inputs', () => {
    const ccNumber = withRect(document.createElement('input'), 0, 0, 200, 30);
    ccNumber.setAttribute('autocomplete', 'cc-number');
    const ccCsc = withRect(document.createElement('input'), 0, 40, 80, 30);
    ccCsc.setAttribute('autocomplete', 'cc-csc');
    const ccExp = withRect(document.createElement('input'), 0, 80, 80, 30);
    ccExp.setAttribute('autocomplete', 'cc-exp');
    document.body.append(ccNumber, ccCsc, ccExp);

    const rects = collectMaskRects(document.body);
    expect(rects).toHaveLength(3);
    expect(rects).toContainEqual({ x: 0, y: 0, w: 200, h: 30 });
    expect(rects).toContainEqual({ x: 0, y: 40, w: 80, h: 30 });
    expect(rects).toContainEqual({ x: 0, y: 80, w: 80, h: 30 });
  });

  it('does not double-count an element matching multiple criteria', () => {
    const input = withRect(document.createElement('input'), 0, 0, 200, 30);
    input.type = 'password';
    input.setAttribute('data-bugdrop-mask', '');
    document.body.appendChild(input);

    expect(collectMaskRects(document.body)).toEqual([{ x: 0, y: 0, w: 200, h: 30 }]);
  });
});
```

- [ ] **Step 2: Run the new tests to see them fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — defaults are not yet collected.

- [ ] **Step 3: Add defaults to the selector with deduplication**

Replace the implementation in `src/widget/mask.ts`:

```ts
const EXPLICIT_SELECTOR = '[data-bugdrop-mask]';
const DEFAULT_SELECTOR =
  'input[type="password"], input[autocomplete*="cc-number"], input[autocomplete*="cc-csc"], input[autocomplete*="cc-exp"]';
const COMBINED_SELECTOR = `${EXPLICIT_SELECTOR}, ${DEFAULT_SELECTOR}`;

export function collectMaskRects(root: Element): MaskRect[] {
  const seen = new Set<Element>();
  const rects: MaskRect[] = [];
  const matches = root.querySelectorAll<HTMLElement>(COMBINED_SELECTOR);
  for (const el of matches) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  }
  return rects;
}
```

The `seen` set guards against an element matching both selectors. `querySelectorAll` only returns each element once for a comma-separated selector, but the set future-proofs this once the top-most-ancestor logic in Task 4 starts adding manual collection paths.

- [ ] **Step 4: Run the tests to see them pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: add default mask coverage for password and cc-* inputs"
```

---

## Task 4: Top-most ancestor rule, root inclusion, scoped collection

**Files:**
- Modify: `src/widget/mask.ts`
- Modify: `test/mask.test.ts`

- [ ] **Step 1: Add tests for nesting, scoping, and root inclusion**

Append to `test/mask.test.ts`:

```ts
describe('collectMaskRects — nesting and scoping', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('returns parent-only rect when a masked element is inside another masked element', () => {
    const parent = withRect(document.createElement('div'), 0, 0, 200, 100);
    parent.setAttribute('data-bugdrop-mask', '');
    const child = withRect(document.createElement('div'), 10, 10, 50, 30);
    child.setAttribute('data-bugdrop-mask', '');
    parent.appendChild(child);
    document.body.appendChild(parent);

    expect(collectMaskRects(document.body)).toEqual([{ x: 0, y: 0, w: 200, h: 100 }]);
  });

  it('does not separately mask password input nested inside masked ancestor', () => {
    const parent = withRect(document.createElement('div'), 0, 0, 200, 100);
    parent.setAttribute('data-bugdrop-mask', '');
    const password = withRect(document.createElement('input'), 10, 10, 100, 20);
    password.type = 'password';
    parent.appendChild(password);
    document.body.appendChild(parent);

    expect(collectMaskRects(document.body)).toEqual([{ x: 0, y: 0, w: 200, h: 100 }]);
  });

  it('returns rects for descendant masks of an unmasked parent', () => {
    const parent = withRect(document.createElement('div'), 0, 0, 200, 100);
    const a = withRect(document.createElement('span'), 10, 10, 50, 20);
    a.setAttribute('data-bugdrop-mask', '');
    const b = withRect(document.createElement('span'), 100, 10, 50, 20);
    b.setAttribute('data-bugdrop-mask', '');
    parent.append(a, b);
    document.body.appendChild(parent);

    expect(collectMaskRects(document.body)).toEqual([
      { x: 10, y: 10, w: 50, h: 20 },
      { x: 100, y: 10, w: 50, h: 20 },
    ]);
  });

  it('scoped collection ignores siblings outside the root', () => {
    const target = withRect(document.createElement('div'), 0, 0, 200, 100);
    const inside = withRect(document.createElement('span'), 10, 10, 50, 20);
    inside.setAttribute('data-bugdrop-mask', '');
    target.appendChild(inside);
    const outside = withRect(document.createElement('span'), 300, 0, 50, 20);
    outside.setAttribute('data-bugdrop-mask', '');
    document.body.append(target, outside);

    expect(collectMaskRects(target)).toEqual([{ x: 10, y: 10, w: 50, h: 20 }]);
  });

  it('root inclusion: returns a rect when root itself is masked', () => {
    const root = withRect(document.createElement('div'), 0, 0, 200, 100);
    root.setAttribute('data-bugdrop-mask', '');
    document.body.appendChild(root);

    expect(collectMaskRects(root)).toEqual([{ x: 0, y: 0, w: 200, h: 100 }]);
  });

  it('root inclusion: returns a rect when root is a built-in default (password input)', () => {
    const input = withRect(document.createElement('input'), 0, 0, 200, 30);
    input.type = 'password';
    document.body.appendChild(input);

    expect(collectMaskRects(input)).toEqual([{ x: 0, y: 0, w: 200, h: 30 }]);
  });
});
```

- [ ] **Step 2: Run the new tests to see them fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — current implementation walks all descendants flatly and ignores `root` itself. The nested case will return both parent and child rects (and the password one); root inclusion returns nothing.

- [ ] **Step 3: Rewrite `collectMaskRects` with proper traversal**

Replace the body of `src/widget/mask.ts` (keep the `MaskRect` interface and selectors):

```ts
const EXPLICIT_SELECTOR = '[data-bugdrop-mask]';
const DEFAULT_SELECTOR =
  'input[type="password"], input[autocomplete*="cc-number"], input[autocomplete*="cc-csc"], input[autocomplete*="cc-exp"]';

function shouldMask(el: Element): boolean {
  return el.matches(EXPLICIT_SELECTOR) || el.matches(DEFAULT_SELECTOR);
}

function pushRect(el: Element, rects: MaskRect[]): void {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
}

export function collectMaskRects(root: Element): MaskRect[] {
  const rects: MaskRect[] = [];

  if (shouldMask(root)) {
    pushRect(root, rects);
    return rects;
  }

  walk(root, rects);
  return rects;
}

function walk(node: Element, rects: MaskRect[]): void {
  for (const child of Array.from(node.children)) {
    if (shouldMask(child)) {
      pushRect(child, rects);
      // Top-most-ancestor rule: do not descend into masked subtrees.
      continue;
    }
    walk(child, rects);
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — 14 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: top-most-ancestor rule and root inclusion for mask collection"
```

---

## Task 5: Document coordinates and visibility/opacity edge cases

**Files:**
- Modify: `src/widget/mask.ts`
- Modify: `test/mask.test.ts`

- [ ] **Step 1: Add tests for scrolled coordinates, visibility:hidden, opacity:0, and zero-size**

Append to `test/mask.test.ts`:

```ts
describe('collectMaskRects — coordinates and visibility', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('returns document coordinates by adding window.scrollX / scrollY', () => {
    Object.defineProperty(window, 'scrollX', { value: 50, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 200, configurable: true });

    const div = withRect(document.createElement('div'), 10, 20, 100, 50);
    div.setAttribute('data-bugdrop-mask', '');
    document.body.appendChild(div);

    expect(collectMaskRects(document.body)).toEqual([{ x: 60, y: 220, w: 100, h: 50 }]);
  });

  it('skips elements with zero getBoundingClientRect()', () => {
    const div = withRect(document.createElement('div'), 0, 0, 0, 0);
    div.setAttribute('data-bugdrop-mask', '');
    document.body.appendChild(div);

    expect(collectMaskRects(document.body)).toEqual([]);
  });

  it('includes visibility:hidden elements (defense in depth)', () => {
    const div = withRect(document.createElement('div'), 10, 20, 100, 50);
    div.setAttribute('data-bugdrop-mask', '');
    div.style.visibility = 'hidden';
    document.body.appendChild(div);

    expect(collectMaskRects(document.body)).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
  });

  it('includes opacity:0 elements (defense in depth)', () => {
    const div = withRect(document.createElement('div'), 10, 20, 100, 50);
    div.setAttribute('data-bugdrop-mask', '');
    div.style.opacity = '0';
    document.body.appendChild(div);

    expect(collectMaskRects(document.body)).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
  });
});
```

- [ ] **Step 2: Run the new tests to see them fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — the scrolled-coordinates test gets `{x:10, y:20}` but expects `{x:60, y:220}`. Visibility/opacity/zero-size tests already pass with the current implementation, which is fine.

- [ ] **Step 3: Update `pushRect` to add scroll offset**

Replace the `pushRect` helper in `src/widget/mask.ts`:

```ts
function pushRect(el: Element, rects: MaskRect[]): void {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  rects.push({
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    w: rect.width,
    h: rect.height,
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — 18 tests. Existing non-scrolled tests still pass because `scrollX` and `scrollY` are reset to 0 in their `beforeEach`.

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: emit document-coordinate mask rects (scroll-aware)"
```

---

## Task 6: Implement `applyMaskToImage` with extracted `translateMaskRect` math

**Files:**
- Modify: `src/widget/mask.ts`
- Modify: `test/mask.test.ts`

The pure math is unit-tested; the canvas orchestration is exercised end-to-end in Tasks 9–12 (jsdom canvas pixel verification is unreliable, mirroring the existing approach in `test/cropScreenshot.test.ts`).

- [ ] **Step 1: Add tests for the pure `translateMaskRect` math**

Update the import at the top of `test/mask.test.ts`:

```ts
import { collectMaskRects, applyMaskToImage, translateMaskRect } from '../src/widget/mask';
```

Append to `test/mask.test.ts`:

```ts
describe('translateMaskRect', () => {
  it('scales a rect by pixelRatio with no origin offset', () => {
    expect(
      translateMaskRect({ x: 10, y: 20, w: 100, h: 50 }, 2, { x: 0, y: 0 }, 1000, 1000)
    ).toEqual({ x: 20, y: 40, w: 200, h: 100 });
  });

  it('subtracts originOffset before scaling', () => {
    expect(
      translateMaskRect({ x: 110, y: 220, w: 100, h: 50 }, 2, { x: 100, y: 200 }, 1000, 1000)
    ).toEqual({ x: 20, y: 40, w: 200, h: 100 });
  });

  it('clips a rect that overflows the canvas on the right and bottom', () => {
    expect(
      translateMaskRect({ x: 90, y: 90, w: 30, h: 30 }, 1, { x: 0, y: 0 }, 100, 100)
    ).toEqual({ x: 90, y: 90, w: 10, h: 10 });
  });

  it('clips a rect that starts to the left and above the canvas', () => {
    expect(
      translateMaskRect({ x: -10, y: -20, w: 30, h: 50 }, 1, { x: 0, y: 0 }, 100, 100)
    ).toEqual({ x: 0, y: 0, w: 20, h: 30 });
  });

  it('returns a non-positive size when fully outside the canvas', () => {
    const out = translateMaskRect({ x: 1000, y: 1000, w: 50, h: 50 }, 1, { x: 0, y: 0 }, 100, 100);
    expect(out.w).toBeLessThanOrEqual(0);
    expect(out.h).toBeLessThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the new tests to see them fail**

```bash
npm test -- test/mask.test.ts
```

Expected: FAIL — `translateMaskRect` is not exported.

- [ ] **Step 3: Implement `translateMaskRect` and the full `applyMaskToImage`**

Append the following to `src/widget/mask.ts`:

```ts
export function translateMaskRect(
  rect: MaskRect,
  pixelRatio: number,
  originOffset: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number
): MaskRect {
  const rawX = (rect.x - originOffset.x) * pixelRatio;
  const rawY = (rect.y - originOffset.y) * pixelRatio;
  const rawW = rect.w * pixelRatio;
  const rawH = rect.h * pixelRatio;

  const x = Math.max(0, rawX);
  const y = Math.max(0, rawY);
  const right = Math.min(canvasWidth, rawX + rawW);
  const bottom = Math.min(canvasHeight, rawY + rawH);

  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
  };
}
```

Replace the stub `applyMaskToImage` body with:

```ts
export async function applyMaskToImage(
  dataUrl: string,
  rects: MaskRect[],
  pixelRatio: number,
  originOffset: { x: number; y: number } = { x: 0, y: 0 }
): Promise<string> {
  if (rects.length === 0) return dataUrl;

  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#000';
  for (const rect of rects) {
    const t = translateMaskRect(rect, pixelRatio, originOffset, canvas.width, canvas.height);
    if (t.w <= 0 || t.h <= 0) continue;
    ctx.fillRect(t.x, t.y, t.w, t.h);
  }

  return canvas.toDataURL('image/png');
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to apply privacy masks'));
    img.src = dataUrl;
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
npm test -- test/mask.test.ts
```

Expected: PASS — 23 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/widget/mask.ts test/mask.test.ts
git commit -m "feat: implement applyMaskToImage with translateMaskRect helper"
```

---

## Task 7: Wire mask pipeline into `captureScreenshot`

**Files:**
- Modify: `src/widget/screenshot.ts`
- Modify: `test/cropScreenshot.test.ts`

The integration is small: `captureScreenshot` calls `collectMaskRects` and computes `originOffset` BEFORE invoking `toPng`, then `applyMaskToImage` on the result. Computing rects before the await ensures the document state is captured at the same instant capture begins.

- [ ] **Step 1: Add an integration test verifying `captureScreenshot` short-circuits with no masks**

Append to `test/cropScreenshot.test.ts`:

```ts
import { captureScreenshot } from '../src/widget/screenshot';

describe('captureScreenshot integrates with mask pipeline', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  afterEach(() => {
    delete (window as unknown as { __bugdropMockToPng?: unknown }).__bugdropMockToPng;
  });

  it('returns the toPng output unchanged when no masked elements exist', async () => {
    const STUB =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    (window as unknown as { __bugdropMockToPng: () => Promise<string> }).__bugdropMockToPng =
      () => Promise.resolve(STUB);

    const result = await captureScreenshot();

    // No masks → applyMaskToImage short-circuits and returns the input unchanged.
    expect(result).toBe(STUB);
  });

  it('completes element-scoped capture when the picked element has a masked descendant', async () => {
    const target = document.createElement('section');
    target.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        top: 0,
        left: 0,
        bottom: 200,
        right: 200,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const masked = document.createElement('div');
    masked.setAttribute('data-bugdrop-mask', '');
    masked.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 10,
        width: 50,
        height: 30,
        top: 10,
        left: 10,
        bottom: 40,
        right: 60,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    target.appendChild(masked);
    document.body.appendChild(target);

    const STUB =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    (window as unknown as { __bugdropMockToPng: () => Promise<string> }).__bugdropMockToPng =
      () => Promise.resolve(STUB);

    // Should not throw — exercises the element-scoped wiring.
    await expect(captureScreenshot(target)).resolves.toBeDefined();
  });
});
```

The existing import line in `test/cropScreenshot.test.ts` already includes `beforeEach` and `afterEach`. Confirm before editing:

```bash
grep -n "import.*beforeEach.*afterEach" test/cropScreenshot.test.ts
```

If they are missing, update the import to include them.

- [ ] **Step 2: Run the integration test against the current (un-wired) implementation**

```bash
npm test -- test/cropScreenshot.test.ts
```

Expected: PASS — both tests will pass even before the wiring change, because they exercise the no-mask paths. Treat this as a baseline check; the meaningful verification is that they continue to pass AFTER the wiring change in Step 3.

- [ ] **Step 3: Wire mask collection and application into `captureScreenshot`**

Open `src/widget/screenshot.ts`. Add the import at the top:

```ts
import { collectMaskRects, applyMaskToImage } from './mask';
```

Replace the body of `captureScreenshot` (currently `screenshot.ts:23-57`) with:

```ts
export async function captureScreenshot(
  element?: Element,
  screenshotScale?: number
): Promise<string> {
  const target = element || document.body;
  const isFullPage = !element;

  const pixelRatio = getPixelRatio(isFullPage, screenshotScale);

  const toPng =
    (window as unknown as { __bugdropMockToPng?: typeof htmlToImage.toPng }).__bugdropMockToPng ??
    htmlToImage.toPng;

  const opts = {
    cacheBust: true,
    pixelRatio,
    filter: (node: HTMLElement) => node.id !== 'bugdrop-host',
  };

  const rects = collectMaskRects(target);
  const originOffset = element
    ? (() => {
        const r = element.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY };
      })()
    : { x: 0, y: 0 };

  const capturePromise = toPng(target as HTMLElement, opts);

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Screenshot capture timed out — the page may be too complex')),
      CAPTURE_TIMEOUT_MS
    );
  });

  try {
    const dataUrl = await Promise.race([capturePromise, timeoutPromise]);
    return await applyMaskToImage(dataUrl, rects, pixelRatio, originOffset);
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 4: Run the unit + integration tests to confirm they still pass**

```bash
npm test
```

Expected: PASS — all existing tests plus the two new wiring checks. Total ≈ 141 (from 116 + new mask tests + new wiring tests).

- [ ] **Step 5: Commit**

```bash
git add src/widget/screenshot.ts test/cropScreenshot.test.ts
git commit -m "feat: apply mask layer in captureScreenshot pipeline"
```

---

## Task 8: Create E2E fixture HTMLs and rebuild widget

**Files:**
- Create: `public/test/masking-basic.html`
- Create: `public/test/masking-nested.html`

These pages load the widget the same way as `public/test/index.html` and contain elements the masking E2E tests reference by selector.

- [ ] **Step 1: Inspect the existing test page conventions**

```bash
ls public/test/
head -40 public/test/index.html
```

Note the `<script src="/widget.js" data-repo="..." ...>` wiring at the bottom.

- [ ] **Step 2: Create `public/test/masking-basic.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>BugDrop — Masking Basic</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: system-ui, sans-serif;
      }
      .field {
        margin: 16px 0;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 4px;
      }
      input,
      .panel {
        padding: 8px 12px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 14px;
      }
      input {
        width: 280px;
      }
      .panel {
        background: #fffbe6;
        max-width: 320px;
      }
    </style>
  </head>
  <body>
    <h1>Masking — Basic Fixture</h1>

    <div class="field">
      <label for="username">Username</label>
      <input id="username" type="text" value="alice" />
    </div>

    <div class="field">
      <label for="password">Password (auto-masked)</label>
      <input id="password" type="password" value="hunter2" />
    </div>

    <div class="field">
      <label>Customer (explicit mask)</label>
      <div id="customer-panel" class="panel" data-bugdrop-mask>
        Jane Doe — jane@acme.com — 555-0100
      </div>
    </div>

    <div class="field">
      <label>Public note (not masked)</label>
      <div id="public-note" class="panel">This text should appear in the screenshot.</div>
    </div>

    <script src="/widget.js" data-repo="test-org/test-repo" data-screenshot="optional"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `public/test/masking-nested.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>BugDrop — Masking Nested</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: system-ui, sans-serif;
      }
      .panel {
        padding: 16px;
        margin: 12px 0;
        border-radius: 6px;
      }
      .outer {
        background: #f0f4ff;
        max-width: 480px;
      }
      .inner-masked {
        background: #fffbe6;
        padding: 12px;
        margin-top: 8px;
      }
      .public-sibling {
        background: #e6ffec;
        padding: 12px;
        margin-top: 8px;
      }
    </style>
  </head>
  <body>
    <h1>Masking — Nested Fixture</h1>

    <div id="outer-masked" class="panel outer" data-bugdrop-mask>
      <p>Outer container is masked — every descendant should be covered.</p>
      <div class="inner-masked" data-bugdrop-mask>Inner element also marked (parent rect wins).</div>
      <p>Sibling text inside the masked outer container.</p>
    </div>

    <div id="unmasked-parent" class="panel outer" style="background: #fff;">
      <p>This parent is NOT masked.</p>
      <div id="masked-child" class="public-sibling" data-bugdrop-mask>
        But this child IS masked — should appear black.
      </div>
      <p id="visible-sibling">This sibling text should appear in the screenshot.</p>
    </div>

    <script src="/widget.js" data-repo="test-org/test-repo" data-screenshot="optional"></script>
  </body>
</html>
```

- [ ] **Step 4: Rebuild the widget bundle**

```bash
npm run build:widget
```

Expected: build completes without errors and writes `public/widget.js`. Confirms the new `mask.ts` module compiles into the bundle.

- [ ] **Step 5: Commit**

```bash
git add public/test/masking-basic.html public/test/masking-nested.html
git commit -m "test: add E2E fixtures for screenshot privacy masking"
```

---

## Task 9: E2E — default password mask + explicit element mask + no-op control

**Files:**
- Modify: `e2e/widget.spec.ts`

These tests use the real `html-to-image` capture (no `__bugdropMockToPng`) so we get genuine pixel output and can verify the mask landed where we expect. Each test reads the submitted screenshot's pixels via `page.evaluate`.

- [ ] **Step 1: Verify `Page` is imported in the spec**

```bash
grep -n "import.*Page" e2e/widget.spec.ts | head -3
```

If `Page` is not imported, edit the import line near the top of `e2e/widget.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
```

- [ ] **Step 2: Append a new `Screenshot Masking` describe block to the bottom of `e2e/widget.spec.ts`**

```ts
test.describe('Screenshot Masking', () => {
  // Sample a single pixel from a base64 PNG payload via a page-side canvas.
  async function pixelAt(
    page: Page,
    dataUrl: string,
    x: number,
    y: number
  ): Promise<[number, number, number, number]> {
    return page.evaluate(
      ({ dataUrl, x, y }) =>
        new Promise<[number, number, number, number]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext('2d');
            if (!ctx) {
              reject(new Error('no ctx'));
              return;
            }
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(x, y, 1, 1).data;
            resolve([px[0], px[1], px[2], px[3]]);
          };
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      { dataUrl, x, y }
    );
  }

  // Read an element's bounding rect in document coordinates from the live page.
  async function docRectOf(page: Page, selector: string) {
    return page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element matches ${sel}`);
      const r = el.getBoundingClientRect();
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height,
      };
    }, selector);
  }

  // Walk the standard feedback flow up to a captured screenshot, returning the submitted payload.
  async function submitFeedbackWithFullPageCapture(
    page: Page,
    fixturePath: string
  ): Promise<{ screenshot: string; pixelRatio: number }> {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check/**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto(fixturePath);
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').waitFor();
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();

    await host.locator('css=#title').fill('Mask test');
    await host.locator('css=#submit-btn').click();

    // Choose Full Page capture.
    await host.locator('css=[data-action="capture"]').click();

    // Wait for annotation step (proves capture+mask completed).
    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });

    // Submit annotated screenshot.
    await host.locator('css=[data-action="annotate-done"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload captured');
    const pr = await page.evaluate(() => window.devicePixelRatio || 1);
    return { screenshot: payload.screenshot as string, pixelRatio: pr };
  }

  test('masks input[type=password] by default', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    const rect = await docRectOf(page, '#password');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('masks elements tagged with data-bugdrop-mask', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    const rect = await docRectOf(page, '#customer-panel');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('does not mask unrelated elements', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    const rect = await docRectOf(page, '#public-note');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    // Background of #public-note is light yellow; assert it's NOT solid black.
    expect(await pixelAt(page, screenshot, cx, cy)).not.toEqual([0, 0, 0, 255]);
  });
});
```

- [ ] **Step 3: Run the masking E2E tests**

```bash
npm run test:e2e -- --grep "Screenshot Masking"
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: e2e coverage for default and explicit screenshot masks"
```

---

## Task 10: E2E — inheritance and scrolled capture

**Files:**
- Modify: `e2e/widget.spec.ts`

- [ ] **Step 1: Append inheritance and scrolled tests INSIDE the existing `Screenshot Masking` describe block**

After the three tests from Task 9 (still inside the describe block), append:

```ts
test('parent mask covers all descendants (inheritance)', async ({ page }) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
    page,
    '/test/masking-nested.html'
  );

  // Sample inside the deeply-nested .inner-masked element — the OUTER mask
  // should already cover it, so this pixel must be opaque black.
  const innerRect = await docRectOf(page, '.inner-masked');
  const ix = Math.floor((innerRect.x + innerRect.w / 2) * pixelRatio);
  const iy = Math.floor((innerRect.y + innerRect.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, ix, iy)).toEqual([0, 0, 0, 255]);

  // Sibling area inside the masked outer container should also be covered.
  // Sample 5px below the outer top edge — still inside the mask but outside
  // any nested element.
  const outerRect = await docRectOf(page, '#outer-masked');
  const ox = Math.floor((outerRect.x + 10) * pixelRatio);
  const oy = Math.floor((outerRect.y + 5) * pixelRatio);
  expect(await pixelAt(page, screenshot, ox, oy)).toEqual([0, 0, 0, 255]);
});

test('masked child of unmasked parent is masked; siblings are not', async ({ page }) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
    page,
    '/test/masking-nested.html'
  );

  const child = await docRectOf(page, '#masked-child');
  const cx = Math.floor((child.x + child.w / 2) * pixelRatio);
  const cy = Math.floor((child.y + child.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);

  const sibling = await docRectOf(page, '#visible-sibling');
  const sx = Math.floor((sibling.x + sibling.w / 2) * pixelRatio);
  const sy = Math.floor((sibling.y + sibling.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, sx, sy)).not.toEqual([0, 0, 0, 255]);
});

test('scrolled full-page capture masks an element below the initial viewport', async ({
  page,
}) => {
  // A scrolled variant of the helper — same flow, but scrolls AFTER goto so the page is
  // captured while the user is offset from the top.
  let payload: Record<string, unknown> | null = null;
  await page.route('**/api/check/**', async route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    })
  );
  await page.route('**/feedback', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
    });
  });

  // Inject a tall spacer + a masked target below the fold AT page load.
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const spacer = document.createElement('div');
      spacer.style.height = '2000px';
      spacer.id = 'spacer';
      const target = document.createElement('div');
      target.id = 'below-fold-mask';
      target.setAttribute('data-bugdrop-mask', '');
      target.style.cssText = 'width: 200px; height: 100px; background: #ccc;';
      target.textContent = 'sensitive';
      document.body.append(spacer, target);
    });
  });

  await page.goto('/test/masking-basic.html');
  await page.evaluate(() => window.scrollTo(0, 1500));

  const host = page.locator('#bugdrop-host');
  await host.locator('css=.bd-trigger').click();
  await host.locator('css=[data-action="continue"]').click();
  await host.locator('css=#title').fill('Scroll mask');
  await host.locator('css=#submit-btn').click();
  await host.locator('css=[data-action="capture"]').click();
  await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
  await host.locator('css=[data-action="annotate-done"]').click();
  await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

  if (!payload) throw new Error('no payload');
  const pr = await page.evaluate(() => window.devicePixelRatio || 1);
  const screenshot = payload.screenshot as string;

  const rect = await docRectOf(page, '#below-fold-mask');
  const cx = Math.floor((rect.x + rect.w / 2) * pr);
  const cy = Math.floor((rect.y + rect.h / 2) * pr);
  expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
});
```

- [ ] **Step 2: Run the new tests**

```bash
npm run test:e2e -- --grep "Screenshot Masking"
```

Expected: 6 tests pass (3 from Task 9 + 3 here).

- [ ] **Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: e2e coverage for mask inheritance and scrolled capture"
```

---

## Task 11: E2E — element-scoped capture (3 cases)

**Files:**
- Modify: `e2e/widget.spec.ts`

Element-scoped capture goes through the element-picker flow. Three sub-cases: (a) descendant of picked element is masked; (b) picked element itself has `data-bugdrop-mask`; (c) picked element is a password input.

- [ ] **Step 1: Append an element-scoped helper and three tests inside the same describe block**

After the tests from Task 10 (still inside the describe block), append:

```ts
async function submitFeedbackWithElementCapture(
  page: Page,
  fixturePath: string,
  selector: string
): Promise<{ screenshot: string; pixelRatio: number }> {
  let payload: Record<string, unknown> | null = null;
  await page.route('**/api/check/**', async route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    })
  );
  await page.route('**/feedback', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
    });
  });

  await page.goto(fixturePath);
  const host = page.locator('#bugdrop-host');

  await host.locator('css=.bd-trigger').waitFor();
  await host.locator('css=.bd-trigger').click();
  await host.locator('css=[data-action="continue"]').click();
  await host.locator('css=#title').fill('Element scope test');
  await host.locator('css=#submit-btn').click();

  // Choose "Select Element".
  await host.locator('css=[data-action="element"]').click();

  // Click the target element on the page (NOT inside the shadow root).
  await page.locator(selector).click();

  // Wait for annotation step.
  await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
  await host.locator('css=[data-action="annotate-done"]').click();
  await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

  if (!payload) throw new Error('no payload captured');
  const pr = await page.evaluate(() => window.devicePixelRatio || 1);
  return { screenshot: payload.screenshot as string, pixelRatio: pr };
}

test('element-scoped capture masks descendant inside picked element', async ({ page }) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithElementCapture(
    page,
    '/test/masking-nested.html',
    '#unmasked-parent'
  );

  // Cropped image is the picked element only — coordinates are local to its bounds.
  const childLocal = await page.evaluate(() => {
    const parent = document.querySelector('#unmasked-parent') as HTMLElement;
    const child = document.querySelector('#masked-child') as HTMLElement;
    const p = parent.getBoundingClientRect();
    const c = child.getBoundingClientRect();
    return { x: c.left - p.left, y: c.top - p.top, w: c.width, h: c.height };
  });

  const cx = Math.floor((childLocal.x + childLocal.w / 2) * pixelRatio);
  const cy = Math.floor((childLocal.y + childLocal.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
});

test('element-scoped capture masks the picked element itself', async ({ page }) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithElementCapture(
    page,
    '/test/masking-nested.html',
    '#outer-masked'
  );

  const size = await page.evaluate(() => {
    const el = document.querySelector('#outer-masked') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const cx = Math.floor((size.w / 2) * pixelRatio);
  const cy = Math.floor((size.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
});

test('element-scoped capture masks a picked password input', async ({ page }) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithElementCapture(
    page,
    '/test/masking-basic.html',
    '#password'
  );

  const size = await page.evaluate(() => {
    const el = document.querySelector('#password') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  const cx = Math.floor((size.w / 2) * pixelRatio);
  const cy = Math.floor((size.h / 2) * pixelRatio);
  expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
});
```

- [ ] **Step 2: Run the new tests**

```bash
npm run test:e2e -- --grep "Screenshot Masking"
```

Expected: 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: e2e coverage for element-scoped masking captures"
```

---

## Task 12: E2E — area-cropped capture and clean-baseline regression guard

**Files:**
- Modify: `e2e/widget.spec.ts`

- [ ] **Step 1: Append area-cropped and no-op tests inside the same describe block**

After the tests from Task 11, append:

```ts
test('area-cropped capture preserves masks inside the selected region', async ({ page }) => {
  let payload: Record<string, unknown> | null = null;
  await page.route('**/api/check/**', async route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    })
  );
  await page.route('**/feedback', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
    });
  });

  await page.goto('/test/masking-basic.html');
  const host = page.locator('#bugdrop-host');

  await host.locator('css=.bd-trigger').click();
  await host.locator('css=[data-action="continue"]').click();
  await host.locator('css=#title').fill('Area test');
  await host.locator('css=#submit-btn').click();
  await host.locator('css=[data-action="area"]').click();

  // Drag a rectangle around the customer panel.
  const rect = await docRectOf(page, '#customer-panel');
  const startX = rect.x - 10;
  const startY = rect.y - 10;
  const endX = rect.x + rect.w + 10;
  const endY = rect.y + rect.h + 10;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();

  await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
  await host.locator('css=[data-action="annotate-done"]').click();
  await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

  if (!payload) throw new Error('no payload');
  const pr = await page.evaluate(() => window.devicePixelRatio || 1);

  // The cropped image's geometric center should land inside the masked panel.
  const cropW = endX - startX;
  const cropH = endY - startY;
  const cx = Math.floor((cropW / 2) * pr);
  const cy = Math.floor((cropH / 2) * pr);
  expect(await pixelAt(page, payload.screenshot as string, cx, cy)).toEqual([0, 0, 0, 255]);
});

test('clean baseline: page with no masked elements has no opaque-black sample at unrelated points', async ({
  page,
}) => {
  const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(page, '/test/');

  // Sample a handful of points; none should be exactly [0,0,0,255]. The standard fixture
  // contains no masking attributes, so any solid-black 1px sample at these coordinates
  // would be a regression.
  const samplePoints: Array<[number, number]> = [
    [10, 10],
    [50, 50],
    [200, 100],
  ];

  for (const [x, y] of samplePoints) {
    const px = await pixelAt(
      page,
      screenshot,
      Math.floor(x * pixelRatio),
      Math.floor(y * pixelRatio)
    );
    expect(px).not.toEqual([0, 0, 0, 255]);
  }
});
```

- [ ] **Step 2: Run the new tests**

```bash
npm run test:e2e -- --grep "Screenshot Masking"
```

Expected: 11 tests pass total.

- [ ] **Step 3: Commit**

```bash
git add e2e/widget.spec.ts
git commit -m "test: e2e coverage for area-cropped masking and clean-baseline regression"
```

---

## Task 13: Documentation — security.mdx, installation.mdx, README.md

**Files:**
- Modify: `docs/website/security.mdx`
- Modify: `docs/website/installation.mdx`
- Modify: `README.md`

- [ ] **Step 1: Add a "Screenshot masking" subsection to `docs/website/security.mdx`**

Insert the following block AFTER the existing `## Privacy` bullet list (immediately before the line that begins `The only network requests BugDrop makes are:`):

````mdx
### Screenshot masking

You can mark sensitive elements so they never appear in submitted screenshots. Add the
`data-bugdrop-mask` attribute to any element you want covered:

```html
<input type="email" data-bugdrop-mask />

<div data-bugdrop-mask>
  <span>Customer name</span>
  <span>customer@example.com</span>
</div>
```

When a user submits feedback, BugDrop paints an opaque rectangle over each tagged
element's bounding box on the captured PNG before showing the user the annotator
preview. The user sees what is masked and can audit it before submitting.

**Inheritance.** When an ancestor has `data-bugdrop-mask`, the entire ancestor box is
masked as a single rectangle. Descendants do not get individual rectangles — this
prevents gaps from CSS `gap` or non-masked siblings inside a masked container.

**Built-in defaults.** These are always masked, with or without an explicit attribute:

- `input[type="password"]`
- Any input with `autocomplete="cc-number"`, `cc-csc`, or `cc-exp"`

**Known limitations:**

- Elements inside Shadow DOM and cross-origin iframes are not traversed in this
  iteration.
- Mask rectangles are collected at the start of capture. If the page reflows or reveals
  sensitive elements between collection and the moment `html-to-image` finishes
  rendering, the mask may not cover the final pixels. Keep masked content stable during
  the brief capture window.
````

- [ ] **Step 2: Add a "Protecting sensitive data" section to `docs/website/installation.mdx`**

Insert AFTER the script-tag attribute documentation (find the section listing
`data-theme`, `data-position`, etc.) and BEFORE the next major heading:

````mdx
## Protecting sensitive data

If your page renders customer data, billing details, or any other content you do not
want to appear in submitted screenshots, mark those elements with `data-bugdrop-mask`:

```html
<div class="customer-row" data-bugdrop-mask>
  Jane Doe — jane@acme.com
</div>
```

BugDrop covers each marked element with an opaque rectangle on the captured screenshot.
Password inputs and credit-card autocomplete fields are masked automatically. See
[Screenshot masking](/security#screenshot-masking) on the Security page for details.
````

- [ ] **Step 3: Add a one-paragraph mention to `README.md`**

Find the existing feature bullet list near the top of `README.md`. Add this bullet:

```md
- 🔒 **Privacy masking** — tag sensitive elements with `data-bugdrop-mask` and BugDrop covers them in the screenshot before it's submitted. Passwords and credit-card inputs are masked automatically.
```

- [ ] **Step 4: Verify the build still passes**

```bash
npm run build
```

Expected: TypeScript build succeeds. (Website MDX is rendered separately and not part of the TS build.)

- [ ] **Step 5: Commit**

```bash
git add docs/website/security.mdx docs/website/installation.mdx README.md
git commit -m "docs: document screenshot privacy masking feature"
```

---

## Final Verification

After all tasks complete, run the full test suite:

```bash
npm test           # Unit + integration: ~141 tests (was 116)
npm run build:widget
npm run test:e2e   # E2E: existing tests + 11 new Screenshot Masking tests
npm run lint       # ESLint
```

All green → push branch and open PR per `CLAUDE.md` PR review gate (run the 6 pr-review-toolkit agents in parallel before creating the PR).

---

## Self-Review Checklist

- **Spec coverage:**
  - Per-element `data-bugdrop-mask` attribute → Tasks 2, 4
  - Built-in defaults (password + cc-*) → Task 3
  - Inheritance (top-most ancestor rule) → Task 4
  - Solid black fill → Task 6
  - Document coordinates / scroll handling → Task 5, Task 10
  - All three capture modes (full / element / area) → Tasks 9, 11, 12
  - Fail-closed error handling → Task 6 (image-load reject), Task 7 (timeout finally clears)
  - No new public API or script-tag attribute → Task 7 leaves index.ts untouched
  - Docs (security/install/README) → Task 13
- **Type consistency:** `MaskRect` defined in Task 1, used unchanged in Tasks 4, 5, 6, 7. Function signatures (`collectMaskRects`, `applyMaskToImage`, `translateMaskRect`) match between definition and call sites.
- **No placeholders:** every step contains the full code or command to run.
