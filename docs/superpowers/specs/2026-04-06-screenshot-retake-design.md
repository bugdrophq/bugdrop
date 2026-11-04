# Screenshot Retake

**Issue:** #58
**Date:** 2026-04-06

## Problem

After capturing a screenshot (full page, element, or area), the user goes directly to the
annotation step with no way to go back and retake. If the screenshot didn't capture what
they wanted, they're stuck with it.

## Approach

Add a "Retake" button to the annotation step that loops the user back to the screenshot
options modal. Wrap the screenshot capture + annotation steps in a `while` loop so the
user can retry as many times as needed before proceeding to submit.

## Annotation Step Changes

`showAnnotationStep` in `src/widget/index.ts`:

- Return type changes from `Promise<string>` to `Promise<string | 'retake'>`
- Add a "Retake" button (secondary) to the actions div
- Button order: **Retake** | Skip Annotations | **Done** (primary)
- Retake handler: destroys annotator, removes modal, resolves with `'retake'`
- Skip Annotations and Done handlers are unchanged

## Main Flow Changes

In `startFeedbackFlow`, wrap the screenshot flow (from `showScreenshotOptions` through
`showAnnotationStep`) in a `while` loop:

```
let retake = true;
while (retake) {
  retake = false;
  const screenshotChoice = await showScreenshotOptions(root);
  // ... existing capture logic for 'capture', 'element', 'area' ...
  if (screenshot) {
    const result = await showAnnotationStep(root, screenshot, config);
    if (result === 'retake') {
      screenshot = null;
      elementSelector = null;
      retake = true;
    } else {
      screenshot = result;
    }
  }
}
```

When retake is true, the loop runs again — showing the screenshot options modal from the
start. The user can pick any capture method (same or different). `screenshot` and
`elementSelector` are reset to null so a fresh capture replaces the previous one.

## Files Changed

- **Modify:** `src/widget/index.ts` — add Retake button to `showAnnotationStep`, wrap
  screenshot flow in while loop in `startFeedbackFlow`

## Testing

- **E2E test** (`e2e/widget.spec.ts`): navigate to annotation step, click Retake, verify
  screenshot options modal reappears with all 4 buttons
- Existing tests pass unchanged (Skip/Done paths unaffected)
