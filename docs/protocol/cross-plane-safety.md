# Local cross-plane safety harness

The current public system remains supported. This harness compares its tracked
runtime, assets, widget build inputs and Wrangler configuration to the starting
`main` commit recorded in `test/cross-plane/fixtures/current-public-baseline.v1.json`.
Public fingerprint mutations and changed/skipped/retried browser evidence must fail.
An intentional future public change requires explicit baseline review; do not
refresh the fingerprint merely to make a failure disappear.

## Issue #300 public widget delta

The Issue #300 built-in form prefill implementation intentionally changes
`src/widget/index.ts` and adds `src/widget/prefill.ts`. The latter is included in
`git ls-files` with intent-to-add before calculating the refreshed fingerprint;
the protected source set grows from 145 to 146 files. The reviewed source-set
delta contains only those two paths. The previous SHA-256
`ac7c93c9f6e797fc29e97c37a869640d565e008abee63477e02f646ad318ff10`
is retained as provenance in the fixture, alongside its original base commit.
The new SHA-256 is
`7d148ce0efce203fb93fe95853dab571d1cc4568e0ad8bd77a6a856d199657b8`.
The fingerprint test and its mutation checks remain strict. Before this refresh,
13 focused unit tests and nine Chromium prefill/legacy tests passed on the
widget source diff, including both default runtimes and screenshot return after
clearing prefilled fields and description text.

The subsequent Issue #300 submitter safety exception changes only the additional
protected path `src/routes/api.ts`. The reviewed 146-file source set retains
both widget paths and all previous provenance. Its prior SHA-256 was
`7d148ce0efce203fb93fe95853dab571d1cc4568e0ad8bd77a6a856d199657b8`;
the new SHA-256 is
`0c34c80ef9c2ab4d16c7091f9a18fa19db2aceec144213fed517a3903b0adf27`.
Before this second refresh, focused API/legacy unit tests (123), protocol tests
(115), frozen legacy checks, and 15 local Chromium API/legacy tests passed.
The normative v1 exception is documented in the configurable-variants design:
ordinary valid submitter output stays byte-for-byte, while malformed values are
rejected before Issue creation and Markdown-sensitive values are escaped inline.

The Issue #300 pre-PR review repair changes eight protected source paths listed
in the fixture's `reviewRepairDelta`, retaining the same 146-file source set and
both prior provenance records. Its prior SHA-256 was
`0c34c80ef9c2ab4d16c7091f9a18fa19db2aceec144213fed517a3903b0adf27`;
the reviewed SHA-256 is
`9d359a905ced325771173bd07d766dc02b705dd81ef6c9bdf1a3741a3e3a472c`.
Focused unit tests (130) and local Chromium prefill/API/legacy tests (26) passed
before this refresh. GitHub's Markdown renderer showed an untrusted `@bugdrophq`
name inside a bold code span without an active mention link. The fingerprint
test still checks exact bytes and rejects public boundary mutations.

The follow-up email-validity repair changes only `src/widget/prefill.ts` and
`src/routes/api.ts` in the same 146-file protected source set. The previous
SHA-256 was
`9d359a905ced325771173bd07d766dc02b705dd81ef6c9bdf1a3741a3e3a472c`;
the new SHA-256 is
`748ea26269fbac2658cfe60d4bdbcb00e609949ebba3455dc3fd4d68fd0d9306`.
All prior provenance remains in the fixture. Before this refresh, focused unit
tests (135) and local Chromium prefill/API/legacy tests (30) passed, including
direct `typeMismatch` checks for two malformed host addresses and the actual
request after clearing a prefilled email. GitHub's Markdown renderer showed a
name containing both `@` and backticks inside one code span without an active
mention link. The fingerprint and mutation checks remain unchanged.

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
