# T005 pre-canary audit

Decision: approved for one bounded structured-canary replacement package.

## Evidence

- The legacy discriminator remains the default; only the exact
  `kind: bugdrop.variant-submission` enters the isolated handler, and unrelated legacy
  `schemaVersion` payloads remain accepted.
- Structured tests reject unsupported versions, raw labels, `labelSet`, evidence, unknown policy
  fields, duplicate headings, nested values, invalid metadata, and oversized payloads before any
  GitHub call. Existing auth and both rate-limit middleware layers remain shared.
- `VARIANT_LABELS` is read only from Worker environment state. Missing/invalid mappings fall back to
  classification labels plus `bugdrop`; custom-label rejection retries defaults.
- The sidecar manager is created inside `registerVariant()`. Code inspection and browser tests show
  no variant DOM or storage before registration, no rendered UI after headless registration, and no
  mutation leak from the caller's config.
- Package dry-run includes `src/widget/public-api.ts` and all referenced declarations; widget and
  package typechecks pass. The public-types test proves the declared registration/submit shape.
- The tag-reconstructed old widget still passes against the candidate Worker. The full 201-test
  Chromium widget suite, 415 Vitest tests, lint, knip, formatting, and typechecking pass.
- The built widget is 45,093 gzip bytes, below the recorded 52,597-byte ceiling.

## Canary decision

Do not create a second routine Issue. Replace the current legacy browser action inside the existing
locked canary with one deployed headless structured submission. Preserve the fixed preview venue,
widget hash, Worker SHA, zero retries, single POST guard, server-only verification token, marker
rediscovery, unconditional cleanup, prefix sweep, and required-check bridge. Extend the independent
verifier to require the structured section and exact submission marker while retaining title,
labels, author, attribution, system information, no-screenshot, canonical URL, and singleton checks.

The Phase 0 receipt remains the live proof for the legacy path. This canary transition proves the
new shared path without increasing destructive operations per merge group.
