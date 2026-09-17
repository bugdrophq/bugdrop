# Hosted staging coordinator

## Approved scope and observed resources

The manager approved the private `bugdrop-staging-dogfood` GitHub App and an empty,
private `bugdrophq/bugdrop-dogfood` repository on 2026-09-17. Read-only GitHub API
checks established organization ID `328837881` and operator `neonwatty` ID
`16326421`, with active organization administrator membership. The repository
was created and independently read back as private, empty, with issues enabled:
repository ID `1374924136`.

The staging App, installation, webhook credentials, and activation have not yet
been provisioned. Existing Apps and production resources are outside this scope.
The approved callback is
`https://managed-staging.bugdrop.dev/github/staging/webhook`. App permissions are
Issues write and Metadata read, selected repository only, without user OAuth.

Cloudflare account, DNS collision, and Workers Free plan checks were verified
read-only by the runtime owner. They authorize only isolated staging resources.
No owned alert destination or second operator identity has been supplied. These
are activation blockers; a source-code change cannot satisfy them.

## Private SQL transport

The fifth service, `bugdrop-managed-reconciliation-staging`, has no public route,
workers.dev endpoint, or preview URL. Its default fetch handler denies requests.
A named private entrypoint accepts only the existing authenticated
`/apply-verified-uninstall` contract. Configuration must bind a single verified
provider installation before any connection can be opened.

Use `pg` with Node compatibility through a dedicated private Hyperdrive binding
with caching disabled and `verify-full` plus the Supabase Root 2021 CA configured
at Hyperdrive. The manager approved one reconciliation configuration under the
existing free plan; no publisher Hyperdrive configuration or paid upgrade is
approved. Use a separate restricted reconciliation login. Do not use PostgREST,
`service_role`, or an administrator login.
Each invocation owns and closes its connection. The NOINHERIT login
`bugdrop_reconciliation_transport` uses `BEGIN` and
`SET LOCAL ROLE bugdrop_reconciliation`, calls only the parameterized
`private.apply_verified_uninstall`, then awaits `COMMIT` before returning a
receipt. The Worker connects only with the binding's per-invocation host/password;
Hyperdrive verifies the origin certificate and hostname. A disconnect or uncertain commit produces pending, never a
manufactured acknowledgement. Subsequent retries retain the original tuple.

Only SQLSTATE `23503` with the exact authoritative message `uninstall mapping
unavailable` becomes the signed mapping-missing quarantine result. Other errors
remain opaque pending failures. The existing reconciliation handler validates
the complete SQL receipt before returning a signature.

The initial direct TCP design was rejected after a real Workerd probe established
that native `startTls` ignores pg's `ca` and `rejectUnauthorized` options. Node
TLS tests did not establish Worker trust. The supported replacement uses
[Hyperdrive custom CA and verify-full](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
and its [pg binding integration](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/).
Supabase documents custom role pooler usernames and connection modes in its
[Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI).
Actual hosted binding TLS, role grants, and wrong-role denial still require live
verification before activation. A pg error listener also records asynchronous
socket errors independently of query rejection, withholding any later receipt.

The runtime owner created and read back the following isolated resources on
2026-09-17 under account `341a3846c29902f6363c151395932f5a`:

- Hyperdrive `bugdrop-reconciliation-staging`, ID
  `cd391593693a4a128fcd5caa80cf217a`, caching disabled, origin connection limit 5,
  `verify-full`, CA ID `2195ca15-9bd3-4fec-8e00-325cdb512de1`.
- CA `bugdrop-staging-supabase-ca`, SHA256 of DER
  `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.
- Origin `aws-0-us-west-1.pooler.supabase.com:5432`, database `postgres`, login
  `bugdrop_reconciliation_transport.xwvgzjmzjilkkofvmrat`.

The manifest binds that exact resource and keeps activation disabled. The private
Worker itself has not yet been deployed or qualified. To roll back, disable the
consumer binding first; delete only this Hyperdrive after confirming no consumers
remain, then remove the new CA only after confirming it has no remaining
references. The existing unrelated Gateway CA was not modified.

## Recovery agreement with the data owner

Proposed private SQL signature:

```sql
private.lookup_uninstall_recovery_mapping(expected_application uuid, provider_id text)
returns jsonb
```

Only the restricted recovery role may invoke it. Return exactly
`{applicationId, installationId}` from an existing, same-tenant authoritative
mapping, or null. Do not recreate deleted or expired mappings or extend retained
receipt lifetimes. The SQL lookup cannot assert provider removal.

The provider verifier must independently authenticate the GitHub App identity
and affirmative deleted-delivery evidence for the exact installation, then bind
that evidence and the lookup result to every existing `RecoveryExpectation`
field. A generic GitHub 404 is insufficient. The signed response retains the
original uninstall tuple, routing commitment, tombstone identity/time, fresh
challenge, generation, and recovery request ID. Missing evidence leaves recovery
unavailable. The primitive and provider verifier are not implemented by this
design document.

## Remaining independent deliverables

- Durable publisher operation over the data owner's existing exact-byte outbox
  contract, with separate login and independent receipt verification.
- Owned operator alert delivery with bounded, content-free durable retries.
- Source-attested remote acceptance collector: deployment observation, exclusive
  HTTP exchange counters, actual SDK version observations, real fault and native
  retention controls, and independently verified edge plus SQL uninstall receipt.
- GitHub App provisioning after hostname and cost checks, followed by scoped
  installation mapping and staged secret handoff.

No remote acceptance receipt is valid until all required real controls and
observers exist. The uninstall scenario's current hard failure remains intact.
