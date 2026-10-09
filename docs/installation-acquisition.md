# Daily installation completion measurement

## Scope and decision

The approved next SEO measurement step is a daily count of the public GitHub App's
installation completions, deduplicated across webhook redelivery and retained after
uninstall without carrying installation identities into marketing analytics.

Use the existing FeedbackCounter Durable Object class and namespace, with separate
objects named `installation-acquisition:YYYY-MM-DD`. Atomic storage transactions commit
the daily total, opaque receipt and publication alarm together. Existing installation
identity storage is unsuitable as the counter: it is eventually consistent and its records
are deleted on uninstall. Sending individual events directly to PostHog would introduce
another delivery/deduplication dependency and is outside this first increment.

Only authenticated `installation.created` webhooks enter this path. Reconciliation and
installation deletion never increment or decrement the count. A delayed signed creation
still counts if its installation has since been removed. The bucket uses GitHub's creation
date in UTC, not the delivery date. This measures received installation completions across
all acquisition sources, not website-attributed installs, unique people or active installs.

## Data and retention

A dedicated stable HMAC secret produces an opaque receipt from the app ID and installation
ID. Neither ID nor the account login, URL or webhook body is written to the daily object or
its KV mirror. The owned-account exclusion check happens in memory before receipt creation.
Receipts are linkable pseudonymous data within a bucket, not anonymous aggregates.

Creation events are accepted from the configured start timestamp through 30 days after the
end of their UTC creation day. An alarm erases receipts when that window closes; later
redeliveries cannot reopen it. Deletion timing depends on alarm availability. Only the day,
coverage start and count remain durably after receipt cleanup. Retention is independent of
installation identity deletion, including when collection is disabled.

## Failure behavior

Counting is awaited before the webhook acknowledges a creation. A failure returns a redacted
503, and redelivery retries the same receipt. GitHub delivery failures require monitoring
and redelivery; this is not a guarantee that GitHub retries automatically. Permanently
missed webhooks and deliveries outside the acceptance window are not counted. Existing
installation reconciliation deliberately does not backfill them.

Publication uses an alarm to coalesce updates into the existing private INSTALLATION_ANALYTICS
KV namespace. The key is `acquisition:daily:YYYY-MM-DD`; its JSON fields are `schemaVersion`,
`date`, `installations`, `coverageStartedAt`, and `updatedAt`. Failed publication is retried
without incrementing. KV is a delayed reporting mirror; the Durable Object is authoritative.
No public HTTP reporting route or PostHog capture is added.

## Activation and operations

Collection remains disabled unless INSTALLATION_ACQUISITION_STARTED_AT is set to a canonical
UTC ISO timestamp, for example `2026-10-15T00:00:00.000Z`. That example is not an activation
date. Configure INSTALLATION_ACQUISITION_HMAC_SECRET with at least 32 random characters and
INSTALLATION_ACQUISITION_EXCLUDED_OWNERS with the audited owned/test logins. Missing bindings,
a missing/short secret or invalid start fail closed when collection is enabled.

Keep the secret, start and exclusion list stable throughout a measurement series. Never rotate
the secret in place: doing so invalidates receipt identity and can count retries again. A future
rotation procedure needs overlapping-key deduplication or a closed acceptance window. Changing
the start is rejected by existing daily objects; it is not a supported backfill mechanism.

Before enabling: publish the corresponding privacy disclosure on the website, configure the
secret through the existing protected release process, record the exact coverage start and
exclusion list, and dogfood a signed controlled install/redelivery/uninstall. Confirm a single
daily increment, unchanged count after uninstall, and no identities in the KV mirror. Do not
send a fabricated event into production to prove the counter.

To stop accepting new events, unset the start timestamp. Existing receipt cleanup and mirror
alarms continue. Re-enable with the identical start and key. Off-period gaps remain gaps and
must be recorded externally; this counter cannot prove complete webhook coverage.

Private operator read commands (select the correct environment explicitly):

```sh
npx wrangler kv key list --binding INSTALLATION_ANALYTICS --env production --remote --prefix acquisition:daily:
npx wrangler kv key get acquisition:daily:2026-10-15 --binding INSTALLATION_ANALYTICS --env production --remote --text
```

A missing daily key is unknown until delivery health and activation coverage are checked; do
not silently interpret it as zero. Compare these totals alongside GSC and PostHog series, not
as the last step in a session funnel. No visitor-to-install attribution is established.

## Implementation and verification

- The webhook calls installation-acquisition.ts after signature and payload validation.
- installation-acquisition-counter.ts owns atomic count, expiry and mirroring behavior.
- FeedbackCounter dispatches acquisition requests and alarms separately from existing counters.
- Focused tests cover signature rejection, disabled/old/excluded/future events, retries after
  a lost acknowledgement, uninstall survival, receipt expiry and failed KV publication.
- A Miniflare test sends 30 concurrent deliveries for 10 receipts and requires exactly 10
  stored completions in real Workers storage and the aggregate mirror.
- Run the focused tests, complete unit suite, typecheck, lint, Knip and widget build; review
  against the actual main base with the required independent reviewers before creating a PR.
- Deployment and live collection remain separate, gated actions. Local test results are not
  evidence of production activation or successful PostHog ingestion.
