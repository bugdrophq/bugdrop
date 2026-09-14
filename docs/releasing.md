# On-Demand Release Runbook

BugDrop releases only through an explicit operator dispatch of **Production Release**
(`.github/workflows/deploy.yml`) from `main`. There is no timer, push trigger, or commit-prefix version
selection. Choose `standard` for a normal manual release or `emergency` for an urgent manual release;
an emergency requires a bounded rationale. The normalized `releaseReason` remains part of request
identity, so retries must use the same reason and other identity-bearing inputs.

## Safety

- Treat production as disabled unless both `RELEASE_PRODUCTION_ENABLED` and
  `RELEASE_CLOUDFLARE_CAPABILITY_VALIDATED` are exactly `true` and the protected `production`
  environment grants approval. The repository does not enable those controls.
- Dispatch only from `main`, with a full lowercase SHA reachable from remote `main`. Never dispatch
  an unreviewed local commit, branch name, or abbreviated SHA.
- Use a dry run first. It does not enter the production environment or access production secrets.
- Never create, move, or delete a tag or Release to repair an uncertain run. Preserve artifacts and
  inspect authoritative GitHub and Cloudflare state before any further production command.
- `package.json` uses `0.0.0-development`; it is not release authority. The operator-selected bump is
  applied to the latest authenticated stable GitHub Release.

## Preparation

1. Update local `main`, record `git rev-parse origin/main`, and select the exact target SHA.
2. Confirm required CI/merge-queue checks succeeded for that target and review the complete change
   inventory since the latest published stable Release.
3. Choose `patch`, `minor`, or `major` from product compatibility, not commit prefixes.
4. Choose `standard`, or `emergency` with a rationale explaining urgency and approval context.
5. Choose `retention_bootstrap=false` for normal operation. Set it to `true` only for the separately
   authorized, one-time retention cutover; use the identical value for dry-run and live dispatch.
6. Keep operator notes bounded and free of secrets. Record the target SHA, bump, reason, rationale,
   retention bootstrap decision, and expected next tag in the release evidence log.
7. Confirm there is no in-progress release for the same production target. Concurrency queues rather
   than cancels runs, but an operator should still avoid creating ambiguous overlapping requests.

The commands below are examples for an authorized future operation. Replace placeholders; do not run
them as part of repository preparation.

## Dry Run

Dispatch from the GitHub Actions UI, or equivalently:

```bash
gh workflow run deploy.yml --ref main \
  -f target_sha=<40-character-main-sha> \
  -f bump=<patch|minor|major> \
  -f release_reason=<standard|emergency> \
  -f rationale='<required-for-emergency>' \
  -f operator_notes='<bounded-notes>' \
  -f retention_bootstrap=<true|false> \
  -f dry_run=true
```

Wait for `Complete mutation-free dry run`. Record the request identity, final plan identity, target,
next tag, workflow run URL, and `release-plan-<plan-key>` artifact. The expected terminal decision is
`dry-run-complete`. The summary must state that no production environment, secret, deployment, tag,
Release, or notification was accessed. A failed dry run is not approval to bypass a guard; correct
the request or candidate and create a new dry run.

## Live Release

Live execution is a separate explicit dispatch with `dry_run=false` and otherwise identical
identity-bearing inputs. Before dispatch, compare them with the accepted dry-run plan. The workflow
rebuilds and revalidates the plan; artifact or identity drift fails closed.

```bash
gh workflow run deploy.yml --ref main \
  -f target_sha=<same-40-character-main-sha> \
  -f bump=<same-bump> \
  -f release_reason=<same-standard-or-emergency> \
  -f rationale='<same-rationale>' \
  -f operator_notes='<same-notes>' \
  -f retention_bootstrap=<same-true-or-false> \
  -f dry_run=false
```

The capability gate must pass before the protected environment requests approval. Review the exact
plan identity and target at that approval boundary. After approval, the workflow captures the current
production baseline, deploys once, reconciles the result by inspection, runs production live tests,
publishes the authenticated tag and GitHub Release, sends a notification only for a newly published
plan, and always runs finalization after a mutation attempt.

## Terminal States

- `dry-run-complete`: immutable State 2 was assembled without production access.
- `core-noop` / completed-plan summary: the exact plan is already published; no build, approval,
  mutation, or automatic notification occurs.
- `published-stable`: publication is authenticated and live production matches the approved target.
- `baseline-restored`: no publication became authoritative and production already matches the
  captured baseline.
- `rollback-verified`: finalization restored and verified the exact captured baseline.
- `manual-recovery-required`, `unknown-critical`, a failed finalization gate, or missing outcome
  artifact: stop. Production or publication authority is not proven. Preserve all run artifacts and
  escalate with the evidence listed below.
- A failure before `approval-baseline` reports `proceed=true` has not authorized a production
  mutation. A failure after that point must be treated as a possible mutation even if a command
  reported failure or the job was cancelled.

Do not call a run successful from a green notification or an optimistic command response. The final
authoritative state and plan identity are the completion proof.

## Cancellation

Before protected approval, reject or cancel the run in GitHub Actions; no live mutation is authorized.
After approval or while a production job is running, cancellation is not a rollback mechanism. The
`finalize-cancelled` job runs with `always()` once approval recorded `proceed=true`, reinspects both
publication and production, and restores only the captured baseline when its safety conditions hold.
Wait for finalization and classify its exact status. If finalization cannot prove `published-stable`,
`baseline-restored`, or `rollback-verified`, follow manual recovery and do not dispatch again.

## Rollback

The workflow records the exact Cloudflare production baseline before mutation. If the candidate is
verified active but no exact Release is published, finalization may roll back only to that recorded
version, then verifies version ID, source identity, and asset identity. It never removes GitHub
publication state automatically. Once the exact Release is published, finalization requires the live
candidate to match it and will not roll production back behind published authority.

For `manual-recovery-required`, do not guess a version or run an ad hoc rollback. Compare the baseline,
deployment, publication, and live identity artifacts; obtain explicit incident authority; then use a
reviewed recovery action appropriate to the observed state. Preserve the failed run as evidence.

### Reset-and-replay recovery

Partial publication is not executable resume authority. The legacy `resume_controller_sha`,
`resume_remote_main_sha`, and `resume_plan_identity` workflow inputs remain only as compatibility
tombstones: any non-empty value is rejected by the first dispatch guard before checkout, planning,
environment access, or mutation. After preserving incident evidence, use a separately reviewed
reset-and-replay procedure to restore a pristine publication state. Only then dispatch a fresh release
with all three legacy resume inputs empty.

## Notification-Only Retry

Re-running the production release for an already published exact plan is a core no-op and deliberately
does not resend Discord. If publication succeeded but notification failed, use the separate **Discord
Release Notification** manual workflow. First dispatch it with the authenticated tag and plan identity,
`automatic=false`, and `dry_run=true`; inspect the rendered payload. An authorized retry uses the same
inputs with `dry_run=false`. This path reads the published GitHub Release before posting and does not
deploy, tag, publish a Release, or change the release plan.

```bash
gh workflow run discord-release.yml --ref main \
  -f tag=<published-vX.Y.Z> \
  -f release_plan_identity=<sha256:...> \
  -f automatic=false \
  -f dry_run=true
```

Record both the preview and authorized retry run URLs. Never use a notification retry to imply that
an unproven release completed.

## Evidence

Capture the workflow run URL and immutable controller SHA; target SHA; normalized dispatch fields;
request, content, and plan identities; selected and previous tags; protected approval record; and all
available 14-day workflow artifacts:

- `request-plan-<request-key>` and `release-plan-<plan-key>`
- `release-baseline-<plan-key>`
- `release-deployment-<plan-key>`
- `release-attestation-<plan-key>` (30-day portable bundle and verification receipt)
- `release-publication-<plan-key>`
- finalization status and GitHub job summary

For a completed live release, also record the GitHub Release URL and asset checksums, Cloudflare
version/build identity, production live-test result, `versions.json` digest, exact widget digest, and
notification outcome. For recovery, retain raw artifacts and record every observation separately from
every command attempted.

## Release provenance

A live release publishes seven assets. Six immutable content assets are provenance subjects: the
exact-version widget, `versions.json`, `request-plan.json`, `release-content.json`,
`final-release-plan.json`, and `checksums.sha256`. `attestation.intoto.jsonl` is the seventh,
evidence-only asset. It is intentionally outside the checksum and subject sets so the signed bundle
never refers to itself. Mutable Cloudflare aliases, retained historical files, rebuilt output, and
Actions artifact ZIPs are never attested.

After protected approval and successful production tests, the isolated `attest-release` job
materializes those six files directly from the exact State 2 artifact, creates one GitHub-hosted SLSA
provenance statement, verifies the portable bundle, and uploads it under an exact artifact ID. The
job has only `contents: read`, `id-token: write`, and `attestations: write`. The later publication job
has `contents: write` but no OIDC or attestation authority, downloads that exact artifact ID, repeats
verification, and publishes the same bytes. Dry runs and authenticated completed-plan no-ops cannot
reach the attestation job.

Run the following from a directory containing the seven downloaded Release assets. It hashes every
local subject byte (including `checksums.sha256` itself), verifies the checksum manifest, applies the
complete identity policy, requires exactly one matching signed statement, and compares its exact six
name/digest pairs with the local files:

```bash
set -euo pipefail

controller_sha=$(jq -er '.source.controllerSha | select(test("^[0-9a-f]{40}$"))' request-plan.json)
tag=$(jq -er '.tag | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' final-release-plan.json)
widget="widget.${tag}.js"
subjects=(
  checksums.sha256
  final-release-plan.json
  release-content.json
  request-plan.json
  versions.json
  "$widget"
)
for subject in "${subjects[@]}"; do test -f "$subject"; done
sha256sum -c checksums.sha256
LC_ALL=C sha256sum -- "${subjects[@]}" | LC_ALL=C sort -k2 > local-subjects.sha256

identity_policy=(
  --repo bugdrophq/bugdrop
  --signer-workflow bugdrophq/bugdrop/.github/workflows/deploy.yml
  --signer-digest "$controller_sha"
  --source-digest "$controller_sha"
  --source-ref refs/heads/main
  --cert-oidc-issuer https://token.actions.githubusercontent.com
  --deny-self-hosted-runners
)

assert_exact_attestation() {
  local result=$1
  jq -e '
    type == "array" and length == 1 and
    .[0].verificationResult.statement._type == "https://in-toto.io/Statement/v1" and
    .[0].verificationResult.statement.predicateType == "https://slsa.dev/provenance/v1" and
    (.[0].verificationResult.statement.subject | type == "array" and length == 6) and
    all(.[0].verificationResult.statement.subject[];
      (.name | type == "string") and
      (.digest | type == "object" and keys == ["sha256"]) and
      (.digest.sha256 | test("^[0-9a-f]{64}$")))
  ' "$result" >/dev/null
  jq -r '.[0].verificationResult.statement.subject[] |
    "\(.digest.sha256)  \(.name)"' "$result" |
    LC_ALL=C sort -k2 > "${result}.subjects.sha256"
  diff -u local-subjects.sha256 "${result}.subjects.sha256"
}

gh attestation verify "$widget" "${identity_policy[@]}" --format json > online-verification.json
assert_exact_attestation online-verification.json

# Still online: acquire current roots, then preserve these files through a trusted channel.
gh attestation trusted-root > trusted_root.jsonl
sha256sum trusted_root.jsonl > trusted_root.jsonl.sha256
```

Obtain the trusted root through a separately trusted online channel when the Release download itself
is under investigation. For genuinely offline verification, preserve the Release assets,
`local-subjects.sha256`, the function and identity variables from above, and the trusted-root files;
disconnect the verifier from the network; then run:

```bash
sha256sum -c trusted_root.jsonl.sha256
LC_ALL=C sha256sum -- "${subjects[@]}" | LC_ALL=C sort -k2 |
  diff -u local-subjects.sha256 -
gh attestation verify "$widget" \
  --bundle attestation.intoto.jsonl \
  --custom-trusted-root trusted_root.jsonl \
  "${identity_policy[@]}" \
  --format json > offline-verification.json
assert_exact_attestation offline-verification.json
```

Either procedure fails for zero or multiple matching attestations, missing or extra subjects,
name/digest disagreement, an unverified or changed local subject byte, an identity-policy mismatch,
or an invalid signature. A missing bundle, unexpected eighth Release asset, or one-byte change stops
publication. After the attestation rollout boundary, missing evidence or verifier failure becomes a
preinspection publication conflict: GitHub is not inspected because its publication evidence has not
been authenticated. Finalization still inspects the active Cloudflare candidate and restores and
verifies the captured production baseline. GitHub is re-inspected only when attestation authentication
succeeds and the publication-inspection path actually runs. Never delete, replace, or hand-repair a
partial Release; preserve its evidence and use the reviewed reset-and-replay procedure.

## Retention

GitHub Releases are the canonical durable release record. Workflow artifacts support short-lived
audit and recovery and currently retain for 14 days; export required evidence according to the
project's authorized audit process before expiry. The repository workflow now supports three
fail-closed retention states. It defaults to `disabled`; an explicitly authorized one-time
`retention_bootstrap` makes the candidate version the immutable boundary; later releases
automatically `continue` from the authenticated GitHub Release lineage. Planning authenticates each
supported Release and exact asset, the credential-free build consumes a request-keyed local handoff,
and State 2 plus preapproval verification hash the complete static tree. Missing or conflicting
history stops the release. Historical bytes before the boundary are never reconstructed.

No production boundary has been established by landing this code. Production cutover and live N/N+1
durability remain blocked until a separately authorized operator goal selects a bootstrap candidate
and later proves the retained exact bytes and digest in production.

Before an authenticated bootstrap Release is published, this repository feature can be rolled back
as one coherent unit. After bootstrap publication, retention-unaware rollback is forbidden: every
later implementation must read v2 authority, preserve the original boundary and complete supported
set, and pass the same installed N/N+1 and complete-tree checks. Production rollback remains the
existing restoration of the captured exact Cloudflare baseline; it never rebuilds historical bytes.
Repository tests prove only the offline installed boundaries, not a live deployment or durable URL.

## Cloudflare capability proof

Before setting `RELEASE_CLOUDFLARE_CAPABILITY_VALIDATED=true`, dispatch **Cloudflare Preview
Capability Drill** from `main` with two ordered full SHAs from `main`. The workflow shares the
`bugdrop-shared-preview` concurrency lock with merge-queue preview deployment. It captures the exact
preview baseline, builds release A and release B from separate immutable checkouts, requires B to
retain A's exact bytes, deploys A then B, treats B's command result as lost and reconciles it by live
inspection, rolls back to A, and finally restores and verifies the captured baseline. Never use the
production Worker for this proof.

The controller-pinned Wrangler 4.98.0 command shapes are `deployments status`, `deployments list`,
`versions list`, `versions view <version-id>`, `deploy <candidate-entrypoint> --assets
<candidate-assets> --var BUILD_SHA:<full-sha>`, and `rollback <version-id> --message <bounded-message>
--yes`. Every command also receives controller-owned `--config <absolute-wrangler.toml> --env
<preview|production>` and never receives `--name`. Commands run without a shell, with a two-minute
process timeout and an environment reduced to runner basics plus only the Cloudflare account and API
token.

Accepted deployment status JSON has one deployment `id`, `created_on`, `source`, `strategy`, and
exactly one `versions[]` entry at 100 percent with `version_id`. Accepted version JSON has matching
`id`, `metadata.created_on`, `metadata.source`, `resources.script.etag`, one optional full-SHA
`BUILD_SHA` binding, the `ASSETS` binding, and boolean asset runtime fields. Live reads have a
15-second request timeout and a bounded response size; convergence permits 30 two-second polls. The
workflow itself is bounded to 30 minutes.

The required evidence is the successful run URL and `cloudflare-preview-capability-<run-id>` artifact
showing A and B version IDs, B's retained A filename, `candidate-active` lost-response reconciliation,
bounded deployment/version list counts containing the active baseline, verified rollback, and
verified baseline restoration. If the artifact is absent, restoration is not
verified, or any field is ambiguous, leave both release gates false. Preserve the run, inspect the
captured baseline version ID, and perform only an explicitly authorized locked-controller rollback to
that ID followed by independent health, widget, and manifest hash verification; do not guess a
version or switch to an ad hoc Wrangler command.

## WP8 Boundary

This runbook documents repository behavior; it does not authorize production setup or prove a live
release. Enabling or inspecting environments, variables, secrets, Cloudflare credentials, approval
rules, notification credentials, or the two production gates—and performing any dry run, live run,
cutover, rollback, or notification—belongs to a separately authorized operator phase. Cutover is also
blocked on the separate operator authorization and live N/N+1 proof described above. Until that
evidence exists, production remains disabled and undispatched.
