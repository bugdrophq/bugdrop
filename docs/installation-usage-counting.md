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
