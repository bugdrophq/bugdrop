# Original two-button publication flow: design reference

Captured November 3, 2026 from Bleep commit `73fc4636ffdb237c9c7579baf2edf6c4808cd025`
at `/dev/bugdrop-feedback?preview=sharing`, using its earlier pinned BugDrop candidate.
These screenshots specify the requested interaction. They record the earlier
Bleep preview; current SDK support is established by the acceptance checks in the
PR description. No application source was changed for
this capture. Both submissions used the development-only simulated endpoint;
no GitHub Issues were created. The quote and account name are synthetic.

The required interaction is:

1. Collect a rating and optional comment. Ratings below five submit without a sharing screen.
2. For five stars with no comment, offer an optional quote (minimum five characters when provided).
   If a comment was entered, skip this extra quote screen and reuse the comment.
3. Show the quote and editable account-name credit, with blank meaning Anonymous.
   **Yes, you can share this** and **Keep my feedback private** each set distinct
   permission metadata and submit the feedback in one action, creating one Issue.
   There is no permission radio group or additional Submit button.
4. Show the acknowledgement. Permission covers the Bleep website only; an empty
   quote cannot authorize publishing a testimonial. Publication remains manual.

PR #463 implements that interaction with bounded final-submit actions and a plain-text
quote preview. The gallery remains the original Bleep capture, not a fresh capture
of the current SDK. See the PR description for SDK acceptance evidence. Conditional
Issue sections remain omitted.

## Desktop

Captured in real Chrome at a verified 1721 × 907 CSS-pixel viewport. Each image
is cropped around the actual dialog with a small amount of surrounding context.

| Rating | Optional quote |
| --- | --- |
| ![Five-star rating](desktop-1-rating.jpg) | ![Optional quote](desktop-2-quote.jpg) |

| Permission and editable credit | Confirmation |
| --- | --- |
| ![Two permission buttons](desktop-3-permission.jpg) | ![Confirmation after Yes](desktop-4-confirmation.jpg) |

## Mobile responsive viewport

Captured using the in-app browser viewport override at a verified **393 × 852 CSS
pixels**, without horizontal document overflow. This is responsive viewport
coverage, not real iPhone or Safari emulation. All controls fit in the permission
screen. Desktop exercised Yes; mobile exercised Keep my feedback private. Both
reached the simulated confirmation.

| Rating | Optional quote |
| --- | --- |
| ![Mobile rating](mobile-1-rating.jpg) | ![Mobile quote](mobile-2-quote.jpg) |

| Permission and editable credit | Confirmation |
| --- | --- |
| ![Mobile two permission buttons](mobile-3-permission.jpg) | ![Confirmation after Keep private](mobile-4-confirmation.jpg) |

The captured confirmation retains the existing privacy sentence. These images
record the current original preview and do not silently revise its copy.

## Current SDK verification

These additional captures use the rebuilt SDK and executable recipe from this PR.
Desktop Chrome exercised the optional-quote route and Yes; the in-app browser at
393 × 852 exercised comment reuse and Keep private. The visible local request
payloads each contained one request with the matching boolean permission and
website channel. Both captures use synthetic data and the existing local-only
submission interceptor, with no GitHub Issue creation.

| Current SDK desktop | Current SDK responsive mobile |
| --- | --- |
| ![Current SDK desktop](current-sdk-desktop.jpg) | ![Current SDK mobile](current-sdk-mobile.jpg) |
