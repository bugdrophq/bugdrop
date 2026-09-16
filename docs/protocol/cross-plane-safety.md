# Local cross-plane safety harness

The current public system remains supported. This harness compares its tracked
runtime, assets, widget build inputs and Wrangler configuration to the starting
`main` commit recorded in `test/cross-plane/fixtures/current-public-baseline.v1.json`.
Public fingerprint mutations and changed/skipped/retried browser evidence must fail.
An intentional future public change requires explicit baseline review; do not
refresh the fingerprint merely to make a failure disappear.

Managed tests run the implementation's actual `managed/local/adapter.mjs`: real
Miniflare Workers, SQLite Durable Objects, V1 capability HTTP exchange, and a
private fake GitHub adapter. They do not import the first-tranche service double.
All six SDK JSON fixtures are pinned byte-for-byte with provenance in
`test/protocol/v1/fixtures/upstream.json`. No new hosted submission protocol is
claimed: the managed submission adapter is a local test seam for opaque tokens.

## Running the tests

```sh
npm run protocol:check-fixtures -- /absolute/path/to/merged-sdk-checkout
npm run test:cross-plane
```

Before the implementation PR lands, an explicit
`BUGDROP_MANAGED_TEST_ROOT=/absolute/path/to/implementation-checkout` selects its
adapter for coordinated integration. Normal CI uses the adapter in this repository.
A missing adapter fails the suite; it is never treated as a skipped success.
The managed implementation owns the adapter and all `src/managed`/`managed`
files. Safety work owns the attack tests, canary oracle and public comparison.

Run the selected public browser suite before and after integration on the same
named local venue, with the widget built using `BUGDROP_TEST_HOOKS=1`. For example,
after starting the local Worker at `http://bugdrop.localhost:8793`:

```sh
LIVE_TARGET=local PLAYWRIGHT_BASE_URL=http://bugdrop.localhost:8793 \
  PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/current-public-before.json \
  npx playwright test e2e/public-flow.spec.ts e2e/default-flow-compatibility.spec.ts \
  e2e/legacy-compat.spec.ts e2e/api.spec.ts --project=chromium --workers=2 --reporter=json
# Repeat after integration with PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/current-public-after.json
npm run cross-plane:compare-public -- /tmp/current-public-before.json /tmp/current-public-after.json
```

The existing `legacy-compat.spec.ts` filename is retained; it tests the supported
current public contract. The comparison requires the same 48 test identities,
passing outcomes, zero skips and zero retries. HTTP response/request payload
assertions live in those existing tests; timing measurements are not compared.

## Attack scope

- Current-public token versus managed API credential/capability confusion in both
  directions; copied application identifiers never authorize managed work.
- Exact configured origin, trailing dots, default-port and case aliases, alternate
  origins, missing bindings and exact payload-byte changes.
- Workspace/application/destination and reporter fields injected into capability
  exchange; tampered opaque capabilities; valid signed capabilities checked against
  substituted trusted tenant/application/destination contexts. This is not a claim of multi-tenant
  database RLS coverage: the local fixture contains one configured application.
- Concurrent replay, reminted capability replay, a changed payload under the same
  consumed submission ID, expiry, stale authorization and revocation scopes.
- Signed synthetic GitHub uninstall versus wrong installation, event/action,
  signature and body tampering; no live GitHub installation is used.
- Fake GitHub ambiguity and timeout, restart during `delivering`, replay after
  restart, and an explicit new logical submission following an indeterminate one.
  These prove at most one attempt within the tested receipt lifetime, not exactly
  once delivery or a live 30-day retention/cleanup test.
- Explicit SDK-version capture and malformed values. The local implementation
  currently supports the pinned SDK package version; this is not a promise of
  universal package-version compatibility.

## Privacy evidence boundary

The test-only client holds canary report content, page URLs, synthetic identity,
raw credentials, and opaque capabilities. These bytes are allowed only in the
submission flow to the fake private delivery boundary. They must not appear in
normalized outcomes, receipt state or observed telemetry. The oracle also rejects
forbidden sink fields and URL/credential prefixes even for unknown canary values.
Its negative tests poison each evidence sink and the adapter's shared emission
collectors to ensure leaks remain visible before the oracle rejects them. Raw
submission responses are parsed and restricted to the normalized outcome schema;
observed SDK evidence must contain only the pinned version and fixed generated
transport metadata. No allowlist filter may erase a leak before these checks.

Trusted configured origin and operational routing metadata are configuration, not
report-derived telemetry. The user requested stricter outcome minimization than
the proposal's optional first-party Issue URL: this tranche retains no GitHub
content or Issue URLs. SDK and UI session-only analytics remain owned by their
respective workers; these managed tests cannot establish browser analytics behavior.

The oracle requires real captured Worker logs, denied outbound-request evidence,
and SQLite receipt snapshots. It checks that the local manifests grant no Queue
or analytics binding authority, instead of treating fabricated empty sink arrays
as proof. It also requires the fake delivery attempt records to match the attempt
count. Queue producer/consumer privacy is not exercised when those bindings are absent. Database retention/RLS, provider account/CI isolation, real Queue/DLQ
behavior and deployed revocation propagation remain separate gates. These local
tests grant no deployment, provisioning, secret rotation or SDK publication authority.
