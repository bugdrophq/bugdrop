# GitHub staging dogfood: configuration and installation gate

This is a reviewed configuration proposal, not authorization to create resources.
The staging delivery module is not connected to the supported public Worker. Its
only intended caller is the private staging receipt service after durable
single-attempt admission. The Cloudflare task owns the binding wrapper, authority,
receipts, routes, configuration, and deployment controls.

## Exact choices awaiting approval

| Choice | Proposed value |
| --- | --- |
| Organization owner | `bugdrophq` (organization ID `328837881`) |
| App name/slug | `bugdrop-staging-dogfood`, private |
| Dedicated repository | `bugdrophq/bugdrop-dogfood`, private, empty dogfood repository |
| Homepage/hostname | `https://managed-staging.bugdrop.dev` |
| Webhook | `https://managed-staging.bugdrop.dev/github/staging/webhook` |
| OAuth callback | None; no user OAuth or authorization-on-install flow |
| Registration | Manual organization App registration using the proposed JSON as configuration |
| Permissions | Repository Issues: write; implicit Metadata: read; no organization permissions |
| Events | Automatic installation lifecycle events; no optional event subscriptions |

The [proposed manifest](github-staging-app.proposed.json) documents the exact App
settings. It is not submitted by any script. Manual creation avoids inventing a
manifest-conversion redirect service: a manifest registration flow additionally
needs a reviewed, secret-safe conversion endpoint and redirect URL. Do not add a
callback URL merely to make that flow proceed.

GitHub delivers `installation` and `installation_repositories` automatically; these
are not manually subscribable events. Only a valid signed `installation/deleted`
for the configured App, owner, and installation authorizes the durable uninstall
latch in this tranche. Other events cannot activate an installation. GitHub's
installation/token preflight also rejects suspended installations or excess
permissions before issue dispatch.

## Read-only discovery receipt (2026-09-17)

- Authenticated identity: `neonwatty`, ID `16326421` (`GET /user`).
- Organization: `bugdrophq`, ID `328837881` (`GET /orgs/bugdrophq`).
- Membership: `active`, role `admin` (`GET /orgs/bugdrophq/memberships/neonwatty`).
  GitHub documents organization owners as able to register and manage Apps.
  Registration was not attempted; organization/enterprise policy may still apply.
- `GET /repos/bugdrophq/bugdrop-dogfood`: HTTP 404. No repository was created;
  this records not-found/inaccessible, not a reservation of the name.
- Cloudflare owner reports control of the active `bugdrop.dev` zone and no Worker
  route/custom-domain collision for the proposed hostname. DNS-record read was
  forbidden, so DNS availability remains unverified until an authorized read.

The existing public App and existing test venues are not dogfood targets.
Do not reuse their credentials, installation, repositories, routes, or resources.

## After exact approval, before enabling delivery

1. Repeat read-only identity, organization ownership, App-name, repository, and DNS
   checks. Record exact immutable App, owner, installation, and repository IDs.
2. Create the dedicated private empty repository and private organization App only
   under the approved identities. Configure Issues write and automatic Metadata
   read only. Keep OAuth disabled. Enable only the approved staging webhook URL.
3. Install using **Only select repositories**, selecting the dedicated repository
   alone. Verify the installation owner, App ID/slug, repository ID/name, permission
   set, and selected-repository list independently through GitHub's API/UI.
4. Generate the App private key and a random webhook secret of at least 32 bytes.
   Transfer directly to the staging provider's secret bindings. Never use shell
   command arguments, committed files, chat, PR text, fixture payloads, or logs to
   transport their values. The client secret and user tokens are not needed.
5. Have the Cloudflare owner populate the reviewed staging-only configuration and
   generated binding wrapper. `enabled` must remain false until the complete target
   and secrets are available. The delivery helper accepts only an explicit staging
   configuration with `dedicatedDogfood: true` and exact positive immutable IDs.
6. Confirm the private GitHub delivery service has no public route. The public
   staging webhook must forward original bounded bytes and signature headers to
   the verifier. Before claiming end-to-end uninstall completion, require durable
   normalized intake followed by two independent acknowledgements: the permanent
   edge revocation latch and authoritative Supabase `apply_installation_event`
   plus cleanup. Edge acceptance alone is not completion. Missing installation
   mapping or a partial failure stays pending/quarantined for reconciliation.
   Reads cannot refresh authorization observation timestamps or clear the latch.
7. Run the remote safety gate with synthetic content only. Independently query the
   allowlisted repository to establish the before/after issue-count delta, rather
   than trusting a delivery response. Uninstall last; prove issuance and submission
   remain blocked after restart and signed stale control updates.

### Activation dependencies: lifecycle and control acknowledgement

The [closed cross-plane activation gates](../../managed/staging/README.md#closed-cross-plane-activation-gates)
define the shared runtime, publisher and lifecycle completion contract.

The private webhook now verifies GitHub and durably admits normalized work before
acknowledging intake. The [uninstall coordinator](../../managed/uninstall/README.md)
independently verifies a signed permanent edge latch receipt and the authoritative
SQL cleanup receipt. Only both mark completion; pending and quarantined work remain
recoverable across restart. A webhook 2xx is intake acknowledgement, not completion.
Real local Postgres/Workerd tests exercise these contracts. No hosted SQL transport,
remote collector or live provider completion has been configured or proved.

The wire installation identifier is GitHub's canonical positive decimal numeric
string. It is not the SQL installation row's internal UUID. Resolve the explicit
provider-to-row mapping at the authoritative database boundary; an unknown mapping
is pending/quarantined and cannot be treated as applied. Before SQL acknowledges
a revocation control update, require an authenticated receipt or private status
result written after durable sync, matching the application/key, exact sequence,
projection digest, configurationVersion and authorizationVersion. A lost
acknowledgement must be resolved by private status or an exact-byte retry returning
the same receipt without renewing observedAt. Altered bytes at the same sequence
must reject. The runtime now implements signed durable receipts, exact retries and
private status. A generic HTTP 200 or rejection response still cannot acknowledge
revocation; the publisher must verify the exact signed receipt before SQL ack.

Hosted activation also requires a trusted locked authoritative mapping/read and a
durable monotonic outbox with authorizationVersion, exact retry bytes and original
observedAt. The merged data-plane publisher contract now implements explicit
activation, the locked mapping, monotonic outbox and transactional cleanup fence.
Keep pending credentials SQL-only: publishing credentialActive:false is terminal
for that key. First positive publication requires committed activation, verified
installation eligibility, scoped verifier provisioning and secret-custody bootstrap
in a reviewed transaction/order. Hosted transport, verifier provisioning, custody
and a real collector remain activation gates; do not fabricate active flags, source
timestamps or acknowledgements from local tests.

The coordinator retains minimal keyed nonidentity operational commitments such as
eventHash and installationHash; control receipts carry projectionDigest.
Raw payloads, end-user identity and secrets remain forbidden. This allowance does
not widen the public submission or evidence schema. The private adapter calls the
data owner's merged `apply_verified_uninstall` contract, with provider-ID mapping
resolved inside SQL; no alternate database RPC is invented here.

Account sign-in is separate from Managed App installation. The account callback and
session flow has local simulated-provider tests; live GitHub sign-in has not been
run. Managed App user OAuth remains disabled, with no installation OAuth callback.

## Delivery and privacy boundary

The adapter validates the App installation and requests an installation token with
exactly one `repository_ids` entry and `issues: write`. It checks the granted token's
repository identity, private visibility and permissions. Tokens are opaque bounded
header values, including GitHub's longer stateless format. A server-trusted
authorization deadline is checked both before preflight and immediately before
the issue POST; a token-exchange delay cannot extend the 30-second authority age.
All upstream requests use the fixed GitHub API origin,
deny redirects, and have a bounded deadline. Issue creation is one POST; every
non-201 response, transport error, or timeout after dispatch is `indeterminate`.
There is no retry, result lookup, or Issue URL in an outcome. The durable receipt
owner must preserve `delivering`/`indeterminate` across restart and remint replay.

Only the transient bounded report body reaches the dedicated GitHub repository.
No reporter identity is extracted or added. Private keys, tokens, provider error
bodies, GitHub response content, and report-derived URLs are never logged or
returned. The outcome contains only its enum. A malicious provider response cannot
add fields to it. This does not establish privacy of provider-owned logs: remote
log/storage/analytics observation is a separate required gate, not an empty-array
claim derived from local fixtures.

## Rollback and cleanup

Disable staging ingress and delivery, persist installation revocation, then
uninstall the dedicated App. Revoke/delete staging secret bindings and App keys
through provider controls. Keep receipts until their documented expiry to prevent
replays; verify actual deletion after expiry rather than resetting the database.
An operator may delete synthetic issues and the dedicated App/repository only after
checking their exact IDs against the approval receipt. Preserve sanitized check
results and version IDs, never report bodies or credentials. These actions must
not touch the current public system.

## Sources

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Installation token scoping](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Installation events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation)
- [Webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
