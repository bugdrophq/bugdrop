# BugDrop Styling Validation — Design Spec

## Problem

BugDrop now has 9+ styling attributes (`data-font`, `data-radius`, `data-bg`, `data-text`, `data-color`, `data-border-width`, `data-border-color`, `data-shadow`, `data-label`, `data-icon`). Users need confidence that their configuration looks correct across all wizard screens before shipping, and a way to catch regressions if their app's design changes.

## Constraints

- No bugdrop-hosted validation services — users won't send config data to our servers
- No extra npm packages — bugdrop is a single script tag and should stay lightweight
- Validation runs in the user's own CI pipeline against their own app

## Design

### Part 1: Full Style Customization Coverage (Code Changes)

**Already done:**
- Trigger button: font, radius, bg, accent color, border, shadow, label, icon
- All modal screens (welcome, form, screenshot options, annotation, success): inherit CSS variables for bg, text, border, radius, shadow
- Category selector radio buttons: use `var(--bd-border-style)` and `var(--bd-radius-sm)`
- Element picker: accent color, font, radius, border width passed from config

**Fixed in this round:**
- Element picker tooltip: bg, text, and border colors now use config values instead of hardcoded `#0f172a`/`#f1f5f9`/`#334155`
- Annotator drawing color: uses accent color instead of hardcoded `#ff0000`
- Picker tooltip border width: uses config border width

**Remaining hardcoded values (intentional):**
- Fallback defaults in `ui.ts` (light: `#fafaf9`, dark: `#0f172a`) — only used when user doesn't provide overrides
- Shadow preset fallback colors — structural defaults, not user-facing

### Part 2: README "Testing Your Configuration" Section

Add a new section to the README with a copy-paste Playwright test snippet. The test covers three layers:

#### Layer 1: Functional (widget renders, screens open)
```
- Widget host element exists in DOM
- Trigger button is visible and clickable
- Clicking trigger opens the modal
- All wizard screens are navigable (welcome → form → screenshot → annotate → success)
```

#### Layer 2: Accessibility (contrast, readability)
```
- Text-on-background contrast ratio >= 4.5:1 (WCAG AA)
- Button text contrast ratio >= 4.5:1
- Input text is readable against input background
- Focus states are visible
```

#### Layer 3: Config Verification (values match intent)
```
- Computed accent color matches data-color
- Computed border-radius matches data-radius
- Computed font-family matches data-font (or 'inherit')
- Computed background color matches data-bg
- Computed border-width matches data-border-width (if set)
```

#### Test Structure

The snippet is a single Playwright test file that users copy into their project. They fill in:
1. The URL of their app where bugdrop is installed
2. Their expected config values (accent color, bg, radius, etc.)

The test:
1. Navigates to the user's app
2. Locates the `#bugdrop-host` shadow DOM
3. Pierces the shadow root to read computed styles
4. Asserts contrast ratios using a bundled helper function
5. Asserts config values match expected

#### Contrast Calculation

Include a self-contained `getContrastRatio(color1, color2)` function in the test snippet so users don't need any extra dependencies. Uses the WCAG relative luminance formula.

### What This Does NOT Include

- No hosted validation page
- No npm package
- No visual snapshot testing
- No bugdrop CLI tool
- No runtime console warnings (could be a future enhancement)

## Files to Change

1. `src/widget/picker.ts` — tooltip uses config colors (done)
2. `src/widget/annotator.ts` — drawing color uses accent (done)
3. `src/widget/index.ts` — passes config to picker and annotator (done)
4. `README.md` — add "Testing Your Configuration" section with Playwright snippet
