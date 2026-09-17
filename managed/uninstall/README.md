# Private staging uninstall coordinator

The GitHub staging webhook verifies the original bounded HMAC-signed body and exact
configured App/owner/installation before calling this coordinator. It durably stores
one content-free work item and a recovery alarm before returning `accepted: true`.
That response means durable intake, **not completed uninstall**.

Each configured installation has one SQLite Durable Object, named by a keyed
installation commitment. Event identity is a domain-separated HMAC of the configured
GitHub App ID, installation ID and deletion action. Changed delivery headers,
irrelevant payload fields, retries and reordering cannot create a second event.
Private payloads, headers, keys, tokens and end-user identities are never stored.
The internal request UUID and `occurredAt` are generated on first verified intake
and retained exactly across retries. GitHub deletion payloads do not provide a
trusted event timestamp; `occurredAt` is intake time in epoch milliseconds.

## Completion and recovery

The coordinator drives two independent private operations, each with a two-second
response/body deadline. Edge failure does not suppress SQL work, or vice versa.

- Edge: the existing authenticated `/revoke-installation` operation must return an
  exact signed durable receipt for the configured application and installation with
  `revoked: true`. A repeat request resolves a lost acknowledgement because the latch
  is permanent. The response domain is `bugdrop:uninstall:edge-receipt:v1` plus NUL
  and the original response bytes, using the dedicated uninstall HMAC key.
- SQL: the injected private adapter calls the data owner's
  `private.apply_verified_uninstall` transaction, which resolves the provider-to-UUID
  mapping, cleans up installation state and fences publication. Its exact receipt
  must match eventHash, installationHash, provider installationId, original occurredAt
  and requestId, with `sqlApplied: true`. The adapter authenticates a scoped request
  before its callback and signs only an exact result. It rejects extra fields rather
  than filtering a leak out of evidence.

Both verified acknowledgements are required for `complete`. A 404, authentication
failure, timeout, generic success, mismatched receipt or malformed signature remains
pending. Only the explicit authenticated `mapping_missing` result quarantines work.
Quarantine does not prevent the edge latch from progressing and does not clear it.

There are at most eight automatic attempts per cycle, with backoff from one second
to one day. Every unresolved cycle has a 30-day deadline, including exhausted or
quarantined work. Signed private `/resume` may restart retry attempts before this
deadline; it preserves the original tuple and cannot extend the deadline.

At the exact deadline, an atomic replacement sets `operator_action_required` and
removes retry state. This is incomplete, delivery-closed work. The retained record
contains keyed event/installation commitments, independent acknowledgement bits,
original random request UUID/intake time, expiry/failure metadata and optional
content-free continuation metadata. No clear provider/internal routing identifiers
are stored by this coordinator at any point; routing normally comes from static
configuration. Expiry prevents ordinary resume from using that configuration.
Late side responses cannot complete or restore expired work. The permanent one-bit
fence is never removed. Completed details expire 30 days after completion.

`UninstallControl` is a private service entrypoint for signed `/status`, `/resume`
and `/continue`; public ingress, webhook and delivery handlers never route to it.
Status/resume requests use exact JSON `{schemaVersion:1,eventHash,installationHash}`
and HMAC domain `bugdrop:uninstall:<status|resume>:v1` plus NUL and original bytes.
Signed status uses `bugdrop:uninstall:status:v1` plus NUL and exact response bytes.
Keep the commitment key stable; key rotation requires a separately reviewed
migration of routing and tombstones.

Continuation is **injectable scaffolding, not a hosted recovery provider**. A private
`/continue` request adds the exact random `tombstoneId`, `tombstonedAt` and a nonsecret UUID `recoveryRequestId`
under its own HMAC domain. Binding the tombstone prevents an old request from
starting another recovery after later cycles expire.
Without the separately keyed `STAGING_UNINSTALL_RECOVERY` binding, it fails closed.
The coordinator creates a random challenge and generation, persisting only its hash,
expiry and generation. It sends the raw challenge only to the trusted adapter.
An exact, separately authenticated assertion must attest fresh affirmative provider
removal and current authoritative SQL mapping, bound to deployment, App, application,
provider installation, original tuple, tombstone, challenge and generation. Caller
booleans are never evidence. Evidence is limited to 30 seconds and transport to two
seconds; raw proof and mapping are never persisted.

Challenge consumption and linked-cycle creation are atomic. A lost accepted response
can be retried with the same request UUID. An expired attempt may be superseded;
late old-generation responses fail. Recovery has at most eight attempts per tombstone,
separated by the 30-second challenge window. A new accepted cycle gets a fresh 30-day
deadline while retaining the permanent fence and original SQL idempotency tuple.
It expires into another incomplete tombstone if unresolved. No provider verifier or
SQL mapping lookup is implemented here. If SQL receipt and mapping have expired,
recovery must remain incomplete/quarantined: it cannot recreate a mapping or infer
an acknowledgement from absence.

## Disabled deployment boundary

`managed/staging/github.json` still has `STAGING_ENABLED: false`, an invalid account
placeholder, no routes, and no provisioned secrets. Its reconciliation binding names
a private service that has **not** been deployed. `reconcileVerifiedUninstall` is an
injectable handler, not a public HTTP database API. The hosted SQL transport,
credential custody, provider resources and deployment remain unconfigured. Hosted
operator alerting and delivery of `operator_action_required` events are also required
before activation; a local status record does not prove an operator was notified.

The runtime control worker owns the permanent edge latch and signed receipt; the
data repository owns the authoritative SQL transaction and publication lock. The
local tests below exercise those real implementations together. Hosted safety still
requires a reviewed real provider and authenticated independent observations. The
remote safety runner deliberately retains its uninstall-completion hard block;
passing local tests does not authorize removing it or enabling staging.

## Local acceptance checks

```sh
npx vitest run test/managed/uninstall-contracts.test.ts \
  test/managed/uninstall-reconciliation.test.ts test/managed/uninstall-runtime.test.ts
BUGDROP_DATA_TEST_ROOT=/absolute/path/to/bugdrop-web \
  node managed/uninstall/postgres-proof.mjs
```

The second command requires the data owner's already initialized **local** Postgres
stack and its `supabase/tests/helpers/reconciliation.mjs`. Missing dependencies fail;
there is no skipped passing mode or environment-supplied database URL. Coordinate the
shared database window with its owner. The helper owns and cleans isolated fixtures
87–89; the harness never resets the database. During development only,
`BUGDROP_CONTROL_TEST_ROOT` can select the runtime owner's checkout; the final gate
uses the merged runtime in this repository.

Default DO tests label their side transports synthetic. They run actual SQLite DO
admission, alarms, restart and `ctx.abort` faults. The explicit Postgres proof injects
the real SQL helper and builds the actual edge authorization DO. It inspects both
stores for cleanup and permanent latch state, exercises lost acknowledgement on each
side, exact replay, delayed positive publication and detail retention. Retention
uses a local fixture clock and actual deletion path; it is not a 30-day wall-clock
observation. Test fault entrypoints have no deployment manifest.

Merged dependency baseline: edge/runtime `32e62f9fb8e0130fa861da607b465185b3f4ffb8`,
authoritative SQL `76b16bf6300da742198f6d4f4c060a4d3801e8d2`, and packed SDK v2
runner `3ac71b9c9608712888c8999907f361b20b3ad409`. Local proof uses these contracts;
none of these merge receipts is hosted activation evidence.
