# Custom Area Screenshot Capture

**Issue:** #59
**Date:** 2026-04-06

## Problem

The widget only supports full-page and single-element screenshot capture. Users need the
ability to drag-select a custom rectangular area of the page — like macOS `Cmd+Shift+4` —
to capture exactly what they want to include in their feedback.

## Approach

Create a new `area-picker.ts` module (following the `picker.ts` pattern) that handles the
drag-to-select interaction. The main flow captures a full-page screenshot behind the scenes,
then crops it to the selected rectangle using an offscreen canvas.

## New Module: `src/widget/area-picker.ts`

Exports: `createAreaPicker(style?: PickerStyle): Promise<DOMRect | null>`

**Interaction:**
1. Dims the entire page with a semi-transparent dark overlay (z-index: 2147483646, matching
   element picker)
2. Tooltip at top center: "Drag to select an area (ESC to cancel)" (styled to match element
   picker tooltip)
3. Crosshair cursor on the overlay
4. Mousedown records start point
5. Mousemove while dragging renders a "clear window" — the dimming overlay gets a CSS
   `clip-path` that cuts out the selected rectangle, so the page content shows through.
   A teal border (using `accentColor` from style config) outlines the selection.
6. Mouseup: if selection >= 10x10px, resolve with `DOMRect`; otherwise reset and let user
   retry (stay in selection mode)
7. ESC at any point cancels and resolves with `null`
8. Cleanup removes all overlay elements and restores event listeners

**Style inputs:** Uses the same `PickerStyle` interface from `picker.ts` for accent color,
font, radius, border width, and theme.

## Crop Utility

A helper function in `src/widget/screenshot.ts`:

```
cropScreenshot(imageDataUrl: string, rect: DOMRect, pixelRatio: number): Promise<string>
```

- Creates an offscreen canvas
- Draws the full-page image
- Uses `drawImage` source coordinates (scaled by `pixelRatio`) to extract the selected region
- Returns cropped base64 PNG data URL

The `pixelRatio` parameter accounts for the fact that `html-to-image` captures at device
pixel ratio — a 100x100 viewport rect becomes 200x200 pixels at 2x DPR.

## Screenshot Options Modal Update

`showScreenshotOptions` in `src/widget/index.ts`:

- Return type: `'skip' | 'capture' | 'element' | 'area'`
- New button: `<button class="bd-btn bd-btn-secondary" data-action="area">Select Area</button>`
- Button order: Skip Screenshot | Select Element | Select Area | **Full Page** (primary)

## Main Flow Integration

In the screenshot flow (inside `startFeedbackFlow`):

```
} else if (screenshotChoice === 'area') {
  const rect = await createAreaPicker({ ...styleConfig });
  if (rect) {
    const fullPage = await captureWithLoading(root, undefined, config.screenshotScale);
    if (fullPage) {
      screenshot = await cropScreenshot(fullPage, rect, pixelRatio);
    }
  }
}
```

The `pixelRatio` used for cropping must match what `captureScreenshot` used. Extract the
existing pixelRatio logic from `captureScreenshot` into an exported helper
`getPixelRatio(isFullPage: boolean, screenshotScale?: number): number` so both the capture
and crop code use the same calculation. For full-page captures on complex DOMs (>3000 nodes)
it returns 1; otherwise `Math.max(devicePixelRatio, screenshotScale ?? 2)`.

After cropping, the result flows into the existing annotation step unchanged.

## Files Changed

- **Create:** `src/widget/area-picker.ts` — drag-to-select area picker
- **Modify:** `src/widget/screenshot.ts` — add `cropScreenshot` helper, export `pixelRatio`
  computation for reuse
- **Modify:** `src/widget/index.ts` — add 'area' option to screenshot modal, integrate area
  picker + crop into main flow
- **Modify:** `src/widget/ui.ts` — no changes expected (modal creation unchanged)

## Testing

- **Unit test** (`test/cropScreenshot.test.ts`): verify crop utility produces correct
  dimensions given a known image, rect, and pixelRatio
- **E2E test** (`e2e/widget.spec.ts`): verify "Select Area" button appears in screenshot
  options, clicking it launches the area picker overlay (dimmed overlay + tooltip visible),
  pressing ESC cancels and returns to flow
- **Manual test**: full drag-select flow on localhost:8787/test/
