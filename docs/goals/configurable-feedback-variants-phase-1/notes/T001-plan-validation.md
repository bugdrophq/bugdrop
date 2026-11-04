# T001 — Phase 1 plan validation

## Decision

Approve the four-package sequence with one correction: the first compatibility package must call
the old artifact a **tag-reconstructed immutable bundle**, not an exact copy of previously deployed
bytes. Production currently serves `widget.v1.53.1.js` and `widget.v1.js`, while
`widget.v1.1.0.js` returns 404. Generated widget files are ignored by git, and clean release builds
produce only the current version aliases.

## Evidence

- `v1.1.0` resolves to commit `5ec3aead9d49a9a9573c25ccdff86aada15cadc9`.
- `v1.53.1` resolves to commit `5cf06f4ec3eab7cc7a507fc4c4d082a84e279539`.
- Both tags contain `package-lock.json`, `scripts/build-widget.js`, and `src/widget/index.ts`, so a
  provenance-recorded reconstruction is possible from repository history without new storage.
- `.gitignore` excludes `public/widget.js`, `public/widget.v*.js`, and `public/versions.json`; none is
  a historical fixture.
- Live readback on 2026-08-02 returned `404` for `widget.v1.1.0.js` and `200` with 148,406 bytes for
  both `widget.v1.53.1.js` and `widget.v1.js`.
- The current compatibility seams are `window.BugDrop` and `bugdrop:ready` in
  `src/widget/index.ts`, `submitFeedback()` in that file, and the legacy `/feedback` handler plus
  `formatIssueBody()` in `src/routes/api.ts`.

## First Worker package

Freeze compatibility before production behavior changes:

1. Reconstruct immutable v1.1.0 and v1.53.1 bundles from their tag commits and lockfiles in an
   isolated temporary checkout; store provenance and SHA-256 values.
2. Add legacy API/bootstrap tests for ignored arguments, detached calls, exact ready-event
   semantics, and no variant-only work.
3. Add normalized legacy request/response/createIssue title-body-label goldens, including a
   screenshot-free flow and an evidence-bearing API fixture.
4. Exercise the tag-reconstructed v1.1.0 bundle against the candidate local Worker.
5. Record the v1.53.1 minified/gzip size baseline used by the 25% budget.

The package must not fix production asset retention, alter legacy behavior, or regenerate baselines
from changed Phase 1 code.

## Deferred compatibility defect

The exact-version retention mismatch is real but predates this feature. Repairing release artifact
retention is a separate product/release task because it changes deployment artifact policy and must
recover or explicitly redefine historical availability. Phase 1 still proves candidate-Worker
compatibility with provenance-recorded tag reconstructions. Do not claim that reconstructed bytes
are the exact bytes historically deployed.
