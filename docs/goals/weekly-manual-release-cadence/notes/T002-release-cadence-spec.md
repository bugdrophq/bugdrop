# BugDrop Weekly Manual Release Specification

Status: Proposed for implementation planning

Repository snapshot: `mean-weasel/bugdrop@12b139c49b157a0decf5570c723fe2935149e5f4`

Specification scope: release policy and target behavior; no implementation is performed by this document

## Problem

BugDrop currently treats every push to `main` as both a release opportunity and a production deployment. Conventional commit text determines whether semantic-release creates a version, but deployment runs after semantic-release even when no version is created. Release publication and production deployment happen before the workflow's live-production verification.

This creates four owner-visible problems:

1. A partially merged pull-request stack can be released as soon as one release-worthy commit reaches `main`.
2. Maintainers cannot choose a release window independently of merge timing.
3. A red workflow does not reliably mean that publication or deployment did not happen.
4. The documented exact-version widget contract is not durable: prior exact assets disappear after a later deployment.

The goal is not merely to replace `push` with `workflow_dispatch`. The goal is a release system in which timing, source, version, approval, effects, retries, and recovery are all explicit and observable.

### Terminology

- **Merge**: admission of a commit to `main` after the existing merge-queue checks.
- **Candidate**: one immutable 40-character commit SHA in the ancestry of GitHub `main` selected for possible release.
- **Request plan**: the pre-build, read-only result that binds the candidate, previous release, next version, included changes, notes, and expected artifact names.
- **Release plan**: the post-verification immutable result that binds one request plan to the hashes and provenance of the artifacts that were actually built and verified.
- **Core release**: production deployment, production verification, immutable tag, and published GitHub Release for one candidate/version pair.
- **Notification**: the Discord announcement after core release success. It is recoverable communication, not part of the core release transaction.
- **Weekly release**: the normal operator cadence. It is a human process, not an automatic cron publication.
- **Emergency release**: an out-of-cadence invocation of the same guarded workflow and policy.

## Outcomes

The implemented release system must make the following statements true:

1. Merging to `main` never publishes a version and never deploys production.
2. A core release can begin only from an explicit manual dispatch and a protected production approval.
3. The source is an immutable, reviewed SHA from `main` history, not whichever commit is at the branch tip when a later job starts.
4. The version is an explicit human SemVer decision, calculated deterministically from the previous stable release without semantic commit analysis, except that an exact completed request is recognized before that now-advanced frontier is recalculated.
5. One release plan has at most one source SHA and one version, and a version can never be rebound to another SHA.
6. Preflight failure has no production, tag, release, or notification side effects.
7. Production verification proves both deployed Worker source identity and deployed widget bytes.
8. A failed provisional deployment is rolled back and is not advertised as a published release.
9. A retry resumes or safely no-ops; it never increments, republishes, redeploys, or renotifies accidentally.
10. Exact widget URLs released after cutover remain immutable and available after later releases.
11. GitHub Releases become the canonical public release history; repository metadata no longer pretends that `package.json` or the stale hand-maintained changelog is current release authority.
12. Existing merge-queue preview CI, daily live monitoring, and path-filtered docs synchronization remain operational and independent.

### Audience

- Maintainers deciding when and what to release.
- Reviewers approving a production release candidate.
- Engineers implementing and testing release automation.
- Operators recovering a failed or partially completed release.
- Widget consumers relying on latest, major, minor, or exact URLs.

## Current State Evidence

The following are verified facts at the repository snapshot, not target-state proposals.

### Trigger and job ordering

- `.github/workflows/deploy.yml:8-10` triggers on every push to `main`.
- Its dependency chain is `semantic-release -> Cloudflare deploy -> live production tests`.
- The release job has `contents`, `issues`, and `pull-requests` write permission.
- The production deploy job has no GitHub Environment and no concurrency group.
- GitHub's repository API reported zero configured environments.

### Release and version behavior

- `.releaserc.json` explicitly enables commit analysis, release-note generation, and GitHub publication only.
- No npm, changelog, or git-prepare semantic-release plugin is active.
- `package.json` says `1.14.0`, the hand-maintained `CHANGELOG.md` stops at `1.11.0`, and live production reported `1.55.0` during validation.
- `scripts/build-widget.js` accepts `VERSION` or falls back to `package.json`, then emits only current latest, major, minor, and exact files.
- Generated widget files and `versions.json` are gitignored.

### Observed failure semantics

- [Run 30724408445](https://github.com/mean-weasel/bugdrop/actions/runs/30724408445) logged “no relevant changes,” then built the current source as the previous version and deployed a new Cloudflare Worker version. A non-release push therefore still deploys.
- [Run 30765978738](https://github.com/mean-weasel/bugdrop/actions/runs/30765978738) published `v1.55.0` and successfully deployed production before live E2E failed. Its overall result is red after public effects occurred.
- The two preceding production workflows had the same publish/deploy-before-live-failure shape.
- The repository had 121 published releases, 96 since April 1, 25 calendar days with multiple releases, and as many as 12 releases in one day.

### Production identity and retention

- Production `/api/health` reported `environment: development` and no `buildSha`.
- Preview CI already deploys with `BUILD_SHA` and polls for the exact preview environment and SHA.
- Production `versions.json` reported `1.55.0` during validation.
- `widget.v1.55.0.js` returned 200, while `widget.v1.54.1.js`, `widget.v1.54.0.js`, `widget.v1.53.1.js`, and `widget.v1.1.0.js` returned 404.
- `CHANGELOG.md` nevertheless describes exact URLs as the strict-control option.

### Notification and independent workflows

- `.github/workflows/discord-release.yml` listens for `release.published` and supports a separate manual dispatch.
- GitHub states that events caused by `GITHUB_TOKEN` do not normally create another workflow run; only one recent release-event Discord run was present. The target system must not rely on a release event caused by its own `GITHUB_TOKEN`. See [GitHub's `GITHUB_TOKEN` event rules](https://docs.github.com/en/actions/concepts/security/github_token).
- `.github/workflows/sync-docs.yml` independently synchronizes `docs/website/**` on main pushes. It does not require production release coupling.
- `.github/workflows/ci.yml` owns merge-queue preview deployment and candidate checks. Its preview behavior must remain independent.

## Release Policy

### RP-01: manual authority, weekly cadence

The production release workflow must have `workflow_dispatch` as its only event trigger. It must not declare `push`, `pull_request`, `merge_group`, `release`, or `schedule` triggers.

“Weekly” is the normal operator ritual: a maintainer prepares one candidate during the agreed weekly window. A reminder may exist outside the release workflow, but no timer may tag, publish, deploy, or notify.

An emergency release uses the same workflow, checks, approval, concurrency, and recovery. It differs only by a required `release_reason=emergency` input and a non-empty operator rationale recorded in the workflow summary and GitHub Release notes.

### RP-02: dispatch inputs

The manual workflow requires:

- `target_sha`: exactly 40 lowercase hexadecimal characters.
- `bump`: a choice of `patch`, `minor`, or `major`.
- `release_reason`: a choice of `weekly` or `emergency`.
- `rationale`: required non-whitespace text for emergencies and optional text for weekly releases.
- `dry_run`: boolean, default `true` for initial rollout and later changed to `false` only after the cutover proof is accepted.
- `notes`: optional bounded text appended to generated notes; it cannot replace the generated compare/PR inventory.

The operator chooses the SemVer impact through `bump`. Commit prefixes no longer grant release authority or choose the version.

### RP-03: dispatch ref guard

GitHub's manual-run UI lets an operator choose a branch, and its API accepts a `ref`. See [GitHub's manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui).

The workflow must fail before checkout of release source or access to production secrets unless its workflow ref is exactly `refs/heads/main`. The workflow definition is therefore always taken from protected `main`; a feature branch cannot alter and run its own release logic.

This ref guard does not define the released source. `target_sha` defines the released source.

### RP-04: operator and approver authority

Dispatch requires GitHub write access. Production-mutating jobs must additionally reference a `production` GitHub Environment with:

- selected deployment branch `main` only;
- required reviewer protection;
- environment-scoped Cloudflare credentials and Discord webhook access where used;
- administrative bypass disabled;
- self-review prevention enabled when at least two eligible maintainers exist.

If the repository has only one eligible maintainer, the owner may explicitly configure self-review as a documented operational exception. The workflow summary must still present the complete immutable plan before approval, and the dispatch plus environment approval remain two distinct actions.

GitHub environments can gate jobs, restrict branches, and withhold secrets until approval. See [GitHub's environment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

### RP-05: one serialized production lane

Every core release invocation must use one repository-wide concurrency group, `bugdrop-production-release`, with in-progress cancellation disabled and queued runs preserved.

Concurrency serialization does not establish release order by itself. Each run must revalidate the latest published version and existing tag state after entering the serialized, approved mutation job. A queued plan that became stale must stop and require a new dry run; it must not silently recalculate a different version.

GitHub documents both single-running concurrency and queued pending runs. See [GitHub's concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

### RP-06: least privilege

Workflow-level permissions default to `contents: read`. Planning, build, and verification jobs remain read-only. Only the publication job receives `contents: write`, and only after production verification. Issue and pull-request write permissions are removed unless an implementation proves a necessary behavior that cannot be achieved with generated notes alone.

Cloudflare and Discord credentials live in the protected environment or another least-privilege environment appropriate to their job. No secret is available to dry-run, planning, or candidate-build jobs.

## Release Candidate

### RC-01: immutable source validation

Before building, the workflow must fetch full history and tags and prove all of the following:

1. `target_sha` exists as a commit.
2. The exact commit is reachable from the current remote `main`.
3. The tag belonging to the previous published stable GitHub Release is an ancestor of `target_sha`.
4. `target_sha` is strictly later than the previous release; an empty compare is a no-op error.
5. No later stable release already contains `target_sha`.
6. The candidate's required merge-queue checks are present and successful, or an explicitly equivalent release preflight suite is successful.

A target may be an earlier ancestor of the current `main` tip. This permits a maintainer to release the last known releasable main commit when newer main work is intentionally held. The workflow must prominently report excluded newer main commits so approval cannot mistake the candidate for the current tip.

The workflow must never accept a pull-request head, merge-group pseudo-ref, arbitrary branch head, abbreviated SHA, tag name, or mutable symbolic ref as release source.

### RC-02: release-readiness attestation

Manual timing alone is not release readiness. The pre-build request plan must list:

- previous release tag and SHA;
- candidate SHA and commit timestamp;
- current `main` SHA at planning time;
- whether the candidate is behind current `main` and by how many commits;
- every merged pull request and first-line commit message in the compare range;
- changed top-level paths;
- computed next version;
- generated release notes and optional operator notes;
- expected mutable aliases and exact asset name;
- planned verification commands and expected artifact names;
- release reason and rationale.

After State 2, the finalized release plan adds the verification results, widget/static hashes, manifest hash, Worker source-tree/lockfile digest, provenance hash, and release-plan identity. Approval is an explicit attestation to that finalized release plan: the entire compare range is coherent, stacked work included in the candidate is complete, intentionally excluded main commits are acceptable, the bump is correct, the verified hashes and provenance identify the intended candidate, and the release window is authorized.

Feature flags or merge discipline remain the preferred protection against unreleasable intermediate states on `main`; release automation cannot infer product completeness from commit topology.

### RC-03: deterministic version calculation

Before calculating the published release frontier or a next version, the workflow performs a read-only **completed-plan lookup**. After validating the dispatch syntax, workflow ref, and exact target commit's reachability from remote `main`, it inventories authoritative published stable GitHub Releases and their resolved refs. It first searches for a Release targeted exactly at `target_sha`; only if none exists does it check whether a later published Release target already contains `target_sha` in its ancestry. Tags or drafts without a published Release remain partial-publication evidence handled below and can never prove completion.

A published Release proves an exact completed request only when all of the following hold:

1. It is the unique published stable Release for `target_sha`, and its tag resolves to that SHA.
2. Its machine-readable identity marker agrees with its downloaded canonical release content payload, final release plan, and checksums; recomputing the canonical payload SHA-256 reproduces the stored release-plan identity, and every required release asset name and hash agrees with those records.
3. The stored request identity and normalized original request fields exactly match the current repository, workflow ref, `target_sha`, `bump`, `release_reason`, rationale, and operator notes. `dry_run` remains an execution control rather than release content and does not change this comparison.
4. The stored previous tag, selected version/tag, generated notes, artifact identities, and protocol versions are internally consistent with that published Release. The lookup uses these stored values to authenticate the already completed plan; it does not recalculate them from the now-advanced frontier.

An exact match is a **post-success core no-op** before checkout, build, production approval, secret access, or any mutation. The run records the matched release URL, tag, target, request identity, and release-plan identity in its own audit summary, then exits core release successfully. It performs no deployment, tag creation, Release creation or edit, asset upload, rollback, or automatic notification. A failed or omitted prior announcement may be retried only through the explicit notification-only path.

If a published Release exists at the same target but any input or authenticated content differs, is missing, is ambiguous, or is inconsistent, the workflow fails closed; one source SHA may not acquire another version or release plan. If no exact-target Release exists but a later published Release already contains the target, the request is **already contained** and fails the no-op-range check without calculating a new version. Only a target with neither an exact published Release nor containment by a later published Release may proceed to frontier calculation. Thus the completed-plan lookup cannot weaken no-op-range rejection or treat a merely similar request as completed.

The **published release frontier** is the highest SemVer GitHub Release that is published (not a draft or prerelease), has a valid stable `vMAJOR.MINOR.PATCH` tag, has a tag/ref that resolves to the Release's target commit, and is reachable from `target_sha`. It is determined from authoritative GitHub Release and ref state, not merely the newest local tag or `git describe` output. Historical published Releases may retain their existing lightweight tags.

An otherwise stable tag without a matching published Release, or a matching draft Release, is a detected partial-publication state and does not advance the published release frontier. Planning must inventory stable tags, published Releases, and drafts separately so it cannot mistake a tag-only failure for a completed release.

The selected bump produces exactly:

- patch: `vM.m.(p+1)`;
- minor: `vM.(m+1).0`;
- major: `v(M+1).0.0`.

The helper must reject malformed, prerelease, build-metadata, duplicate, unreachable, or conflicting published releases/tags. The computed next tag must not already exist unless it points to the same target and, for a tag created by this workflow, its annotated tag message contains the exact versioned release-plan identity marker required by State 6. A pre-existing lightweight tag without a matching published Release, an annotation mismatch, a tag at another SHA, or an unrelated draft fails closed. It must never cause the workflow to silently increment to a later version.

Planning produces a stable **request identity** derived from repository, workflow ref, target SHA, previous tag, next tag, bump, release reason, rationale, generated notes, and operator notes. It deliberately excludes artifact hashes because no release artifact exists yet.

After candidate verification, the workflow produces a canonical deterministic **release content payload**. It contains the request identity; widget/static-artifact and versions-manifest hashes; Worker source-tree, lockfile, Wrangler-version, and deployment-configuration digests; and the versioned verification-contract identifier with its deterministic pass/fail result. The payload uses a specified canonical serialization (stable field names and ordering, normalized text, and no implicit current time). It expressly excludes its own hash and every execution-specific value, including GitHub run ID/attempt, artifact IDs or expiry, approval actor/time, job timing, deployment observations, Cloudflare result IDs, publication/notification results, and recovery results.

The immutable **release-plan identity** is the SHA-256 of those canonical payload bytes. It is neither self-referential nor derived from an execution/audit document. The final release plan contains the canonical payload and its identity. Production approval must display and approve that finalized identity, its content fields, and its hashes. Jobs exchange these recorded outputs rather than recalculating them from mutable repository state.

Every run or rerun also maintains a separate append-only **audit envelope** that references the release-plan identity and records execution-specific evidence: GitHub run ID/attempt, artifact IDs and retention state, verification logs, approval result, observed production baseline and deployment, publication, notification, cancellation, and recovery outcomes. The audit envelope is required provenance but never changes the release-plan identity. A resumed plan therefore retains one deterministic content identity while each execution remains independently attributable.

The request identity is useful for detecting repeated requests; it is not sufficient authority to mutate production. Only a finalized release-plan identity may enter production approval or mutation.

### RC-04: notes

Release notes are generated from merged pull requests and the compare range rather than relying on conventional commit prefixes. A repository release-notes configuration may categorize or exclude PRs, but the workflow summary always includes an unfiltered compare link and complete included PR list.

Operator-supplied notes are appended under an “Operator notes” heading. Emergency rationale is included under an “Emergency release” heading. Generated provenance includes the exact target SHA and artifact SHA-256.

## Release Lifecycle

The core workflow is a state machine. The completed-plan lookup is a pre-State-1 terminal guard: an authenticated exact completed request exits as a core no-op, while a conflict or already-contained target fails closed. States 1 and 2 are joined by the request identity. A later state may be entered only when the prior state's evidence exists for the same finalized release-plan identity.

### State 1: planned

After the completed-plan lookup determines that the request is neither completed nor disallowed, the workflow validates the remaining pre-build portions of RP-02, RP-03, and RC-01 through RC-04. It writes the proposed request plan and request identity to the GitHub Actions job summary and uploads a machine-readable request-plan artifact.

This state does not claim candidate verification or artifact hashes. Both dry-run and live invocations continue to State 2.

### State 2: candidate verified

The workflow checks out `target_sha`, installs the lockfile exactly, and runs release-focused verification. At minimum this includes:

- existing repository check suites relevant to workflow validity;
- legacy compatibility provenance verification;
- unit tests;
- TypeScript builds;
- a production widget build with the explicit planned version;
- an assertion that production test hooks are absent;
- SHA-256 generation for every release artifact;
- confirmation that successful required merge-queue checks cover the candidate.

The verified widget/static artifact set, versions manifest, request plan, final release plan, hashes, and current audit envelope are uploaded once and used downstream. The final release plan binds the request identity to the deterministic release content payload and release-plan identity. The separate audit envelope binds this run's verification evidence and artifact records to that identity.

The build-once promotion guarantee applies to widget/static release bytes: mutation jobs must not rebuild those bytes. The current Wrangler deployment model bundles the Worker during deploy, so this specification does not claim binary equality between a preflight Worker build and the deployed Worker. Candidate verification must build/check the Worker from the exact target checkout and lockfile. Production deployment must use the installed, pinned Wrangler toolchain against that same immutable source and lockfile, without source mutation, and must record the source/lockfile digest plus `BUILD_SHA`. The implementation must validate the installed Wrangler version's exact capabilities; it may strengthen this to prebuilt Worker-artifact promotion only if a supported mechanism is proven and tested.

`dry_run=true` stops successfully after this state. It never references the production environment, reads production secrets, or performs an external mutation. Its final summary contains the same finalized release-plan identity, artifact hashes, and verification evidence that a live run would present for approval.

### State 3: approved and revalidated

The production mutation job enters the serialized concurrency lane and waits on the protected `production` environment. The approval view must identify the finalized release-plan identity and artifact hashes, not merely the pre-build request. After approval and before using secrets, it re-fetches remote tags/releases and proves that the plan remains current. This revalidation repeats the completed-plan lookup before consulting the advanced frontier: if a concurrent run published the exact authenticated plan, this run exits as the same post-success core no-op with no automatic notification; a same-target mismatch or merely already-contained target fails closed.

If another release changed the previous-version frontier, if the planned version now belongs to another SHA, or if the candidate is no longer reachable from `main`, the run stops before mutation. It does not rebase, recalculate, or bump in place.

### State 4: provisionally deployed

Before deployment the workflow records an authoritative rollback baseline: the currently active Cloudflare deployment/version ID, previously published BugDrop tag, live widget and manifest hashes, current aliases, and live health response. The first cutover release uses this as a **bootstrap baseline** because current production does not expose a build SHA: its rollback proof is the recorded Cloudflare version/deployment ID plus the prior widget/manifest hashes and health response. After the first successful cutover, every baseline must additionally contain `environment=production`, the prior `buildSha`, tag, and asset hashes.

It then deploys the verified widget/static artifacts and bundles the Worker once during the provisional production deploy from the exact target source and lockfile with:

- explicit release version;
- `BUILD_SHA=target_sha`;
- `ENVIRONMENT=production`;
- a deployment annotation containing release-plan identity and tag.

The deployment must verify the source-tree/lockfile digest immediately before invoking pinned Wrangler and must not regenerate widget/static release bytes. Unless the implementation proves a supported prebuilt Worker mechanism, the integrity claim for the Worker is exact source, lockfile, toolchain, configuration, and deployed `BUILD_SHA`, not byte-for-byte equivalence to a preflight Worker bundle.

At this point the candidate may briefly serve production traffic but is not yet a published GitHub Release.

### State 5: production verified

Verification must prove, against production:

1. `/api/health` reports `environment=production`.
2. `/api/health.buildSha` equals `target_sha`.
3. `widget.js` hash equals the verified artifact hash.
4. The new exact URL exists and has the same hash.
5. Mutable major and minor aliases expected for the version have the same hash.
6. Every retained post-cutover exact URL sampled by the retention contract still exists with its recorded immutable hash.
7. `versions.json` identifies the planned version and retained exact releases.
8. Live production E2E receives the explicit candidate SHA, version, origin, and expected artifact hash; it does not infer identity through `git describe`.

### State 6: published

Only after State 5 succeeds may the workflow assemble and publish the GitHub Release. It uses a versioned, deterministic publication protocol:

1. Create the new tag as an annotated tag at `target_sha`. Its canonical annotation includes the tag/version, target SHA, release-plan identity, canonical content-payload hash, and protocol version. Future workflow-created tags are immutable; retries inspect them but never move or replace them.
2. Create the GitHub Release as a draft whose body contains the same machine-readable identity marker. Draft creation does not advance the published release frontier.
3. Upload the exact widget bundle, versions manifest, canonical release content payload, final release plan, execution audit envelope, and checksums. Re-list every required asset, reject unexpected name/hash conflicts, download or hash-read each asset, and prove the complete set before publication.
4. Publish the already complete draft in one explicit final action. Only that transition advances the published release frontier and permits notification.

Creation and resumption are conditional and idempotent:

- no tag or Release: create the annotated tag, assemble the draft, verify it, and publish;
- matching annotated tag with no Release (**tag-only** state): retain the tag, create and verify the identity-matched draft, then publish;
- matching annotated tag and matching draft, including a partially uploaded draft: reconcile only missing exact assets, fail on any conflicting asset, verify the complete draft, then publish;
- a published Release whose tag, target SHA, identity marker, notes provenance, and artifact hashes all match: core publication is a no-op success;
- a lightweight orphan tag, identity/SHA mismatch, unrelated draft, duplicate Release, unexpected asset, or published mismatch: fail closed without moving, deleting, overwriting, or silently incrementing anything.

The published assets are the canonical forward archive for reconstructing later deployments and auditing exact URLs.

### State 7: notified

After publication, the workflow invokes Discord notification explicitly using the published tag; it does not wait for a suppressed `release.published` event. Notification reuse should share the existing payload implementation rather than duplicate it.

Notification success completes the normal path. Notification failure produces a visible degraded-notification warning and retry instruction but does not roll back, retag, republish, or redeploy a verified core release.

## Failure Semantics

### FS-01: before production mutation

Validation, notes, checkout, install, check, test, build, artifact, approval rejection, or stale-plan failure has no tag, GitHub Release, production deployment, or Discord side effect. The run may be retried with the same inputs after correcting the cause.

### FS-02: deployment command failure

If the production deployment command reports failure, the workflow must inspect authoritative Cloudflare state rather than assuming nothing changed. If the candidate is active or partially active, it attempts rollback to the recorded previous deployment and verifies the complete rollback baseline. For the bootstrap cutover this means the previous Cloudflare version/deployment ID, widget/manifest hashes, aliases, and health response even though no prior build SHA exists; later releases also verify the prior production build SHA and tag. No tag or Release is published.

### FS-03: production verification failure

If health identity, artifact hash, retention checks, or live E2E fail after provisional deployment, the workflow automatically attempts rollback to the recorded previous deployment. Rollback success is verified against the complete recorded baseline, using the bootstrap proof for the first cutover and production build SHA/tag/hash proof thereafter. No tag, GitHub Release, or notification is created.

Rollback failure is a critical terminal state. The workflow must surface both intended and observed production identities, Cloudflare version identifiers, failed verification, and manual recovery command/runbook. It must not continue publication.

### FS-04: publication failure after verified deployment

If annotated-tag creation, draft assembly, asset verification, or final publication fails after production verification, the workflow treats production as provisional and attempts rollback to the recorded previous deployment. It retains an identity-matched tag or draft as durable resumable evidence; routine recovery never deletes or moves the tag. A later retry first inspects tag, draft/published Release, assets, and production state and never assumes the failed API call had no effect.

If publication actually succeeded despite a lost response, the retry recognizes the exact matching published Release and complete assets and continues without duplication. If only the tag or draft exists and rollback restored the previous version, that partial state does not advance the published release frontier: the same request deterministically selects the same version, reproduces the same release-plan identity, redeploys and verifies, and then resumes the bounded missing publication steps. Any mismatch fails closed rather than selecting a later version.

### FS-05: notification failure

Notification is not transactional with the core release. Failure records a warning containing the published release URL and the existing notification-only retry path. It never changes core release success and never triggers a release/deploy rerun.

### FS-06: duplicate and concurrent dispatch

Two dispatches may calculate the same next version before entering concurrency. The first approved run that completes publication advances the frontier. Before treating that advanced frontier as stale-plan failure, the second repeats the completed-plan lookup. An exact authenticated plan exits as a post-success core no-op; any input/content mismatch fails closed. It must not automatically select the subsequent version.

Two identical dispatches for the same request identity may build independently, but they are the same release plan only if every deterministic release content field and the release-plan identity match. Their run IDs, attempts, artifact storage records, timing, and audit envelopes remain distinct and do not prevent a safe identity match. One may complete while the other recognizes an exact published match and exits core release as a no-op. Notification idempotency must prevent an automatic duplicate announcement; explicit notification-only retries are operator-authorized.

Within the same workflow run or GitHub rerun, downstream jobs reuse the uploaded immutable artifacts when they remain available and append that attempt's observations to the audit envelope. A new dispatch with the same request identity may rebuild widget/static assets only from the exact source, lockfile, toolchain, and plan-supplied deterministic inputs; it may resume the same release plan only when the canonical release content payload and every hash reproduce the prior finalized identity exactly. Its new audit envelope references that existing identity without being folded into it. Missing or expired artifacts may never be silently replaced. The workflow must either rebuild and prove exact content-identity equality or create a new finalized release plan requiring approval. A mismatch fails closed or produces a new plan; it cannot inherit an earlier approval.

Until a supported prebuilt Worker mechanism is proven, each production deploy attempt bundles the Worker from the same immutable source/lockfile and pinned toolchain. Resumption proves Worker integrity with the recorded source-tree/lockfile digest and resulting live `BUILD_SHA`, while widget/static artifacts retain byte-for-byte identity.

### FS-07: cancellation

Production release runs are never canceled by a newer run. Cancellation before production mutation is side-effect free.

A user-requested cancellation during or after mutation creates an **ambiguous critical state** until authoritative inspection proves either the candidate state or the complete previous rollback baseline. An `always()` recovery/finalization job must be configured to inspect production and attempt the appropriate verification or rollback, but GitHub cancellation can prevent or interrupt cleanup, so this path is best effort rather than a guarantee. If automated finalization does not complete, the run must surface the intended candidate, recorded baseline, last observed Cloudflare state, and exact operator runbook/manual recovery steps. No operator may treat the run as cleanly canceled until that inspection and recovery evidence is recorded.

### FS-08: rollback policy

Rollback restores service; it does not rewrite Git history or reuse a released version.

- Before tag/Release publication, a rolled-back plan may retry the same version and SHA.
- After publication, rollback is a new production action recorded against the existing release; a corrected source requires a new higher SemVer release.
- Tags are immutable and are never moved or deleted as routine recovery.
- A dedicated rollback dispatch may redeploy a previously published release artifact, but it requires the production environment, serialization, explicit target release, observed-state verification, and an operator rationale.

The implementation plan must validate the exact supported Cloudflare rollback mechanism and command against the installed Wrangler version before encoding it in automation.

## Artifact Retention

### AR-01: URL semantics

- `widget.js` is mutable and points to the newest successfully published production release.
- `widget.vMAJOR.js` is mutable within that major line.
- `widget.vMAJOR.MINOR.js` is mutable within that minor line.
- `widget.vMAJOR.MINOR.PATCH.js` is immutable and must remain byte-for-byte available after every later deployment.

Aliases update only when the corresponding core release reaches production-verified state. A rolled-back or unpublished candidate cannot advance them.

### AR-02: canonical archive

Every post-cutover GitHub Release stores the exact bundle and checksum as release assets. Before a later deploy, the workflow stages all supported post-cutover exact assets from their canonical release assets plus the new verified exact bundle, verifies each checksum, and deploys the complete retained set with current aliases.

The production manifest records, for each retained exact version, its filename, target SHA, SHA-256, publication timestamp, and archive URL. Timestamp values are fixed deterministic inputs in the request plan (for example, the candidate commit timestamp or another predeclared normalized value), never the current clock at rebuild time. Rebuilding the same request may resume the same release plan only if the manifest and every other static artifact reproduce the finalized hashes exactly.

### AR-03: historical gap

The retention guarantee is prospective from the cutover release. Existing 404 historical versions must not be represented as available.

A separate, explicitly labeled backfill may reconstruct selected historical versions from tags and lockfiles with provenance. It must not claim byte identity with unavailable historical deployments unless a stored hash or original artifact proves it. Backfill is not required to cut over the safer release cadence, but the manifest and documentation must disclose the boundary.

### AR-04: release artifact integrity

The release workflow deploys the widget/static bytes verified before approval and later attaches those same bytes to the GitHub Release. It must not rebuild those bytes between verification, deployment, retention staging, and publication. Hash mismatch at any boundary fails closed.

Worker integrity is separately proven by the immutable target source, lockfile, pinned Wrangler toolchain/configuration, source-tree/lockfile digest, and live `BUILD_SHA`. The implementation plan must not describe a prebuilt Worker bundle as promotable unless it first validates and tests an exact supported Wrangler mechanism.

## Notifications and Metadata

### NM-01: Discord

The existing Discord payload behavior is retained and made reusable by the core release workflow. The manual notification-only path remains for retry and dry-run inspection.

An automatic release announcement is sent exactly once per published release plan. The notification records the GitHub Release URL and tag. Optional custom text, image, and allow-listed user mention behavior remain available only through bounded inputs.

### NM-02: canonical release history

GitHub Releases and immutable tags are the canonical release history. Release notes include target SHA, compare link, PR inventory, artifact hashes, and emergency rationale when applicable.

`CHANGELOG.md` is not revived as an automatically committed per-release file. It is updated once during migration to identify its historical coverage and link to GitHub Releases for current history.

### NM-03: package metadata

BugDrop does not currently publish through npm. `package.json` must stop presenting an old production release as authoritative. The migration changes its version to a clearly documented development sentinel and prevents the widget release workflow from deriving production identity from it.

Production builds require an explicit valid planned version. Local development builds may use a visible `dev` identity. Any future npm publication is a separate product/distribution decision and must introduce its own package-version lifecycle.

### NM-04: production deployment identity

Production must report `ENVIRONMENT=production` and the exact deployed `BUILD_SHA`. GitHub Actions must reference a named production environment so GitHub records deployment history and exposes approval/audit data.

The deterministic release content payload and final release plan record target SHA, tag, artifact hashes, and the immutable build/configuration inputs defined by RC-03. Separately, workflow summaries and the append-only audit envelope record GitHub run ID/attempt, artifact storage/retention records, previous and new Cloudflare versions, approval result, production verification observations, publication result, notification result, cancellation, and rollback/recovery result if applicable. Publication attaches both documents so content identity is reproducible without losing execution provenance.

## Acceptance Criteria

| ID    | Requirement                                                                 | Authoritative proof                                                                                                      |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | Main merges cannot release or deploy production.                           | Workflow contract test proves no production workflow has `push`, `pull_request`, `merge_group`, `release`, or `schedule`. |
| AC-02 | Only manual dispatch can start release planning.                            | Workflow event inspection and a GitHub Actions dry-run invocation.                                                       |
| AC-03 | A non-main dispatch ref is rejected before secrets or mutation.             | Negative workflow test/fixture and a real dry run from a temporary branch.                                               |
| AC-04 | Candidate source is one full SHA reachable from remote main.                | Unit/contract tests for valid tip, valid ancestor, branch head, abbreviated SHA, unreachable SHA, and pseudo-ref.         |
| AC-05 | Approval reports included/excluded stack work and final candidate identity. | Approval summary fixture contains the finalized release-plan identity, full compare, PR inventory, main-tip delta, paths, version, rationale, notes, verification evidence, and hashes. |
| AC-06 | SemVer comes from explicit bump and the reachable published frontier.       | Table-driven helper tests for patch/minor/major, malformed/unreachable/conflicting releases/tags, drafts, orphan tags, and no-op ranges. |
| AC-07 | Dry run completes candidate verification without secrets or mutation.       | A real dry run reaches State 2, finalizes the release plan, and leaves no tag, Release, deployment, notification, environment access, or secret access. |
| AC-08 | Widget/static release bytes are built once and promoted unchanged.           | Static-artifact SHA-256 is identical at build, upload/download, deploy, live readback, retention staging, and Release asset. |
| AC-09 | Production access is approval-gated and serialized.                         | GitHub environment configuration audit and workflow contract for concurrency, queueing, and no cancellation.              |
| AC-10 | A stale queued plan fails rather than recalculates.                         | Concurrency integration test with two planned versions and observed zero mutation from the stale run.                     |
| AC-11 | Production identifies environment and source.                               | Live `/api/health` equals `production` and the approved 40-character target SHA.                                          |
| AC-12 | Live tests use explicit plan identity, not `git describe`.                  | Workflow contract and live-test invocation prove explicit version, SHA, origin, and widget hash are passed together.      |
| AC-13 | Publication occurs only after production verification.                     | Dependency/order contract and a forced live-test failure prove no tag or Release is created.                              |
| AC-14 | Publication is complete, idempotent, and tags are immutable.                | Tests cover annotated tag, identity-bound draft, verified complete assets, final publish, identical no-op, conflicts, and absence of any tag move/delete path. |
| AC-15 | Deployment or verification failure restores the complete prior baseline.    | Bootstrap drill verifies prior Cloudflare ID, widget/manifest hashes, aliases, and health without requiring a missing old build SHA; later drill also verifies production build SHA/tag. |
| AC-16 | Publication failure is inspected and recovered safely.                     | Lost-response simulations at tag, draft, asset, and publish boundaries prove retry recognizes actual state, rolls back provisional production, and resumes without duplicate/moved publication. |
| AC-17 | Notification does not depend on `release.published`.                       | Core workflow invokes reusable notification directly; absence of a release-event child run does not block notification.  |
| AC-18 | Notification-only failure is independently retryable.                      | Forced webhook failure leaves core release intact and provides a successful tag-scoped notification-only retry.           |
| AC-19 | Exact assets remain available and immutable after a later release.          | Release N+1 drill reads release N exact URL, matches its recorded hash, and confirms aliases advance to N+1.               |
| AC-20 | Historical retention boundary is truthful.                                 | Manifest/docs distinguish retained post-cutover versions from unavailable or provenance-reconstructed historical files.  |
| AC-21 | Package/changelog metadata no longer claims current release authority.      | Source inspection shows development sentinel and historical changelog notice/link; production build rejects missing version. |
| AC-22 | Preview CI, scheduled live monitoring, and docs sync remain independent.     | Existing workflow contract tests plus trigger/diff audit show their behavior was not coupled to manual production release. |
| AC-23 | Permissions are least-privilege.                                            | Workflow permission audit shows write only in post-verification publication and secrets only behind appropriate environment. |
| AC-24 | Emergency releases use the same safety path.                                | Emergency dry-run and release fixture prove identical gates plus mandatory rationale in summary and notes.                |
| AC-25 | A release operator can recover every terminal state.                        | Reviewed runbook exercises dry-run, stale plan, preflight fail, deploy fail, verify fail, publish fail, notify fail, retry, and rollback. |
| AC-26 | Request identity and release-plan identity are created at the correct times. | Contract/unit test proves the request identity exists before build, deterministic artifact/content fields finalize a distinct release-plan identity after State 2, and approval binds only the latter. |
| AC-27 | Worker deployment identity is honest and reproducible.                      | Preflight/deploy audit proves exact target source, lockfile, pinned Wrangler/configuration, source digest, and live build SHA; no unsupported prebuilt-bundle claim exists. |
| AC-28 | Retry and artifact expiry cannot substitute different release bytes.        | Rerun reuses immutable artifacts; expired-artifact test rebuilds deterministically and requires exact content-identity equality or a new plan and approval. |
| AC-29 | Cancellation after mutation is treated as an ambiguous critical state.      | Cancellation drill proves no auto-cancel, best-effort finalization, authoritative state inspection, and runbook recovery when cleanup is interrupted. |
| AC-30 | Deterministic content identity is separate from complete execution audit.   | Canonicalization tests prove reordered/equivalent content hashes identically, any content change changes identity, run ID/attempt and observations do not; two dispatches resume one identity with distinct complete audit envelopes. |
| AC-31 | Partial publication cannot drift the SemVer frontier.                       | A tag-only and partial-draft drill proves the next plan remains the same version/identity, resumes exact missing steps, and fails conflicts instead of silently incrementing. |
| AC-32 | An exact post-success rerun no-ops before the advanced frontier.            | Tests publish a release, rerun its exact normalized request, and prove the completed-plan lookup authenticates stored content then performs no build, approval, secret access, deploy, tag/Release/asset mutation, or automatic notification; variants with changed bump/reason/rationale/notes, missing or conflicting content, the same SHA under another plan, and a target already contained only by a later release all fail closed without calculating another version. |

## Non-Goals

- Automatically deciding whether a partially merged feature is product-complete.
- Automatically publishing every week when no maintainer authorizes a candidate.
- Replacing the existing merge queue, preview Worker, preview live tests, or daily production monitoring.
- Publishing BugDrop to npm or introducing an npm distribution channel.
- Reconstructing every historical exact widget as a prerequisite for cadence cutover.
- Changing widget APIs, feedback behavior, GitHub App behavior, tenant configuration, or product data.
- Moving or deleting historical Git tags to make release history appear cleaner.
- Making GitHub and Cloudflare transactions mathematically atomic; the requirement is explicit state, verification, compensating rollback, and idempotent recovery.
- Treating Discord delivery as a reason to roll back a healthy published core release.

## Open Decisions

No architecture-blocking decision remains for implementation planning. The following values are operator configuration, not unresolved release semantics:

1. The named user/team configured as production required reviewer.
2. Whether the repository currently has enough eligible maintainers to enable self-review prevention immediately; the target policy is to enable it whenever two maintainers are available.
3. The agreed weekly calendar window and reminder mechanism outside the release workflow.
4. The first release designated as the exact-asset retention cutover boundary.
5. Which historical exact versions, if any, receive a separately proven provenance backfill.

The implementation plan must represent those as explicit operator checklist entries and must not silently choose identities, dates, or unsupported historical bytes.
