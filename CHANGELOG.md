# Changelog

All notable changes to BugDrop will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases are the canonical release record going forward. The entries below are an archived,
incomplete snapshot of early project history; they are not evidence that an artifact is currently
served. Current release notes and authenticated assets belong on the corresponding GitHub Release.

## [1.11.0] - 2026-01-30

### Added

- **Rate limiting**: API now includes rate limiting to prevent spam and protect GitHub API quotas. Limits: 10 requests per 15 minutes per IP, 50 requests per hour per repository. Returns `429 Too Many Requests` with `Retry-After` header when exceeded.

## [1.10.0] - 2026-01-30

### Added

- **Feedback categories**: Users can now select a category (Bug 🐛, Feature ✨, or Question ❓) when submitting feedback. Categories are mapped to GitHub labels (`bug`, `enhancement`, `question`) for easy triage.

## [1.9.0] - 2026-01-30

### Added

- **Automatic browser/OS detection**: The widget now automatically captures and parses browser name/version and OS name/version from the user agent string. This information is displayed in a collapsible "System Info" section on the GitHub issue for easier debugging.
- **Enhanced system metadata**: Issues now include viewport size with device pixel ratio, browser language, and cleaner formatting in a markdown table.

### Changed

- **URL privacy**: URLs are now automatically redacted to remove query parameters and hash fragments, protecting potentially sensitive data while still providing useful page context.

## [1.8.1] - 2026-01-29

### Fixed

- Fixed animation timing issue where dismiss animation could be interrupted.

## [1.8.0] - 2026-01-29

### Added

- **Directional animations for dismiss/restore**: When dismissing the feedback pill, it now smoothly slides out to the right. When restoring via the pull tab, it slides in from the right. This creates a polished, intuitive flow that matches the spatial direction of the action.

### Changed

- Dismiss animation uses `animationend` event to properly sequence DOM removal after the slide-out completes.

## [1.7.0] - 2026-01-29

### Added

- **Custom accent color**: Set `data-color="#FF6B35"` to customize the widget's accent color to match your app's design. The color is applied to the trigger button, focus rings, and other accent elements.
- **Dismiss duration**: Set `data-dismiss-duration="7"` to have the dismissed button reappear after 7 days. Without this, dismissed buttons stay hidden forever.
- **Pull tab restore**: After dismissing the button, a subtle pull tab appears on the screen edge so users can easily restore the full button. Disable with `data-show-restore="false"`.

### Changed

- `show()` API method now clears the dismissed state, allowing you to programmatically bring back a button that was dismissed by the user.
- Dismissed state now stores a timestamp instead of a boolean, enabling the new duration feature. Legacy `'true'` values are still honored for backwards compatibility.
- Non-dismissible widgets now automatically clear stale dismissed state from localStorage, ensuring the button always shows.

## [1.6.0] - 2026-01-28

### Added

- **JavaScript API**: Programmatic control via `window.BugDrop`:
  - `open()` / `close()` - Control the feedback modal
  - `hide()` / `show()` - Control the floating button visibility
  - `isOpen()` / `isButtonVisible()` - Query current state
- **API-only mode**: Set `data-button="false"` to hide the floating button and trigger feedback only via the JavaScript API
- **Ready event**: `bugdrop:ready` event fires when the API is available

### Changed

- **Feedback pill design**: The trigger button is now a pill showing "🐛 Feedback" instead of a circular icon, making it clearer what the button does.
- **Improved feedback flow**: The widget now shows a welcome screen first, explaining what the feedback tool does. Users then fill out their feedback with an optional checkbox to include a screenshot. This makes the flow more intuitive and allows text-only feedback without the screenshot step.
- **Smooth entry animations**: The feedback pill and pull tab now slide in with smooth animations when they appear.

## [1.1.0] - 2026-01-28

### Added

- **Dismissible floating button**: Users can now dismiss the feedback button by clicking an X icon that appears on hover. The preference is saved to localStorage and persists across page loads. Enable with `data-button-dismissible="true"`.
- **Versioned widget URLs**: Pin your widget to specific versions for stability:
  - `/widget.js` - Always latest (auto-updates)
  - `/widget.v1.js` - Pinned to major version 1.x
  - `/widget.v1.1.js` - Pinned to minor version 1.1.x
  - `/widget.v1.1.0.js` - Pinned to exact version
- **Historical release-based deployment**: At the time, publishing a GitHub Release triggered the then-current Cloudflare deployment process. This is not the current release procedure.
- **Versions manifest**: `/versions.json` endpoint shows available versions.

### Changed

- Build process now generates versioned widget bundles automatically.

## [1.0.0] - 2025-01-15

### Added

- Initial release of BugDrop widget.
- **Screenshot capture**: Full page or specific element screenshots.
- **Annotation tools**: Draw, arrow, and rectangle tools for highlighting issues.
- **Element picker**: Click to select specific page elements for feedback.
- **GitHub integration**: Automatic issue creation via GitHub App.
- **Theme support**: Light, dark, and auto (system preference) themes.
- **Position options**: Bottom-right or bottom-left button placement.
- **Submitter info**: Optional name and email collection (`data-show-name`, `data-require-name`, `data-show-email`, `data-require-email`).
- **Shadow DOM isolation**: Widget styles don't conflict with host page.
- **Private repo support**: Works with both public and private repositories.

---

## Version Pinning Guide

### When to use each version type

| Version | Example             | Use Case                                        |
| ------- | ------------------- | ----------------------------------------------- |
| Latest  | `/widget.js`        | Development, always want newest features        |
| Major   | `/widget.v1.js`     | Production - get bug fixes, no breaking changes |
| Minor   | `/widget.v1.1.js`   | Production - only patch updates                 |
| Exact   | `/widget.v1.1.0.js` | Strict control, manual updates only             |

### Recommended for Production

```html
<!-- Recommended: Pin to major version for stability + bug fixes -->
<script src="https://bugdrop.neonwatty.workers.dev/widget.v1.js" data-repo="owner/repo"></script>
```

### Breaking Changes Policy

- **Major versions** (v1 → v2): May include breaking changes to configuration or behavior
- **Minor versions** (v1.0 → v1.1): New features, backwards compatible
- **Patch versions** (v1.0.0 → v1.0.1): Bug fixes only

[Unreleased]: https://github.com/bugdrophq/bugdrop/compare/v1.11.0...HEAD
[1.11.0]: https://github.com/bugdrophq/bugdrop/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/bugdrophq/bugdrop/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/bugdrophq/bugdrop/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/bugdrophq/bugdrop/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/bugdrophq/bugdrop/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/bugdrophq/bugdrop/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/bugdrophq/bugdrop/compare/v1.1.0...v1.6.0
[1.1.0]: https://github.com/bugdrophq/bugdrop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/bugdrophq/bugdrop/releases/tag/v1.0.0
