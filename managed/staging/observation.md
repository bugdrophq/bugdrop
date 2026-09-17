# Private staging observation contract

This local implementation is disabled in checked-in manifests and is not remote acceptance evidence. It uses a separate table in the existing authorization DO, a private `StagingObservation` entrypoint, and a separate `STAGING_OBSERVATION_HMAC_KEY`. No public control route or additional namespace is introduced.

## Proof boundary

**Raw `snapshot.complete` covers durable observation admissions only. It does not certify every network attempt.** If an ingress-to-observer begin RPC never arrives, the ingress returns HTTP 503 while the raw DO counter can remain zero and complete. A real regression preserves this boundary.

The collector must reconcile the actual packed SDK invocation/outcome transcript with the independent durable exchange sequence, status, count and observed header. Any observer 403, public observer 503, timeout, transport exception, unknown outcome, missing or extra exchange permanently invalidates that scenario. It must never retry a failure into a passing result or substitute zero. Expected SDK local origin/input rejection must be classified from the actual error, with unchanged independent counters and an idle exclusive window. The SDK fetch implementation is not replaced. Overall completion remains blocked until the separately reviewed collector implements this composition.

`X-BugDrop-SDK-Version` is observed on the actual incoming request. Only `0.1.0` is retained; every other value becomes null and prevents complete evidence. This header is not artifact provenance: the collector must independently inspect the installed packed package and match its version and artifact identity.

## Signed wire

All operations are private POST `/observation/start`, `/observation/read`, `/observation/close`, `/observation/begin`, or `/observation/finish`. Request body maximum is 1024 bytes. Unknown fields are rejected. All bodies contain exactly `{schemaVersion:1,applicationId,installationId}` plus:

| Operation   | Additional fields                                                             |
| ----------- | ----------------------------------------------------------------------------- |
| start       | `runId` (UUIDv4), `scenario` (exact approved scenario name)                   |
| read, close | `runId`, `scenario`, `leaseId` (server-created UUIDv4)                        |
| begin       | `sdkVersion` (`"0.1.0"` or null)                                              |
| finish      | `runId`, `scenario`, `leaseId`, `sequence` (1–64), `status` (integer 200–599) |

The application and provider installation must match the configured immutable scope. The actual loaded issuance authority must match that scope too; mismatches leave an unfinished admission and return 503. Begin selects the sole active scope lease, because the SDK emits no run ID. Reads require every exact selector; missing, closed, expired or mismatched leases return unsigned 403, never a zero snapshot.

Request and response header: `X-BugDrop-Observation-Signature`, canonical base64url HMAC-SHA256 using the distinct observer key. Sign exact UTF-8 bytes:

- Request: `bugdrop:staging:observation-request:v1` + NUL + exact path + NUL + raw body.
- Response: `bugdrop:staging:observation-response:v1` + NUL + exact path + NUL + raw body.

Successful response has exactly `{schemaVersion:1,leaseId,expiresAt,sequence,snapshot,exchanges}`. `sequence` is the newly admitted sequence for begin, otherwise null. `expiresAt` is server Unix milliseconds. Snapshot is exactly `{runId,scenario,applicationId,count,complete,exclusive}`. Exchanges are ordered `{sequence,sdkVersion,status}` records; status is null while unfinished. Consumers verify signature, status, exact schema and selectors before reading fields. The ingress RPC deadline is two seconds including response-body consumption, maximum 16384 bytes.

Private errors are unsigned HTTP 403 `{error:"staging_observation_rejected"}` (entrypoint admission can return the existing `managed_request_rejected`). Public observer failure is HTTP 503 `{error:"staging_observation_unavailable"}`. These are not expected issuance denials. Ordinary issuer denials remain HTTP 403 `{error:"managed_request_rejected"}`.

## Bounds and cleanup

One lease per configured application, 15 minutes, at most 64 entries. No active lease replacement. Overlapping admissions, overflow, storage failures and observer restart invalidate evidence. Begin persists before issuance validation; finish persists before the response returns. Repeated finish is rejected. Closing prevents later reads; a new scenario gets a fresh lease ID. Expiry deletes only observer rows; it preserves authorization, control receipts and the permanent revocation latch.

Only run/scenario identifiers, application/provider scope, lease expiry, bounded sequence/status and the allowlisted version enum are retained. No feedback bodies, arbitrary headers, URL, IP, end-user identity or secrets are retained. Synthetic tests and fault controls are absent from deployed manifests.
