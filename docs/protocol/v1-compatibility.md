# Protocol v1 compatibility harness

This first tranche is an executable, **test-only** service model under
`test/protocol/v1`. It adds no route, runtime import, Worker, binding, signing key,
or deployment configuration. Public widget and Worker behavior is unchanged.

## Source and drift

The approved account-control-plane proposal in `bugdrop-web`,
`docs/account-control-plane-data-layer-proposal.md` (2026-09-16), governs the
boundary. Wire details come from the SDK's `docs/protocol.md` and fixtures at
[SDK commit 2bfcfee](https://github.com/bugdrophq/bugdrop-sdk-typescript/tree/2bfcfee54200e981815ee6e12bcf5bf5c97d4add).
`test/protocol/v1/fixtures/upstream.json` records the source path, commit, and
SHA-256 of each byte-for-byte copy. The pin includes all six merged V1 fixtures:
credentials, origins, submission bindings, capability response, capability validation,
and widget public API. The first-tranche service model below consumes the first three;
the remaining fixtures support the coordinated local managed/packed-SDK integration.
Do not format or hand-edit copied fixtures.

```sh
npx vitest run test/protocol/v1
node scripts/protocol/check-fixture-drift.mjs /absolute/path/to/sdk-checkout
```

Normal unit CI checks the pinned hashes without network access. The second command
also compares every pinned fixture against a supplied SDK checkout; missing files,
changed bytes, or changed hashes fail closed. It does not fetch upstream or assert
that the pin is the latest SDK release. To update, review the SDK protocol changes,
copy the fixtures unchanged, update the commit and hashes, run the explicit drift
check, and review the changed vectors alongside the model. Coordinated SDK/managed
plane changes must run that check before claiming compatibility.

## Executable boundary

The suite consumes the SDK origin, credential, and submission-binding vectors.
It checks exact canonical origins against configured origins (including rejection
of trailing dots, case/default-port aliases, and different hosts/ports), required
stable submission IDs, canonical SHA-256 digest encoding, and hashing of exact
body bytes before delivery. It checks the credential derivation and strict bearer
parsing, captures the explicit SDK package version separately from contract
version, and rejects unknown exchange fields, including reporter identities.
Errors do not reflect rejected canaries.

The signed-only test double rejects authentication, binding, and delivery failures
without issuing a network request or retrying delivery. Authentication is an
injected verifier: the fixture bearer is not a real credential and its syntax is
not proof of authorization. The double is deliberately not connected to the
public widget or either Worker plane. Its no-fallback assertion applies only to
this model; actual SDK and managed-plane implementations require their own tests.

## Integration dependencies and limits

- [SDK reconciliation PR #12](https://github.com/bugdrophq/bugdrop-sdk-typescript/pull/12)
  owns the normative fixtures and SDK transport.
  Keep the pin synchronized with its reconciliation PR before integrated V1 claims.
- The separate managed-plane PR in `bugdrophq/bugdrop` owns isolated ingress,
  credential verification, signed-token verification, private delivery, and
  manifests. It must consume these same vectors against its actual implementation.
  This PR can land independently because it has no runtime integration.
- End-to-end publication remains blocked on the production-like SDK capability
  exchange and managed-plane checks: fixed algorithm/key/issuer/audience,
  tenant/application/destination/configuration binding, expiry, revocation,
  durable 30-day receipts, and at-most-once GitHub delivery. This harness proves
  none of those operational guarantees.
- The identity checks cover exchange fields and model errors. Opaque submission
  IDs cannot be proven unrelated to identity by syntax; customers must generate
  random logical-submission IDs. Real queues, storage, logs, analytics, GitHub
  payloads, and third-party services still need end-to-end privacy canaries.

Public regressions use existing `test/api.test.ts`, widget/flow unit suites, and
`e2e/public-flow.spec.ts`, `e2e/default-flow-compatibility.spec.ts`,
`e2e/legacy-compat.spec.ts`, and `e2e/api.spec.ts`. Run the local venue using
`bugdrop.localhost` and build the widget with `BUGDROP_TEST_HOOKS=1` first.
No production configuration, provisioning, deployment, or signed traffic is
required or authorized by this harness.
