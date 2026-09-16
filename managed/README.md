# Managed plane: Stage 0 local scaffold

This is a **non-production, non-deployable scaffold** of the approved 2026-09-16
account control-plane proposal. All HTTP requests except `GET /health` fail with `503 managed_not_ready`.
`GET /health` validates binding shape only: a 200 response still says `ready: false`.
It does not prove upstream availability, authorization freshness, or readiness.
The consumer has only a Queue handler and retries every batch, without reading its
body, until the configured DLQ limit. No managed event producer is implemented.

## Source contracts and implementation boundary

- Proposal: `bugdrop-web/docs/account-control-plane-data-layer-proposal.md`
  (provided worktree: `/Users/neonwatty/.codex/worktrees/c7c2/bugdrop-web`).
- SDK contract: `docs/protocol.md` in the provided
  `/Users/neonwatty/.codex/worktrees/sdk-control-plane-reconciliation` worktree.
- Separate managed GitHub App, signed-only ingress, service-bound delivery,
  separate metadata Queue consumer. No anonymous or current-public fallback.
- Capability issuance, canonical `bd_auth_v1` verification, exact origin/body digest
  checks, 30-second acknowledged revocation, rate limits, 30-day receipt state
  machine, outcome schemas, and database writes are **not implemented**. The SDK
  credential/origin/submission-binding fixtures must pass in the authoritative
  service before claiming protocol compatibility or enabling submissions.
- The Queue is for normalized content-free outcomes/lifecycle facts, never feedback
  payloads. Delivery is synchronous through the Service Binding, not through Queue.
- KV reserves operational config only; it is not sufficient for fresh revocation.
  The authorization DO reserves that coordination boundary but trusts no state yet.
  The receipt DO reserves at-most-once delivery but consumes no receipts yet.

## Resource and binding matrix

Every name below is local-only. None is an existing resource ID.

| Owner    | Binding/resource                                       | Stage 0 authority                                            | Future non-production requirement                         |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| ingress  | `bugdrop-managed-local-ingress`                        | No route, workers.dev or preview URL                         | Signed-only dedicated hostname                            |
| ingress  | `MANAGED_DELIVERY`                                     | Service Binding to `bugdrop-managed-local-delivery`          | Only managed ingress may call delivery                    |
| ingress  | `MANAGED_CONFIG`                                       | Local KV `local-only-managed-config`, remote disabled        | New dedicated operational-config namespace                |
| ingress  | `MANAGED_AUTHORIZATION` / `ManagedAuthorization`       | Own SQLite DO migration `managed-local-v1`                   | Fresh, acknowledged revocation coordination               |
| delivery | `bugdrop-managed-local-delivery`                       | No public endpoint                                           | Keep private; separate Managed GitHub App authority       |
| delivery | `MANAGED_RECEIPTS` / `ManagedReceipts`                 | Own SQLite DO migration `managed-local-v1`                   | 30-day at-most-once receipt state machine                 |
| delivery | `MANAGED_OUTCOMES`                                     | Producer binding to `bugdrop-managed-local-outcomes`, unused | Allowlisted normalized metadata only                      |
| consumer | `bugdrop-managed-local-consumer`                       | Queue handler only, no HTTP handler                          | Separate least-privileged database writer                 |
| consumer | `bugdrop-managed-local-outcomes`                       | 3 retries, 60-second delay                                   | Own managed Queue                                         |
| consumer | `bugdrop-managed-local-outcomes-dlq`                   | DLQ destination, no consumer                                 | Own managed DLQ, retention and alert/runbook              |
| all      | secrets, DB/Hyperdrive, rate-limit namespace, CI token | **Absent**                                                   | Separate provisioning and evidence required               |
| all      | account                                                | Invalid sentinel `STAGE_0_LOCAL_ONLY_NO_ACCOUNT`             | Deliberate replacement only in reviewed staging manifests |

The manifests have a closed test allowlist: added bindings, secrets, account IDs,
remote bindings, routes, environment overrides, public services/DOs, or missing DLQ
fail the isolation test. Public KV IDs from every environment in `wrangler.toml`
are injected individually to prove the test rejects them. The public configuration
must contain no managed reference. Existing public source/config/workflows remain
unchanged; no managed deployment workflow or token is introduced.

This proves the checked-in scaffold has no shared mutable resources or granted
secret/deployment authority. It does **not** establish the scope of existing account
administrators, shell credentials, or CI tokens. The invalid account is an accident
barrier, not a security sandbox: a privileged operator can override config. Separate
Workers within one account do not isolate account administrators or account quotas.
No staging deployment is authorized until the real token/account boundary is audited.

## Local validation

Run from the repository root:

```sh
npm ci --ignore-scripts
node managed/generate-types.mjs
npx vitest run test/managed
node managed/local-smoke.mjs
npm run validate
npx wrangler deploy --config managed/ingress.json --dry-run --outdir /tmp/bugdrop-managed-ingress
npx wrangler deploy --config managed/delivery.json --dry-run --outdir /tmp/bugdrop-managed-delivery
npx wrangler deploy --config managed/consumer.json --dry-run --outdir /tmp/bugdrop-managed-consumer
```

Compatibility is pinned to `2026-06-10`, the newest date supported by this
repository's locked workerd binary. A newer date fails local startup even though
Wrangler dry-run succeeds. Update it only with a separately reviewed runtime upgrade.

Generated binding types are module-scoped so three Workers cannot merge global
`Env` types. No package changes or deployment scripts are required. Only `--dry-run`
is allowed for this stage; never run the root `npm run deploy` for managed work.
Use a named `.localhost` host for local HTTP testing. The smoke runner requires
`bugdrop-managed.localhost` to resolve to loopback and permission to create local
sockets; restricted sandboxes may fail with `ENOTFOUND` or socket errors. It
uses Miniflare supplied by the locked Wrangler dependency, with temporary local
state only. It proves Service Binding and DO boot/refusal; actual Queue retry
exhaustion into a DLQ remains a non-production integration gate.

## Remaining provisioning steps — NOT EXECUTED

1. Approve non-production provisioning separately. Select the staging Cloudflare
   account and audit real token permissions. Use a separate account if independent
   deployment administration/quota authority is required; a differently named token
   with account-wide Workers edit permissions is insufficient proof of isolation.
2. Register a distinct non-production Managed BugDrop GitHub App and fresh
   installations. Do not copy public App keys, webhook secrets, installation IDs,
   selected repositories, or state. Keep the new private key in private delivery only.
3. Create staging manifests separately from these local manifests. Replace the
   sentinel account, local resource names and KV sentinel with audited staging values.
   Create the dedicated managed config KV, outcome Queue and its DLQ. Choose DLQ
   retention/alerts explicitly; unconsumed messages eventually expire.
4. Provision the ingress authorization and delivery receipt SQLite DO namespaces
   via their own Worker migrations. Allocate managed-only rate-limit resources and
   budgets before opening ingress. Implement and test authorization invalidation,
   stale-state rejection and the receipt state machine before accepting any work.
5. Provision non-production Postgres roles/functions and separate Hyperdrive bindings
   for least-privileged outcome/lifecycle ingestion. Never add database authority to
   public ingress or reuse public monitoring state. Add the private consumer writer,
   idempotency, deletion guards and content-free schemas before enabling production.
6. Provision managed-only API verifier pepper/capability signing material in the
   authoritative capability service and delivery-only Managed App private key,
   webhook secret and receipt-HMAC secret where their implementations require them.
   Verify no public Worker/CI path can access them. No secrets are required locally.
7. Create a separately protected managed deployment pipeline/environment with no
   public credentials or deployment targets. Deploy only after review: delivery/DO,
   Queue consumer, then ingress/DO and its service binding. Keep delivery and consumer
   `workers_dev: false`, `preview_urls: false`, and route-free. Configure a distinct
   managed webhook path with signature verification and no shared public secret.
8. After privacy approval and protocol/security evidence, add only the dedicated
   staging ingress route. Run cross-plane/token/tenant attacks, stale revocation,
   Queue/DB outage and DLQ tests, ambiguous GitHub outcome recovery, deletion/restore
   and privacy-canary tests. Verify endpoint exposure and actual resource/CI scopes
   from provider records. Health presence checks cannot substitute for this gate.

## Official configuration references checked 2026-09-16

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
  for separate manifests, services, KV/DO migrations, Queue fields and exposure flags.
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
  for private Worker invocation.
- [Queue JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
  for explicit retry instead of implicit acknowledgement.
- [Dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
  for retry exhaustion and retained messages' bounded lifetime.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  for generated types and binding-based boundaries. Automatic observability is
  deliberately disabled until metadata-only logging has privacy-canary evidence.
