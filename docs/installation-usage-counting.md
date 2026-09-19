# Per-installation successful feedback counts

BugDrop can privately count successful GitHub Issues per GitHub App installation without adding a
database. The feature reuses the existing `FEEDBACK_COUNTER` Durable Object namespace for atomic
counts and asynchronously mirrors the latest durable integer into the existing
`INSTALLATION_ANALYTICS` KV namespace for the operator-only consent review.

## Data boundary

Each usage record contains exactly:

```json
{
  "schemaVersion": 1,
  "installationId": 123,
  "successfulFeedbackCount": 7
}
```

The count covers successful feedback Issues created in every repository available through that
installation. It is prospective and does not backfill older Issues. BugDrop does not store the
repository, Issue contents, reporter, submission timestamp, or last-active date in this record.
The public aggregate feedback counter remains separate and rounded.

## Activation and rollback

Collection is off unless `INSTALLATION_USAGE_ENABLED` is exactly `true`. Do not enable it until the
published privacy policy accurately discloses the purpose, fields, retention, and deletion behavior.
Turning the setting off immediately stops accepting new per-installation events without affecting
the public anonymous total. A count already accepted by the Durable Object may finish mirroring to
KV. Keep the existing `FEEDBACK_COUNTER` binding available after activation so uninstall cleanup
can remove previously stored durable counts.

After enabling it, dogfood one controlled installation and verify that its private record has only
the three allowed fields above. Uninstall it and verify that the identity, usage mirror, and atomic
counter are removed.

## Deletion behavior

While collection is enabled, an uninstall webhook or retention sweep first writes a seven-day
opaque KV deletion guard, then sets a strongly consistent seven-day deletion marker in the
installation's Durable Object. It then deletes the atomic count and KV usage mirror, and removes the
installation identity last. This order makes a partial cleanup retryable and prevents a delayed
in-flight submission from recreating usage after uninstall. While collection is disabled, cleanup
hard-purges any old counter and mirror without creating those guards. No installation ID or account
identity is exposed through a public endpoint.

The Durable Object coalesces bursts into a single delayed KV write, avoiding Workers KV's
same-key write-rate limit. Its alarm retries a failed mirror write; the operator view can lag a
successful submission briefly while the durable count remains authoritative.

The mirror is not created until the installation identity record is visible. If that record is
still propagating, the Durable Object makes at most 1,440 one-minute retry checks without resetting
the original budget. The budget is a non-temporal integer; no submission timestamp is stored. If no
identity arrives, it purges the unanchored counter instead of retaining usage that the scheduled
cleanup cannot discover. Before cleanup, the same daily task finds active GitHub App installations
that lack an identity record and creates those missing records using the approved minimal schema. It stores an
aggregate-only audit, and reuses the fetched installation set for cleanup. That idempotent repair
lets installations from before tracking—and installations whose creation webhook was permanently
missed—begin prospective counting without a reinstall. The reconciliation code also supports a
non-writing dry run for controlled verification. Active installations without a supported GitHub
User or Organization identity remain part of cleanup but are skipped by reconciliation and counted
only in the aggregate audit. Apply repairs at most 25 records at a time and reports the remaining
aggregate count so large inventories finish safely over later daily runs. Each repair candidate is
confirmed active immediately after creation; an uninstall racing the repair triggers the
same complete identity-and-usage cleanup as an uninstall webhook.

Delivery uses one opaque event ID across retries, so an ambiguous retry does not increment twice.
It has the same best-effort delivery boundary as the existing anonymous public counter; it is not a
billing ledger.

## Private administrator inventory

`GET /internal/admin/installations` is a server-to-server read for a future BugDrop account backend.
It is not a browser API. The backend must authenticate the administrator, check the administrator
role on every request, and record access in its own audit log. The Worker accepts only a dedicated
`Authorization: Bearer <credential>` header; it does not use GitHub repository authority or the
optional widget feedback token for this route. Browser-origin requests are rejected, no CORS
permission is added, and every response uses `Cache-Control: no-store`. The route is network-reachable
on the Worker's `workers.dev` hostname, so its path is never treated as a security boundary. This
change does not add a `bugdrop.dev` route.

The credential is a random 32-byte base64url string (43 characters). Provision it as
`ADMIN_READ_API_SECRET` in the Worker secret store and the account backend's server-side secret
store, separately for preview and production. Never put it in `wrangler.toml`, source control,
browser code, a URL, or a client response. For rotation, set the old value temporarily as
`ADMIN_READ_API_PREVIOUS_SECRET`, replace the primary credential, update the backend, verify that
the new credential works, then remove the previous secret. An absent or malformed primary or
previous secret makes this route unavailable.

The route accepts an optional `limit` query parameter (1–8, default 8) and an opaque
`X-BugDrop-Inventory-Cursor` request header. The cursor stays out of request URLs, which the
Worker's global logger normally records. The admin path is excluded from that URL logger even for
malformed requests. The eight-record cap bounds its KV and Durable Object reads per
request. It lists only `installation:` identity keys and returns `items` plus nullable `nextCursor`.
Each item contains the installation ID, validated public GitHub account identity, install date, and
`successfulFeedbackCount`, which is `null` when the KV mirror is absent. Zero is an observed zero.
The mirror has no update timestamp, so the API cannot state its measured age or guarantee a
freshness window. The dashboard should label the value best effort, show a missing mirror as
unavailable rather than zero, and avoid using it for billing or operational decisions. An empty
page can have a `nextCursor` when records were deleted during the read. The caller must keep paging
until the cursor is null.

The Worker checks both the KV deletion guard and the Durable Object deletion marker before returning
an item. A deletion that begins after the final check can still race a response, and KV inventory
is eventually consistent. The account backend must not treat this inventory as an immediately
authoritative active-installation registry. Missing bindings, malformed records, and failed reads
return an unavailable response without partial data. No feedback delivery or count-write path
depends on this read API.
