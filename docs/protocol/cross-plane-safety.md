# Local cross-plane safety harness

The current public system remains supported. This harness compares its tracked
runtime, assets, widget build inputs and Wrangler configuration to the reviewed
feature commit recorded in `test/cross-plane/fixtures/current-public-baseline.v2.json`.
The test verifies that the fixture's commit produces its exact file count and
fingerprint, then compares the working tree against that fingerprint. Public
fingerprint mutations and changed/skipped/retried browser evidence must fail.
An intentional future public change requires explicit baseline review; do not
refresh the fingerprint merely to make a failure disappear. The v1 fixture
remains as the pre-localization historical baseline.

The iOS annotation touch change in PR #414 intentionally updates
`src/widget/annotator.ts` and `src/widget/ui.ts`. Its reviewed public file set
remains at 145 files; its fingerprint was pinned to PR head
`ae23125dfc907ae0c5af418cba518a88144ed0ea`. No managed files or other
public files changed in that PR. Later mainline baselines include the Issue #300
prefill and PR #421 annotation zoom changes described below.

## Reviewed v2 public change

Merge commit `73bb9db0a9ad69a508007bb39c5f23f174c338ef` combines the
reviewed mainline form-prefill and annotation-zoom changes with the Chinese
widget feature. The v2 fixture pins all 148 public files in that commit to
SHA-256 `2bee4a7248c57e66e67b51a33706791c8217b22976df11fe5f4a017ff0ea1a00`.
This merge supplies Chinese copy for the six new prefill and zoom strings and
adds `INVALID_SUBMITTER` to the legacy feedback error-code map.

The Chinese widget change deliberately updates these nine public paths relative
to the updated v1 baseline:

| Path | Rationale |
| --- | --- |
| `src/routes/api.ts` | Add stable machine codes beside existing English errors for legacy feedback failures, while retaining structured-feedback and check response shapes. |
| `src/widget/i18n.ts` | Resolve explicit Simplified Chinese tags and provide localized submission-error mapping. |
| `src/widget/index.ts` | Display localized default-widget error copy based on machine codes. |
| `src/widget/ui.ts` | Wrap category choices at narrow widths so translated labels do not collide. |
| `src/widget/locales/de.ts` | Add German copy for the new submission-error codes. |
| `src/widget/locales/en.ts` | Add English copy for the new submission-error codes. |
| `src/widget/locales/nl.ts` | Add Dutch copy for the new submission-error codes. |
| `src/widget/locales/pl.ts` | Add Polish copy for the new submission-error codes. |
| `src/widget/locales/zh-CN.ts` | Add complete Simplified Chinese widget copy and submission-error messages. |

The v2 scope still includes every tracked public file. The mutation checks cover
the new Chinese dictionary as well as the existing runtime, configuration and
widget build boundaries. Its predecessor `b30a34bfcdbc83ec58e9d9c0a8dab893064a5d19`
follows the original Chinese feature commit
`6b9ec9a4100a4351b143451b4a211b7067f3fb9e` with one public-line change:
`FeedbackErrorCode` in `src/widget/i18n.ts` became a module-local type after
Knip identified its export as unused. No public file was excluded from the
fingerprint for this follow-up. The reviewed `af4d831` commit then changes only
two declarations in `src/widget/ui.ts`: category options use their content width
as a minimum and an automatic flex basis. This keeps the choices on one row at
390 px while allowing the Chinese labels to wrap without overlap at 320 px.

## Issue #300 public widget delta

The Issue #300 built-in form prefill implementation intentionally changes
`src/widget/index.ts` and adds `src/widget/prefill.ts`. The latter is included in
`git ls-files` with intent-to-add before calculating the refreshed fingerprint;
the protected source set grows from 145 to 146 files. The reviewed source-set
delta contains only those two paths. The previous SHA-256
`ac7c93c9f6e797fc29e97c37a869640d565e008abee63477e02f646ad318ff10`
is retained as provenance in the fixture, alongside its original base commit
in `approvedDelta.previousBaseCommit`.
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

The PR #418 CI repair removes two unused type exports from only
`src/widget/prefill.ts` in the unchanged 146-file protected source set. Its
previous SHA-256 was
`748ea26269fbac2658cfe60d4bdbcb00e609949ebba3455dc3fd4d68fd0d9306`;
the reviewed SHA-256 is
`dd1bcf77b60ac91561803746bf0e5b6809e012450827434c434e3c2b738c3bf9`.
The generated widget bundle had the same SHA-256 before and after the edit:
`6776b41b2929a00d5a10d777f4fc132a016c33e04291a61d2217e93f2369aa36`.
All earlier provenance stays in the fixture, and the fingerprint mutation tests
remain strict.

The merge of PR #414's iOS annotation changes with Issue #300 retains all
reviewed source deltas. The protected set has 146 files. The mainline SHA-256
before integration was
`8e25450e69bf292138be25a8aed7241ae47c114693dab824a003c2ee87515a1d`;
the Issue #300 branch SHA-256 was
`dd1bcf77b60ac91561803746bf0e5b6809e012450827434c434e3c2b738c3bf9`.
The combined SHA-256 is
`4b22c27dcbe354226005068fa19efd5a51ca438db65b5212510a57d935942edf`.
It was calculated after direct review of the merged source set. The fingerprint
test and mutation checks remain strict.

The pre-merge review of PR #418 found that reporter-edited built-in and mapped
custom-flow submitter fields could exceed the Worker's new length limits. The
form now applies the same name and email caps before advancing. The protected
set remains at 146 files; its SHA-256 changes from
`4b22c27dcbe354226005068fa19efd5a51ca438db65b5212510a57d935942edf`
to `0b1bc59207e1ab085b39193b1b2691376fe93d5bfe34cfd41b80853620720ac3`.
The fixture retains the previous fingerprint and the three changed source paths.

PR #421 then adds screenshot annotation zoom and pan, extracts drawing primitives
to `src/widget/annotation-marks.ts`, updates widget translations and mobile
styles, and allows local QA on Bonjour `.local` hosts in three `public/test`
files. Integrating these changes with PR #418 increases the protected public
file set from 146 to 147. The previous mainline fingerprint was
`0b1bc59207e1ab085b39193b1b2691376fe93d5bfe34cfd41b80853620720ac3`;
the reviewed PR #421 fingerprint before integration was
`1e9800cddc885db4d307e0352d8be97d093d77e78d6f9aa67364f70369b4429f`.
The combined fingerprint is
`bf1456cf33fd5f2a574f6f1908a7ab6548f040a969fd6e823f993f01de64ca6f`.
No managed files, Wrangler configuration, widget build script, or widget
TypeScript configuration changed in PR #421.

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
