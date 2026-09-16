# Local managed capability and receipt service

This is a runnable **local test service**, not a deployable managed endpoint. The
current public Worker and its configuration remain unchanged. The Stage 0 manifests
remain closed. Separate harness manifests reserve only local service bindings and a
new SQLite DO namespace, disable routes/workers.dev/preview URLs/observability, and
retain an invalid account sentinel. No infrastructure, secrets, route or GitHub App
has been provisioned. The fake GitHub service is the only delivery adapter.

## Contracts and dependencies

The merged account-control-plane proposal in `bugdrophq/bugdrop-web` is the product
source. Six unmodified SDK fixtures are pinned to commit
`2bfcfee54200e981815ee6e12bcf5bf5c97d4add` by
`test/protocol/v1/fixtures/upstream.json`. This branch includes the safety task's
fixture-pin commit; its later cross-plane harness depends on this implementation.
The packed SDK task uses `BUGDROP_LOCAL_SERVICE_ADAPTER` to test the actual service.

The public V1 contract implemented here is **POST /v1/submission-capabilities** with
the fixture-defined headers and body. API keys stay in the customer backend; the
service verifies the derived `bd_auth_v1` bearer against the peppered auth-secret
HMAC. It stores neither root nor auth-secret nor bearer. ES256 capabilities bind
application, tenant, destination, installation, credential/config/authorization
versions, exact canonical origin, submission ID and exact raw-byte payload digest.
Keys have explicit signing/verification windows; retired or unknown keys fail closed.
Signed-token expiry is strict, independently of the SDK response envelope's skew.

The fixtures deliberately leave tokens opaque and do not specify hosted submission
HTTP transport. `/_local/submit` is a harness-private Worker interface, **not a new
SDK wire contract**. The hosted widget/controller publication gate remains open;
checking `widget-public-api.v1.json` here does not claim a live hosted-widget E2E.
Only the merged SDK version `0.1.0` is allowlisted as operational evidence; unknown
versions reject without reflecting their input. A future version requires review.

## Running the actual implementation

From this repository root:

```sh
npm ci --ignore-scripts
npx vitest run test/managed
npm run validate
npx wrangler deploy --config managed/local/ingress.json --dry-run --outdir /tmp/bugdrop-local-ingress
npx wrangler deploy --config managed/local/delivery.json --dry-run --outdir /tmp/bugdrop-local-delivery
```

From an ordinary `.mjs` runner, import `start` from `managed/local/adapter.mjs` and
call `await start({fixtures})`, where `fixtures` is the parsed object keyed by the
six complete fixture filenames. The service returns a real HTTP `endpoint` at
`http://bugdrop-managed.localhost:<ephemeral-port>/v1/submission-capabilities` and
configured `origin: "https://example.com"`. The caller supplies the fixture's
`authorization` header. No fixture credential is configured in a Worker manifest.

The adapter creates ephemeral test keys in memory, temporary SQLite storage and
an HTTP bridge. A scoped Undici dispatcher maps the named host to loopback, so the
packed SDK uses ordinary HTTP fetch without an injected SDK transport. Internal
sockets bind loopback only. Always call `close()`; it restores the dispatcher and
removes temporary state. Do not launch with `node --input-type=module`: that flag
can break Miniflare's synchronous proxy subprocess. Use an actual `.mjs` file or
Vitest. Local socket permission is required.

## Test adapter surface

This surface is test-only and is not reachable through customer HTTP requests:

- `submit({capability, binding, requestBody, origin?})` accepts the V1 response
  envelope, fixture binding and exact UTF-8 string or `Uint8Array`. It returns only
  `{schemaVersion: 1, outcome}`. Outcomes are `delivered`, `delivering`,
  `indeterminate`, `failed_before_delivery`, or `rejected`.
- `revoke({scope?})` disables credential (default), application, tenant or installation.
  `expireAuthorizationState()` freezes a projection older than 30 seconds;
  `refreshAuthorizationState()` simulates acknowledged refresh. `advanceClock(ms)`
  advances the trusted clock. The normal harness models a healthy periodic refresh;
  it does not implement a real control-plane invalidation publisher.
- `uninstall({validSignature?, installationId?, action?, event?, tamperBody?})`
  constructs a local GitHub fixture event. The actual source verifier authenticates
  the exact raw HMAC-SHA256 bytes and matches `installation/deleted` for installation
  42 before disabling it. Invalid signatures, changed bodies and other installations
  have no effect. This proves the signed uninstall boundary locally, not live GitHub
  transport, registration or webhook-secret provisioning.
- `rotateSigningKey({retirePrevious?})` tests overlap and retirement using ephemeral
  keys. `replaceAuthorizationContext({tenantId?,applicationId?,destinationId?})`
  changes trusted fixture config so cross-context replay can be tested.
- `setDeliveryMode(mode,{canary?})` supports `delivered`, `indeterminate`, `timeout`
  or `hold`; `setDeliveryIndeterminate()` is the shorthand. The canary is placed only
  in the private fake response so leakage detection can exercise an actual sink.
  `releaseDelivery()` resolves held attempts. `restart()` restarts workerd while
  preserving temporary SQLite state and the same fixture authority.
- `inspectReceipt(binding)` and `evidence()` inspect actual persisted rows. Evidence
  includes attempts, normalized outcomes, receipt snapshots, actual submission responses and evidence-binding emissions before
  normalization, captured Worker logs,
  denied outbound classifications, fake attempt ordinal/mode and allowlisted SDK
  versions. Queue/analytics sinks are **absent bindings**, declared under
  `capabilities`, not fabricated empty histories. Network attempts outside private
  bindings are denied and captured without URLs. No raw fake request is recorded.
  Evidence-binding headers have fixed expected values only; unknown names/values
  produce an `unexpectedHeaders` flag, never credential/header reflection.
  `probeCapture({submissionResponse?,sdkReport?})` poisons those same observer
  callbacks for negative oracle tests; it is not an HTTP control or telemetry sink.

## Receipt, revocation and privacy guarantees

Each `(application, submissionId)` routes to a secret-HMAC-derived DO. Raw IDs are
never stored. Each SQL row contains only an HMAC binding commitment, normalized state
and expiry time. The synchronous SQL admission persists `delivering` before the sole
private fake call; an active-instance marker handles concurrent replays. Startup
terminalizes any recovered `delivering` row as `indeterminate`. A timeout, exception
or unrecognized response also becomes `indeterminate`; no reminted capability,
replay, restart or alarm attempts delivery again within the 30-day window. Alarm
expiry deletes the receipt; IDs must never be reused for a new logical submission.

Indeterminate means **review required: the result is unknown, and explicitly
creating a new submission may duplicate an Issue**. The local result intentionally
contains no Issue URL/content. Any future activity UI is best effort; it must not
claim exactly-once delivery or complete activity. Manual migration from the current
public system remains an explicit customer action; this service imports no state.

Credential, application, tenant and installation checks fail closed on missing,
future or older-than-30-second authorization projections. They run at issuance,
ingress, private delivery and again in the receipt coordinator before its fake call.
Only the trusted local authority binding can supply projections. This is not evidence
of production invalidation acknowledgement, provider permissions or a real control
plane's ordering guarantees.

Requests and fake response content remain transient. No report content, request URL,
raw header/token, GitHub body/URL or end-user identity enters receipts, queues,
analytics, outcome responses or error objects. All operational rejections use fixed
codes. The HTTP bridge cannot access revocation/test controls. The log capture is a
local test oracle; the service emits no report-dependent logging.

## Official platform references checked 2026-09-16

- [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/):
  synchronous SQLite admission and no concurrency block across external I/O.
- [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
  output gates, explicit flush and durable rows.
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/):
  ECDSA P-256 and HMAC verification.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/):
  private bindings, bounded streams and generated binding types.
