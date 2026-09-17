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

There are at most eight automatic attempts per recovery cycle, with backoff from one
second to one day. Pending/exhausted/quarantined work is retained. `UninstallControl`
is a private service entrypoint for signed `/status` and `/resume` requests; public
ingress, the GitHub webhook and the default delivery handler never route to it.
Resume preserves the original event tuple and restarts the bounded retry cycle.
Its request HMAC domain is `bugdrop:uninstall:<status|resume>:v1` plus NUL and exact
JSON bytes `{schemaVersion:1,eventHash,installationHash}`. Signed status uses
`bugdrop:uninstall:status:v1` plus NUL and exact response bytes.

Completed details expire 30 days after completion. A permanent one-bit tombstone
remains in that installation's DO so an old signed webhook cannot recreate work
after detail deletion. Neither pending work nor the edge revocation latch expires
through this cleanup path. Keep the commitment key stable for this object's lifetime;
key rotation requires a separately reviewed migration of routing and tombstones.

## Disabled deployment boundary

`managed/staging/github.json` still has `STAGING_ENABLED: false`, an invalid account
placeholder, no routes, and no provisioned secrets. Its reconciliation binding names
a private service that has **not** been deployed. `reconcileVerifiedUninstall` is an
injectable handler, not a public HTTP database API. The hosted SQL transport,
credential custody, provider resources and deployment remain unconfigured.

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
