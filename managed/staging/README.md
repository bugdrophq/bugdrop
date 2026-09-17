# Isolated managed staging runtime

This is a reviewed-configuration target, **not an active deployment**. The current
public Worker remains supported and unchanged. Four dedicated manifests have only
`env.staging`; their default environments have disabled names, closed routes and an
invalid account. All staging activation flags are false. No production environment,
public namespace, customer installation, SDK publication or provider secret is added.

## Read-only discovery, 2026-09-17

Wrangler 4.98.0 `whoami` reported one accessible account:
`341a3846c29902f6363c151395932f5a`. The read-only Zones API confirmed that account owns
active zone `bugdrop.dev` (`5d15a849d9de082786b4961502fcf68c`). It is a candidate,
not an approved staging target. Zone plan was `Free Website`; that does not establish
the Workers billing plan. Account subscriptions and DNS records reads returned 403.
The local DNS resolver returned SERVFAIL, but a follow-up Cloudflare DNS-over-HTTPS
lookup returned NXDOMAIN for A/AAAA/CNAME with the zone SOA. Public DNS therefore
shows the proposed host unused; the denied DNS-record API cannot exclude pending
provider configuration. No DNS, route, secret, subscription or Worker was mutated.

Proposed minimal host: **managed-staging.bugdrop.dev**. Capability issuance would use
`/v1/submission-capabilities`; a separately verified GitHub webhook would use
`/github/staging/webhook`. No OAuth callback is required for the proposed manual,
installation-only App registration. Private control, submission, authority and
receipt interfaces must never be exposed as public routes. Existing Worker routes
and custom domains showed no conflict, but authoritative DNS read remains a blocker.

SQLite Durable Objects are available on Workers Free and Paid plans. This design
requires no mandatory paid-only storage feature, but actual account entitlement,
usage headroom and spend limits remain unverified. Do not change the plan or create
cost-bearing resources without the explicit target/budget decision.

## Configuration and authority

| Manifest       | Proposed staging Worker           | Private authority                                                                                           |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| authority.json | bugdrop-managed-authority-staging | Dedicated StagingAuthorization SQLite namespace; signed control updates; scoped snapshot entrypoints        |
| ingress.json   | bugdrop-managed-ingress-staging   | V1 issuance; private StagingSubmission entrypoint                                                           |
| delivery.json  | bugdrop-managed-delivery-staging  | Dedicated StagingReceipt SQLite namespace; private StagingDelivery entrypoint                               |
| github.json    | bugdrop-managed-github-staging    | Private GitHub delivery adapter and signed uninstall entrypoint; disabled until exact dogfood targets exist |

The GitHub wrapper validates its provider target against fresh application/destination/
installation authority. The adapter verifies the exact App, selected installation,
private repository and Issues-only one-repository token; it follows no redirects and
never retries the Issue POST. The original full signed submission travels only over the private receipt-to-GitHub
binding. The wrapper verifies it against fresh authority initially and in a mandatory
callback after GitHub preflight; it never replaces signed claims with current configuration.
This is followed by the original source-time deadline check immediately before
Issue creation. A revocation or expired snapshot during preflight prevents creation.
The outer receipt timeout is 11 seconds, enclosing the adapter's 10-second limit;
local harness timeout remains one second. Ambiguous post-admission outcomes remain
indeterminate and unretryable. Known adapter preflight failure is conservatively
represented as indeterminate by the shared receipt adapter port.

The shared core implements V1 exact-origin and payload binding, ES256 capabilities,
30-second authorization age, 30-day receipt retention and at-most-once attempts.
Staging uses a separate token issuer/audience, provider keys and DO namespaces.
The local harness continues using its existing token realm and ephemeral fixtures.
The receipt port is typed by the methods it needs, allowing both isolated namespaces.

The staged scope is one explicitly configured application, credential and installation.
It does not implement a multi-application control-plane router. Tenant, destination,
key and installation identities cannot change inside an existing authorization scope.
Configuration changes require increasing configurationVersion; authority-state changes
require increasing authorizationVersion. Revoked credentials cannot be revived under
the same key ID. Installation revocation is permanently latched separately from the
snapshot, including before the first projection and across restart.

The data-plane migration `bugdrop-web/supabase/migrations/20260917144202_staging_account_configuration.sql`
adds nullable `canonical_origin` and tenant-authorized configuration versioning.
The publisher must map non-null `canonical_origin` to exact `origin`, preserve
`configuration_version`, and keep application/installation active flags false for
the current draft/disabled database model. It must not fabricate activation, verifier
storage, sequence, authorizationVersion or observation timestamps. Those lifecycle
and publisher capabilities remain explicit activation prerequisites.

The publisher must join the SQL internal installation UUID to `github_installation_id`
and serialize that provider numeric ID as `projection.installationId`. SQL lifecycle
commands retain the internal UUID; they must not receive the edge provider ID instead.
Do not publish a pending credential as `credentialActive:false`: false is terminal for
that edge key identity. Publication begins only after explicit activation is implemented
and acknowledged; its transaction/ordering and bootstrap remain unimplemented gates.

Webhook acknowledgement currently proves only the durable edge revocation latch.
A separate authoritative reconciliation adapter must call the Supabase installation
event/cleanup contract using the verified provider-to-internal mapping, retry safely,
and record acknowledgement without clearing the edge latch. It is not implemented or
configured here, and hosted activation stays blocked until it is reviewed and tested.
This tranche does not add OAuth PKCE; operator OAuth must remain disabled until its
separate callback/session flow is implemented and approved.

Control and data are separate: a private control publisher is responsible for mapping
the authoritative database transaction into the schema below. Its remote transport,
periodic refresh, revocation acknowledgement and provider-secret custody bootstrap
remain activation blockers; this runtime does not pretend that reads are acknowledgements.

## Private control contract

Only an explicit binding to `StagingControl` can reach POST `/projection` and
`/revoke-installation`. These are private service interfaces, not SDK HTTP contracts.
The header `X-BugDrop-Control-Signature` is canonical base64url HMAC-SHA256 over the
exact raw UTF-8 request body, using `STAGING_CONTROL_HMAC_KEY` for projections and the distinct
`STAGING_UNINSTALL_HMAC_KEY` for uninstall latches (32 random bytes each, base64url). Unknown fields, more than 8192 bytes, invalid signature and malformed
values fail with fixed errors and no reflection.

Projection body:

```text
{schemaVersion:1, sequence:positiveSafeInteger, projection:{
 tenantId, applicationId, destinationId, installationId, keyId,
 configurationVersion, authorizationVersion, origin,
 credentialActive, applicationActive, installationActive, tenantActive, observedAt
}}
```

IDs are bounded operational strings. `origin` must equal its canonical URL origin
serialization and cannot have a trailing dot. `observedAt` is authoritative source
observation time in Unix milliseconds, never a delivery/read timestamp. A future
observation or age over 30 seconds is rejected. Sequence, time and versions cannot
regress; repeated sequence is rejected. Compare-and-store happens synchronously after
signature verification, and acceptance follows durable storage sync.

Revocation body: `{schemaVersion:1, installationId}`. Only the separately verified
Managed App webhook authority may sign this after verifying the real raw GitHub HMAC
and matching the exact allowed App/installation/repository context. Repeated valid
revocation is idempotent. No later projection clears the installation latch. The public staging webhook path
forwards to a private GithubWebhook binding, which verifies the exact raw GitHub
signature and App/installation owner before signing the distinct uninstall latch.

Snapshots contain operational configuration only. Provider signing keys, HMAC keys
and verifier are never written to the authorization DO. IssuerAuthority receives
private signing material and verifier pepper but no receipt HMAC key; DeliveryAuthority
receives public signing keys and receipt HMAC but no private key or verifier pepper.
These entrypoints have no public fetch equivalent.

## Secrets and observability

Provision only through provider secret storage after target approval, using
`wrangler secret put <NAME> --config managed/staging/authority.json --env staging`.
Never put secret values in command arguments, docs, fixtures, configuration or logs.
Required names on authority:

- STAGING_CONTROL_HMAC_KEY
- STAGING_UNINSTALL_HMAC_KEY
- STAGING_AUTH_PEPPER
- STAGING_AUTH_VERIFIER
- STAGING_RECEIPT_HMAC_KEY
- STAGING_SIGNING_KEYSET

GitHub-only secret names are `STAGING_GITHUB_PRIVATE_KEY` (Managed App PEM),
`STAGING_GITHUB_WEBHOOK_SECRET` and the shared `STAGING_UNINSTALL_HMAC_KEY`.
Ingress has no secrets. `STAGING_GITHUB_TARGET_JSON` is non-secret reviewed config:
`{schemaVersion:1,environment:"staging",enabled:true,dedicatedDogfood:true,appId,appSlug,installationId,owner,ownerId,repository,repositoryId}`.
Its checked-in value is `{}` and delivery activation is false. Exact application and
destination IDs must also match the trusted projection. No target comes from a report.

HMAC keys are independent 32-byte random base64url values. Verifier is the 32-byte
HMAC of the derived auth secret under the pepper. The keyset secret is
`{activeKid,keys:[{kid,publicKey,privateKey?,notBefore,verifyUntil}]}`, with EC P-256
JWKs and Unix millisecond validity windows. Rotation retains old verification keys
through outstanding capability expiry; never rotate the receipt routing key in place
while receipts are retained. Export no root API key to these Workers.

Invocation logs are disabled because they include URLs; traces are disabled.
Only explicit content-free operational logs could be emitted. Current handlers emit
none. No analytics, queue, database, end-user identity or public-resource bindings
are present. Local test observers capture actual logs and denied egress and are not
product analytics. Product analytics remains session-only in its own product layer.

## Reproduce and verify

```sh
node managed/generate-types.mjs
node managed/staging/check.mjs
npx vitest run test/managed/staging-runtime.test.ts test/managed/staging-isolation.test.ts
npm run validate
make check
```

`make check` runs the four isolated dry runs in CI with no Cloudflare token inherited.
The script cannot deploy: it always supplies `--dry-run --env staging` with the named
staging manifest. Generated types come from the installed schema and use string
variables so provider overrides are checked at runtime. Compatibility stays at
2026-06-10, the newest date supported by the locked workerd; upgrade the runtime and
date together in a separate reviewed change. A newer dry-run date alone is not proof
that the pinned local runtime supports it.

`test-adapter.mjs` runs the actual staging sources on temporary local Miniflare
storage with fresh ephemeral test keys and fake delivery. It is **not** a remote SDK
conformance provider. All local URLs use named `.localhost` domains. The remote
provider, target observation digest and per-scenario isolation are separate gates.

## Activation, rollback and cleanup

Before any external mutation, record the exact approved account, hostname, Worker
names, dedicated Managed GitHub App/installation, allowlisted dogfood repository ID,
Supabase project and budget. Recheck read-only ownership/DNS/routes and provider
permissions. Resolve the publisher/acknowledgement and remote conformance gates.
A reviewed change must replace the sentinel and set the exact route and activation
flags; editing the root public `wrangler.toml` or deploying its default environment
is never a managed-staging step.

For a later authorized rollout, deploy private dependencies first, provision only
their declared provider secrets, then deploy ingress last with its approved staging
route. Real GitHub delivery remains disabled until the separate App and one-repository
allowlist have been verified and late-preflight authorization expiry has been tested.

Rollback closes the staging ingress route and disables staging delivery first. Use
`wrangler versions list --config managed/staging/<role>.json --env staging` to record
versions, then `wrangler rollback <version> --config managed/staging/<role>.json --env staging`
only for an explicitly verified staging target. Code rollback cannot erase uninstall
latches, downgrade monotonic projection state or reconstruct deleted receipts. Keep
receipt namespaces and their routing HMAC key for the full retention window: deleting
or recreating them can permit duplicate delivery. Cleanup therefore requires a separate
explicit data-retention decision, not merely deleting all staging resources. Never
reuse a submission ID for a new logical report.

## References checked 2026-09-17

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Wrangler configuration and environments](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Durable Object environment isolation](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [SQLite storage and durability](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Provider secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Invocation logs and URLs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [SQLite Durable Objects plans/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
