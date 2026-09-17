# Private binding closed-denial readiness

This Node-only client is a separate readiness check. It does not invoke the SDK,
produce `staging_passed`, exercise twenty scenarios, or claim remote acceptance.
No live Cloudflare transport or evidence oracle ships with this client. Importing
it does not create a session or load credentials. All tests use synthetic modules
and local files. Do not execute against Cloudflare without separate authorization.

## Approval and provenance

Call `runClosedDenials({descriptorPath, approvedDigest})` from
`private-readiness.mjs`. The digest must come from an independent approval, not be
calculated automatically from whichever descriptor exists when a run starts.
The descriptor must be a real absolute path, not a symlink, contain canonical JSON
bytes, and match that SHA256. `canonical` and `digest` are exported by
`private-readiness-descriptor.mjs` for approval tooling. Object keys are sorted
ASCII, arrays retain their specified order, integers are safe integers, and there
is no BOM, whitespace or trailing newline. Duplicate JSON keys are rejected by
requiring byte-for-byte canonical reserialization. Unknown schema fields fail.

Exact descriptor fields:

- `schemaVersion: 1`, `proofKind: "private-binding-closed-denial"`, `accountId`
  (32 lowercase hex), `runtimeRevision` (40 lowercase hex).
- `workers`: five entries ordered authority, delivery, github, ingress,
  reconciliation, named `bugdrop-managed-<role>-staging`. Each contains exactly
  `name`, `versionId`, `entrypoints`, `configurationSha256`, `sourceBundleSha256`,
  `provenanceReceiptSha256`. Entry points are `["StagingObservation"]` for authority,
  `["default"]` for ingress, and `[]` for the others. These describe this client's
  permitted access, not every export on the deployed Worker.
- `runnerArtifacts`: sorted by name, exactly `oracle`, `transport`, and
  `bundle-<worker-name>` / `provenance-<worker-name>` for all five Workers. Each
  contains `name`, `absolutePath`, `sha256`. Files must be real, at most 8 MiB,
  hash-pinned and present before imports. Modules are imported from the verified
  bytes, preventing later file replacement from changing them. They must be
  reviewed self-contained ESM; relative dependencies cannot resolve from data URLs.
- `proxyPolicy`: `capabilityScopeSha256`, `temporaryResourceInventorySha256`,
  `revocationProcedureSha256`, `maximumLifetimeSeconds` (1–60). Exact provider
  capability, inventory and revocation procedure must be independently reviewed.
  An unknown temporary resource or missing revocation mechanism blocks use.

Each provenance artifact contains exactly `schemaVersion:1`, `accountId`,
`worker`, `versionId`, `sourceRevision`, `bundleSha256`, matching the descriptor
and actual pinned bundle bytes. These receipts must be independently established
from reviewed build inputs and provider upload/version evidence. Matching hashes
only establishes consistency; it cannot authenticate a fabricated receipt. Existing
staging deployment records without captured bundle bytes do not satisfy this gate.
No automatic approval, bundle reconstruction claim or silent redeploy is permitted.

## Pinned module contracts

The trusted oracle exports `inspect({nonce, signal})` and
`revocation({sessionId, nonce, signal})`. It must obtain provider evidence through
an independent control-plane channel, never copy expected values from the approved
descriptor or transport. Fresh responses echo the unpredictable nonce and include
`observedAt` in Unix milliseconds, no more than five seconds old or in the future.

`inspect` returns exactly `nonce`, `observedAt`, `accountId`, `workers`. Workers
have `name`, `versionId`, `entrypoints`, `configuration` and the same order as the
approved descriptor. Configuration contains exactly `vars`, `secretNames`,
`services`, `durableObjects`, `hyperdrive`, `workersDev`, `previewUrls`, `routes`,
`domains`, `compatibilityDate`, `compatibilityFlags`, `observability`, `logpush`,
`tailConsumers`. Its canonical SHA256 must match approval. All `_ENABLED` vars
must be strings `"false"`, `ENVIRONMENT` must be `"staging"`, workers.dev/previews
must be false, and target routes/domains must be empty. Never return secret values.
Version and configuration drift fails before opening or after the probes/cleanup.

The trusted transport exports `open({descriptor, signal})`. Approval is deeply
frozen. Return exactly `id` (opaque safe identifier, never a credential),
`expiresAt`, `capabilityScopeSha256`, `temporaryResourceInventorySha256`,
`fetch(binding, request)`, `dispose({signal})`. It must honor cancellation and
revoke any allocation on failed open. Late successful open receives best-effort
cleanup, but the run remains failed. An adapter that never settles cannot provide
cleanup proof; independent operator recovery remains mandatory, not automatic success.

Two fixed unsigned POSTs with body `{}` are sent: ingress
`/v1/submission-capabilities` and observer `/observation/read`. The logical host is
`private-collector.bugdrop.localhost`; it is a binding Request label, never a DNS
endpoint or SDK manifest override. There is no HTTP listener, generic forwarding
API, caller-supplied route/header/body, or root credential access. Transport must
preserve exact host/path/method, use only the approved bindings, honor manual
redirect behavior and never follow a redirect internally. Responses must be
nonredirected HTTP403 with exactly `{"error":"managed_request_rejected"}` and no
Location or Set-Cookie. Each complete fetch/body exchange is limited to two seconds
and 256 bytes. Unexpected success, extra fields, redirects and hanging bodies fail.

After disposal, `revocation` must return exactly `nonce`, `observedAt`, `sessionId`,
`revocationProcedureSha256`, `credentialProbeStatus` (401 or403) and
`remainingResourceIds` (empty). The oracle must actually challenge the old proxy
credential and independently enumerate its temporary resources; a generic unrelated
403 or a copied boolean is not proof. Disposal alone is never accepted. Disposal failure does not skip the independent revocation challenge or final readback; each is attempted and any failure remains sticky. The client
then independently rechecks closed target state. These checks rely on reviewed,
pinned oracle code; they do not make untrusted JavaScript safe.

Every adapter/oracle operation has a bounded wait. Any failed probe or cleanup
withholds a result and throws only `private_readiness_rejected`, without reflecting
error text, response content, URLs or credentials. The sole successful result is
`proofKind: "private-binding-closed-denial"`, `outcome: "closed_denials_verified"`,
`acceptance: false`, plus approved digest and probe count. No retry-to-green loop.

## Custody, limitations and rollback

The client reads no SDK root, signing/HMAC secrets or OAuth material. Its two
probes require none. A future bridge that carries derived auth/capability headers
would have sensitive custody despite not reading a root file; that feature is not
implemented here. Pinned modules must not log/capture URLs, headers, bodies, cookies,
credentials, proxy endpoints or raw provider errors. Hash pinning is not sandboxing:
module top-level code and dependencies must be independently reviewed, including
revocation behavior and diagnostic suppression, before approval.

No deployed flags, DNS, routes, secrets or existing acceptance semantics change.
Future authorized use must dispose its proxy and verify revoked credentials and
absent temporary resources; never delete Durable Objects, SQL data, receipts or
permanent uninstall latches. A failed cleanup remains a failure requiring operator
attention. Full SDK acceptance still needs an approved ordinary HTTPS endpoint,
explicit activation, live independent issue/SQL evidence and real fault/retention
controls. This client supplies none of those prerequisites.

Run local synthetic tests: `npx vitest run test/managed/private-readiness.test.ts`.
