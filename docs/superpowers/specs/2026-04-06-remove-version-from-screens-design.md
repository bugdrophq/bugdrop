# Remove Version Number from Non-Essential Screens

**Issue:** #61
**Date:** 2026-04-06

## Problem

The widget version number (`BugDrop vX.Y.Z`) currently appears on every modal screen.
It should only appear on the welcome, success, and error screens — not on workflow
screens like the feedback form, screenshot options, loading spinners, or annotation view.

## Approach

Add an optional `showVersion` boolean parameter (default `false`) to `createModal()`.
When `true`, the version `<div>` is rendered. When `false`, it is omitted entirely.

## Screens That Keep the Version (`showVersion: true`)

| Screen               | Function                  | Title                            |
|----------------------|---------------------------|----------------------------------|
| Welcome              | `showWelcomeScreen`       | "Share Your Feedback"            |
| Success              | `showSuccessModal`        | "Feedback Submitted!"            |
| Capture Failed       | inside `captureWithLoading` | "Capture Failed"               |
| Install/Connection   | `showInstallPrompt`       | "Install Required" / "Connection Error" |
| Submission Failed    | `showSubmitError`         | "Submission Failed"              |

## Screens That Lose the Version (default `false`)

| Screen               | Function                              | Title                |
|----------------------|---------------------------------------|----------------------|
| Feedback Form        | `showFeedbackFormWithScreenshotOption` | "Send Feedback"      |
| Screenshot Options   | `showScreenshotOptions`               | "Capture Screenshot" |
| Capturing (loading)  | `captureWithLoading`                  | "Capturing..."       |
| Annotate Screenshot  | `showAnnotationStep`                  | "Annotate Screenshot"|
| Submitting (loading) | `submitFeedback`                      | "Submitting..."      |

## Files Changed

- `src/widget/ui.ts` — Add `showVersion` param to `createModal`, pass `true` in `showSuccessModal`
- `src/widget/index.ts` — Pass `true` at welcome, error, and install prompt call sites

## Testing

- Unit: verify `createModal` renders version when `showVersion: true`, omits when `false`
- E2E: check version visible on welcome/success, absent on form/annotation screens
