# Screenshot Privacy Masking

**Date:** 2026-05-10

## Problem

Screenshots captured by BugDrop currently include whatever is rendered on the page —
passwords, customer emails, billing details, and any other sensitive content. Site owners
have no way to mark elements as confidential before the screenshot is generated, which
makes BugDrop unsuitable for SaaS apps where screenshots will routinely capture
end-customer data.

This is a privacy primitive: the goal is for site owners to declare sensitive regions
once in their markup and trust that those regions will never appear in a captured
screenshot, regardless of which user submits feedback or how the screenshot is taken
(full page, picked element, or area crop).

## Scope

**In scope (this spec):**
- Developer-configured masking via per-element HTML attribute
- Built-in defaults for unambiguously sensitive inputs (`type="password"`, credit-card
  autocomplete fields)
- Solid-block visual style applied client-side before the annotator opens
- Coverage of all three capture modes: full page, element-scoped, area-cropped

**Out of scope (deliberately deferred):**
- End-user redaction tool inside the annotator (planned as a follow-up layer)
- Global selector list via script-tag attribute (`data-mask-selectors=`)
- Aggressive auto-detection (regex-based PII matching in textContent)
- Shadow DOM and iframe content (documented as known limitations)

## Approach

Capture proceeds normally; masking is applied as a post-processing canvas pass on the
resulting PNG. This avoids any DOM mutation (no flicker, no failure-mode where capture
throws and the page is left visibly broken) and reuses the same canvas-blit pattern
already established by `cropScreenshot` in `src/widget/screenshot.ts`.

The pipeline for every capture mode is:

1. Walk the DOM rooted at the capture target, collect document-coordinate rectangles
   for top-most masked ancestors and built-in defaults.
2. Run `html-to-image` unchanged.
3. Load the resulting PNG into an offscreen canvas, paint opaque rectangles over the
   collected coordinates (translated to image space by `pixelRatio` and any document
   origin offset), export as PNG.
4. Pass the masked PNG into the existing annotator unchanged.

For the area-cropped mode, masks are baked into the full-page PNG before the existing
crop step runs, so the cropped output inherits the masks with no additional logic.

## Public API

### HTML Attribute

```html
<input type="email" data-bugdrop-mask />

<div data-bugdrop-mask>
  <span>Jane Doe</span>
  <span>jane@acme.com</span>
</div>
```

### Inheritance Rule

When an ancestor has `data-bugdrop-mask`, a single rectangle is collected for the
ancestor's bounding box. The walker does not descend further into masked subtrees.
This avoids gaps from CSS `gap`, `margin`, or non-masked siblings inside a masked
container — the kind of leakage that would defeat the purpose of a privacy primitive.

Selector for collection: top-most masked ancestors plus built-in defaults that are not
themselves inside a masked ancestor.

### Built-in Defaults

These are always masked, with or without an explicit attribute:

- `input[type="password"]`
- `input[autocomplete*="cc-number"]`
- `input[autocomplete*="cc-csc"]`
- `input[autocomplete*="cc-exp"]`

Defaults are folded into the same DOM walk as the explicit-attribute logic — there is
no separate code path.

### Visual Style

Masked regions are rendered as opaque black rectangles (`#000`, alpha 1.0) at the
element's bounding rectangle. No label, no blur, no transparency — chosen for
unambiguity and to eliminate any risk of partial leakage from low-radius blur.

### No New JS API or Script-Tag Attribute

The widget's `window.BugDrop` interface is unchanged. No new `data-*` attribute is
added to the loader script. Privacy is automatic when the markup is tagged.

## New Module: `src/widget/mask.ts`

Exports two pure functions:

```ts
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function collectMaskRects(root: Element): MaskRect[];

export function applyMaskToImage(
  dataUrl: string,
  rects: MaskRect[],
  pixelRatio: number,
  originOffset?: { x: number; y: number }
): Promise<string>;
```

`collectMaskRects` returns document-coordinate rectangles for:
- `root` itself if it matches `[data-bugdrop-mask]`, `input[type="password"]`, or a
  credit-card autocomplete default
- Top-most descendants of `root` matching `[data-bugdrop-mask]`
- `input[type="password"]` and credit-card autocomplete inputs not inside a masked
  ancestor

It skips elements with zero `getBoundingClientRect()` (not rendered, detached). It
does *not* skip elements with `visibility: hidden` or `opacity: 0`: both still occupy
layout, both could become visible mid-capture, and painting an extra black rectangle
over empty space costs nothing. This errs on the side of fail-closed.

Document coordinates are derived from `getBoundingClientRect()` plus `window.scrollX` /
`window.scrollY`. This keeps full-page and area-crop math aligned with the existing
area picker, which returns document coordinates for the selected rectangle.

`applyMaskToImage`:
- Creates an offscreen `<canvas>` matching the image's natural dimensions
- Draws the source image
- For each rect, paints `(rectX − originOffset.x) * pixelRatio,
  (rectY − originOffset.y) * pixelRatio, rectW * pixelRatio, rectH * pixelRatio`
  in opaque black
- Clips rects that fall partly outside the canvas to its bounds
- Exports as PNG via `canvas.toDataURL('image/png')`
- Empty rects array short-circuits and returns the input data URL unchanged

## Modified Module: `src/widget/screenshot.ts`

`captureScreenshot(element?, screenshotScale?)` retains its existing signature. Inside,
after `toPng` resolves, the function:

1. Calls `collectMaskRects(element ?? document.body)` to gather rects scoped to the
   capture target
2. Computes `originOffset`: `{x: 0, y: 0}` for full-page, or the picked element's
   document-coordinate origin for element-scoped captures:
   `{ x: rect.left + window.scrollX, y: rect.top + window.scrollY }`
3. Calls `applyMaskToImage(pngDataUrl, rects, pixelRatio, originOffset)` and returns
   its result

`getPixelRatio` and `cropScreenshot` are unchanged.

## Modified Module: `src/widget/index.ts`

Only the area-crop branch needs verification — the masks are baked in by
`captureScreenshot` before the crop happens, so existing logic at lines 717–734 works
unchanged. No reordering required.

## Coordinate Translation

All collected rectangles are document coordinates:

```
docX = rect.left + window.scrollX
docY = rect.top + window.scrollY
imageX = (docX − originOffset.x) * pixelRatio
imageY = (docY − originOffset.y) * pixelRatio
imageW = rect.width * pixelRatio
imageH = rect.height * pixelRatio
```

For full-page captures, `originOffset` is `{ x: 0, y: 0 }`, so masks line up with the
same document-space coordinates used by `cropScreenshot` for area selection. For
element-scoped captures, `originOffset` is the selected element's document-space
origin so descendant masks are translated into the captured element image.

Viewport-only coordinates are not sufficient: the user may be scrolled when capture
starts, and `src/widget/area-picker.ts` already returns document coordinates by adding
`window.scrollX` / `window.scrollY`.

## Error Handling

The guiding principle is **fail closed**: a screenshot that should have been masked
but was not is a privacy incident; a screenshot that did not get taken is a UX
annoyance. We always pick the second.

| Failure | Behavior |
|---|---|
| `collectMaskRects` throws | Propagate; existing capture error UI shows "screenshot failed" with retry |
| Masked element has zero `getBoundingClientRect()` (`display:none`, detached) | Skip silently (no rect emitted) |
| Masked rect overflows captured element bounds | Clip to canvas bounds (no throw) |
| `applyMaskToImage` canvas context is `null` | Throw; caught by existing capture error path |
| `applyMaskToImage` source image fails to load | Throw with message "Failed to apply privacy masks" |

There is no graceful-degradation mode that ships an unmasked screenshot when masking
fails. Developers who want that escape hatch can build it on top; the library does not
make that call for them.

## Known Limitations

- **Shadow DOM:** masked attributes inside shadow roots are not discovered by the
  document walk in this iteration.
- **Iframes:** iframe contents are not traversed, including same-origin iframes. Hosts
  should apply BugDrop masking inside those documents only after a future iframe-aware
  implementation exists.
- **DOM changes during capture:** rectangles are collected before `html-to-image`
  renders the PNG. If the page moves, resizes, expands, or reveals sensitive elements
  between rect collection and rendering, a stale mask rectangle may not cover the final
  rendered pixels. The implementation should keep the collect-to-render interval as
  small as possible, but this spec does not attempt clone-time mask discovery.

## Documentation Changes

- `docs/website/security.mdx` — new "Screenshot masking" subsection under Privacy,
  showing the attribute, inheritance rule, built-in defaults, and known limitations
  (Shadow DOM, iframes, DOM changes during capture)
- `docs/website/installation.mdx` — short "Protecting sensitive data" section with
  one code example
- `README.md` — one-paragraph mention with code example

## Testing

### Unit (Vitest, `test/mask.test.ts`)

`collectMaskRects`:
- Returns rect for `<div data-bugdrop-mask>`
- Returns parent-only rect for nested `data-bugdrop-mask` (top-most ancestor rule)
- Returns rects for descendant `data-bugdrop-mask` of an unmasked parent
- Returns rect for `<input type="password">` without explicit attribute
- Returns rects for `autocomplete="cc-number"`, `cc-csc`, `cc-exp"` inputs
- Skips elements with zero `getBoundingClientRect()`
- Includes `visibility: hidden` and `opacity: 0` elements (defense in depth)
- Returns empty array for clean DOM
- Scoped collection: `collectMaskRects(element)` returns only `element` itself and its
  descendants, never siblings or ancestors outside the capture target
- Root inclusion: `collectMaskRects(element)` returns a rect when `element` itself is
  masked or is a built-in default such as a password input
- Scrolled page coordinates: collected rects include `window.scrollX` / `window.scrollY`
  so offscreen masked elements use document coordinates

`applyMaskToImage`:
- 100×100 white PNG + rect `{x:10, y:10, w:20, h:20}` + `pixelRatio:2` produces black
  pixels in `(20,20)–(60,60)` and white pixels elsewhere (sample 4 corner pixels of
  each region)
- `originOffset` correctly subtracts before scaling
- Empty rects array returns image unchanged (sample-pixel equality)
- Out-of-bounds rect is clipped without throwing

### Integration (Vitest, extending existing patterns)

- The `__bugdropMockToPng` window hook (`screenshot.ts:33`) is used to verify
  `captureScreenshot` invokes `applyMaskToImage` after `toPng` resolves
- Verify rect collection happens on the right root for each capture mode (full body
  vs picked element)

### E2E (Playwright, `e2e/widget.spec.ts`)

A new "Screenshot Masking" describe block:

- **Default mask**: page with `<input type="password" value="hunter2">` → trigger
  feedback → submit → fetched PNG has opaque pixels at the input's bounding box
  (read rect via `page.evaluate`, then sample-pixel check)
- **Explicit mask**: page with `<div data-bugdrop-mask>SECRET</div>` → opaque region
  over the div
- **Inheritance**: `<div data-bugdrop-mask><span>nested</span></div>` → opaque region
  covers the parent's full rect including margin/padding
- **Element-scoped capture with masked descendant**: pick an outer element, verify
  the descendant's mask still appears in the cropped image at correct (translated)
  coords
- **Element-scoped capture where selected element is masked**: pick an element that
  itself has `data-bugdrop-mask`, verify the entire selected element image is masked
- **Element-scoped capture where selected element is a password input**: pick the
  password input directly, verify the captured element image is masked
- **Area-cropped capture**: select an area overlapping a masked element, verify the
  cropped image still has the mask applied
- **Scrolled full-page capture**: scroll down before capture, mask an element below the
  initial viewport, and verify the mask appears at the element's document-coordinate
  location in the full screenshot
- **Scrolled area-cropped capture**: scroll before area selection, select an area
  overlapping a masked element, and verify the cropped image contains the translated
  mask at the expected crop-local coordinates
- **No-op case**: page with no masked elements → screenshot pixel-identical to
  baseline (regression guard against accidental masking)

### Test Fixtures

- `public/test/masking-basic.html` — single masked div, password input
- `public/test/masking-nested.html` — nested masked elements, mixed siblings

These follow the existing `public/test/annotation-*.html` convention.

### Out of Test Scope

- Byte-exact pixel comparison of the PNG (use sample-region checks; `html-to-image`
  output is not byte-stable across runs)
- Shadow DOM, iframe, and mid-capture DOM-change behavior (documented as known
  limitations)
- Performance benchmarks (one extra canvas pass; add benchmarks only if it becomes
  a measurable bottleneck)

## Files Changed

- **Create:** `src/widget/mask.ts` — rect collection and image-masking logic
- **Modify:** `src/widget/screenshot.ts` — invoke mask collection + application inside
  `captureScreenshot`
- **Modify:** `docs/website/security.mdx` — Privacy subsection
- **Modify:** `docs/website/installation.mdx` — short config example
- **Modify:** `README.md` — one-paragraph mention with example
- **Create:** `test/mask.test.ts` — unit tests for both exports
- **Create:** `public/test/masking-basic.html` — E2E fixture
- **Create:** `public/test/masking-nested.html` — E2E fixture
- **Modify:** `e2e/widget.spec.ts` — Screenshot Masking describe block
