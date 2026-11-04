# Public homepage totals

The public website displays only the existing GitHub App installation and successful
feedback Issue totals. No recent-activity, per-account, or visitor-attribution metric
is introduced.

## Installation total

The `7 * * * *` scheduled event fetches the complete authenticated GitHub App inventory.
It subtracts accounts in `INSTALLATION_COUNT_EXCLUDED_OWNERS`, rounds down to tens,
and writes `public:github-app-installations:v1` into `INSTALLATION_ANALYTICS` KV.
Only the aggregate, schema version, display string, and verification timestamp are
stored in this snapshot. Installations without supported identity records remain
included in the inventory total. This counts current installations, not lifetime
installation completions, unique people, repositories, or paying customers; uninstalls
can decrease the total.

`GET /api/stats/installations` reads that snapshot without contacting GitHub or listing
identity records. Its response is cached for five minutes. Failed inventory pagination
or publication does not replace the previous snapshot; a missing/invalid snapshot
returns 503 with `Cache-Control: no-store`, never an invented zero. KV propagation can
briefly delay a newly verified value. The daily `17 3 * * *` reconciliation and deletion
schedule remains unchanged. Installation-acquisition collection is not enabled.

## Feedback total

`GET /api/stats/feedback-issues` retains its existing response shape and rounds the
successful-Issue counter down to hundreds. Shared caching is now 15 minutes. The
checked-in first-party exclusions include `mean-weasel`, `neonwatty`, and `bugdrophq`
for future increments. This change does not subtract historical test activity or
re-audit the existing baseline; the total is a best-effort aggregate, not a billing
ledger. Private per-installation usage behavior is unchanged.

## Release order and verification

1. Release the Worker using the existing protected manual-release procedure.
2. After the next hourly scheduled event, verify the first-party installations endpoint
   returns 200 with a rounded count and current `updatedAt`; confirm the live Worker
   health SHA matches the released commit. The new first-party route must be deployed
   with the Worker. Do not expose GitHub credentials or KV identity records to initialize it.
3. Verify feedback JSON compatibility and the 15-minute shared cache header.
4. Release the website consumer. It caches verified successes for 15 minutes and keeps
   its last successful value if refresh fails. A cold deployment with no verified value
   shows an unavailable dash rather than the previous hardcoded install/fallback totals.
5. Inspect the two homepage totals and verify Marketplace click tracking still identifies
   social-proof intent. Product Hunt's historical achievement and the rest of the hero
   remain unchanged.

Local fixtures and tests do not establish production deployment or snapshot initialization.
