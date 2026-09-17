# Remote safety gate contract

`evidence.mjs` exports `assertEvidence({evidence, expected, forbiddenValues})`.
`scenarios.mjs` exports `runRemoteSafety(provider, approvedTarget)` and thirteen
adversarial scenarios. These modules do not provision a target or select credentials.
The isolated SDK runner may import the oracle from an explicitly SHA-pinned file.

No staging App/repository/hostname has been approved or provisioned by this task.
There is no implemented remote provider or successful remote run in this change.
Do not pass the local Miniflare adapter as a remote provider. A missing provider or
unavailable observer is a blocking prerequisite, never a skipped passing test.

The approved target contains `approved: true`, `environment: 'staging'`, exact
`serviceRevision` (40 hex), `deploymentDigest` (64 hex), `repositoryId` (decimal
string), configured `origin`, and pinned `sdkVersion`. Approval must come from the
operator; no code in this directory grants it. The provider's read-only
`inspectTarget()` must verify those values through provider APIs and supply a fresh
UUID `runId`. Version labels in responses alone are not sufficient provenance.
Its observed `sdkVersion` identifies the actual SDK client used by the collector,
not a Worker deployment property; inspect the pinned client package before starting
any potentially mutating scenario. Missing or mismatched observations fail preflight.

Each scenario uses a fresh synthetic authorization fixture in the same dedicated
approved application/repository; fixture isolation and cleanup are provider-owned.
The service returned by `startScenario({scenario,runId})` implements the methods
called in `scenarios.mjs`. Fault injection, restart, context substitution and stale
projection controls must use private authenticated staging controls. They must not
be exposed as public submission endpoints. Uninstall runs last and targets only
the approved installation. There is no automatic reinstall or retry.

`evidence()` must independently read the actual deployed service version/config,
bounded complete log observation window, persisted receipt rows, sink-binding
configuration, and GitHub issue counts. It returns the exact schema enforced in
`evidence.mjs`. Counts are scoped to the isolated scenario. Exchange records include
all HTTP attempts (including failures), with sequence, SDK version, and status;
submission records preserve observed response order. The safety driver supplies
`expected.exchangeSuccesses` to require successful issuance before each authority
fault; a failed baseline mint is a test failure, not evidence of revocation.
Origin aliases also require successful configured-origin issuance first. Expected
issuance denials must record the staging issuer's HTTP 403; authentication-layer
errors, rate limits and server failures cannot substitute for that rejection.
Receipt state and at-most-one
attempt admission must come from actual durable storage, not request counters.

For each of `deployment`, `logs`, `storage`, `analytics`, `queues`, and `github`,
the source records `status`, `provider`, `runId`, `complete`, and `records`.
`unavailable`, partial windows, missing fields, wrong target versions, reordered or
extra observations, and additional GitHub issues fail the oracle. Disabled logs,
analytics or queues require provider-read configuration evidence of zero bindings
and disabled export. Do not replace actual failed observations with empty arrays.
The oracle checks schema, correlation, cardinality, and privacy; it cannot prove
that a dishonest provider actually queried a service. Pin and independently review
the provider collector and retain its sanitized API evidence receipt.

`secretMarkers()` supplies credentials only inside the isolated test process for
canary comparisons. Never print these markers or serialize them into reports. The
oracle's errors intentionally omit rejected values. `evidence.test.ts` poisons
synthetic examples to verify that the oracle rejects bad evidence; those tests are
explicitly not observations of deployed resources.

The retention scenario requires a provider-native expiry/cleanup drill on isolated
content-free receipt fixtures: seed an already expired and an unexpired row, invoke
the actual alarm/deletion path, prove the expired row is absent and schema remains,
then prove a repeated alarm cannot delete the newer row. The provider must obtain
these counts from actual storage and restrict fixture writes to isolated staging
objects; it must never shorten the configured 30-day production receipt lifetime.
Approved resources and a real provider are still required to run this drill; it is
not a 30-day wall-clock observation. The merged local SQLite expiry
test covers local behavior only. Repeat the supported-public 48-case comparison
and 145-file fingerprint using `docs/protocol/cross-plane-safety.md` before and
after any actual staging integration.

## Uninstall completion is currently blocked

Follow the [closed cross-plane activation gates](../../managed/staging/README.md#closed-cross-plane-activation-gates)
for the shared runtime, publisher and lifecycle completion contract.

`waitForSignedUninstall()` can establish the verified edge latch only. End-to-end
completion additionally requires durable normalized lifecycle intake, independent
permanent edge and Supabase `apply_installation_event`/cleanup acknowledgements,
and reconciliation of pending/quarantined partial failures. Canonical provider
installation IDs are positive decimal strings on wire, distinct from internal SQL
UUIDs. SQL revocation acknowledgement requires an authenticated post-sync receipt
or private status result matching application/key, exact sequence, projection
digest, configurationVersion and authorizationVersion. Resolve lost acknowledgements
through private status or exact-byte retries returning the same receipt without
renewing observedAt; altered same-sequence bytes must reject. The current generic
HTTP 200 and duplicate-sequence HTTP 403 cannot acknowledge revocation.

Hosted activation also remains blocked on a trusted locked authoritative
mapping/read, durable monotonic outbox and authorizationVersion, original observedAt,
scoped verifier provisioning and secret-custody bootstrap. The current SQL model
cannot represent active applications/installations. Pending credentials stay
SQL-only because credentialActive:false is terminal for that key. First positive
publication requires committed activation, verified installation eligibility and
reviewed transaction/order. A future reviewed coordinator schema may retain minimal
keyed nonidentity operational commitments (eventHash, installationHash,
projectionDigest); it must exclude raw payloads, end-user identity and secrets.
This does not expand the current evidence schema or introduce control RPCs.

No collector for these completion records exists here. The uninstall scenario
therefore deliberately throws `staging_uninstall_completion_unavailable` after
verifying edge rejection; no aggregate remote run may report success until a
reviewed coordinator schema and actual observations replace that explicit gate.
