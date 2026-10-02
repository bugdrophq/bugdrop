#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$repo_root/.github/workflows/deploy.yml"
capability_workflow="$repo_root/.github/workflows/cloudflare-capability.yml"
ci_workflow="$repo_root/.github/workflows/ci.yml"
live_workflow="$repo_root/.github/workflows/live-tests.yml"
workflows_dir="$repo_root/.github/workflows"

fail() {
  echo "Release workflow contract failed: $*" >&2
  exit 1
}

grep -Fq 'timeout-minutes:' "$live_workflow" ||
  fail 'live verification job lacks an overall timeout'
grep -Fq 'retained exact and stable alias filenames' "$live_workflow" ||
  fail 'manual live verification does not require the complete retained asset set'

for controller_context in \
  '--arg eventName "$GITHUB_EVENT_NAME"' \
  '--arg ref "$GITHUB_REF"' \
  '--arg workflowSha "$CONTROLLER_SHA"' \
  'git -C "$GITHUB_WORKSPACE/controller" merge-base --is-ancestor "$TARGET_SHA" origin/main' \
  '--argjson candidateReachableFromMain "$candidate_reachable"' \
  '$candidateReachableFromMain'; do
  grep -Fq -- "$controller_context" "$workflow" ||
    fail "guard request context lacks: $controller_context"
done

guard_plan_block=$(awk '
  /^  guard-and-plan:$/ { capture = 1 }
  capture && /^  verify-candidate:$/ { exit }
  capture { print }
' "$workflow")
if grep -Fq -- 'candidateReachableFromMain: true' <<< "$guard_plan_block"; then
  fail 'guard request context must not assert candidate reachability'
fi

require_literal() {
  grep -Fq -- "$1" "$workflow" || fail "deploy.yml lacks: $1"
}

require_absent() {
  if grep -Fq -- "$1" "$workflow"; then
    fail "deploy.yml must not contain: $1"
  fi
}

job_block() {
  local job=$1
  awk -v job="$job" '
    $0 == "  " job ":" { found = 1 }
    found && $0 ~ /^  [[:alnum:]_-]+:$/ && $0 != "  " job ":" { exit }
    found { print }
  ' "$workflow"
}

job_needs_block() {
  job_block "$1" | awk '
    /^    needs:/ { found = 1 }
    found && /^    [[:alnum:]_-]+:/ && $0 !~ /^    needs:/ { exit }
    found { print }
  '
}

line_of() {
  grep -nF -- "$1" "$workflow" | head -1 | cut -d: -f1
}

[[ -s "$workflow" ]] || fail 'deploy.yml is missing'
require_literal 'name: Production Release'

top_level_events=$(awk '
  /^on:$/ { found = 1; next }
  found && /^[^[:space:]]/ { exit }
  found && /^  [[:alnum:]_-]+:$/ { print $1 }
' "$workflow")
[[ "$top_level_events" == 'workflow_dispatch:' ]] ||
  fail "workflow_dispatch must be the only trigger; found: $top_level_events"

for input in target_sha bump release_reason rationale operator_notes dry_run retention_bootstrap \
  resume_controller_sha resume_remote_main_sha resume_plan_identity; do
  require_literal "      $input:"
done
for literal in \
  'options: [patch, minor, major]' \
  'options: [standard, emergency]' \
  'default: true' \
  'type: boolean' \
  'group: bugdrop-production-release' \
  'cancel-in-progress: false' \
  'queue: max' \
  '  contents: read'; do
  require_literal "$literal"
done

for forbidden in \
  'push:' \
  'pull_request:' \
  'merge_group:' \
  'schedule:' \
  'workflow_call:' \
  'issues: write' \
  'pull-requests: write' \
  'git describe' \
  'semantic-release' \
  'release.published'; do
  require_absent "$forbidden"
done

for job in \
  guard-and-plan \
  verify-candidate \
  dry-run-summary \
  completed-summary \
  capability-gate \
  approval-baseline \
  deploy-candidate \
  live-e2e \
  attest-release \
  publish-release \
  notify \
  finalize-cancelled; do
  require_literal "  $job:"
done

guard_block=$(job_block guard-and-plan)
first_checkout_line=$(line_of 'uses: actions/checkout@')
guard_line=$(line_of 'Reject non-main or malformed dispatch before checkout')
[[ "$guard_line" -lt "$first_checkout_line" ]] || fail 'main/SHA guard must run before checkout'
for literal in \
  "test \"\$DISPATCH_REF\" = 'refs/heads/main'" \
  '[[ "$CONTROLLER_SHA" =~ ^[0-9a-f]{40}$ ]]' \
  '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]' \
  'CONTROLLER_SHA: ${{ github.workflow_sha }}' \
  'if [ -n "$RESUME_CONTROLLER_SHA$RESUME_REMOTE_MAIN_SHA$RESUME_PLAN_IDENTITY" ]; then' \
  'Legacy resume inputs are disabled; use reviewed reset-and-replay recovery.' \
  'node controller/scripts/release/workflow.mjs guard' \
  'node controller/scripts/release/github-adapter.mjs plan' \
  '--arg repositoryDir "$GITHUB_WORKSPACE/controller"' \
  'fetch-depth: 0' \
  "echo 'completed=true'"; do
  grep -Fq -- "$literal" <<< "$guard_block" || fail "guard-and-plan lacks: $literal"
done
[[ $(grep -Fc 'RESUME_PLAN_IDENTITY:' "$workflow") -eq 1 ]] ||
  fail 'resume plan identity must exist only in the first pre-checkout guard'

guard_script=$(awk '
  /- name: Reject non-main or malformed dispatch before checkout/ { found = 1 }
  found && /^        run: \|$/ { capture = 1; next }
  capture && /^      - name: Checkout immutable controller$/ { exit }
  capture { sub(/^          /, ""); print }
' "$workflow")
for mask in 0 1 2 3 4 5 6 7; do
  resume_controller=''
  resume_main=''
  resume_plan=''
  ((mask & 1)) && resume_controller='a'
  ((mask & 2)) && resume_main='b'
  ((mask & 4)) && resume_plan='c'
  if output=$(env \
    CONTROLLER_SHA="$(printf 'a%.0s' {1..40})" \
    DISPATCH_REF='refs/heads/main' \
    GITHUB_OUTPUT=/dev/null \
    RESUME_CONTROLLER_SHA="$resume_controller" \
    RESUME_PLAN_IDENTITY="$resume_plan" \
    RESUME_REMOTE_MAIN_SHA="$resume_main" \
    TARGET_SHA="$(printf 'b%.0s' {1..40})" \
    bash -c "$guard_script" 2>&1); then
    [[ "$mask" -eq 0 ]] || fail "resume combination $mask reached beyond the first guard"
  else
    [[ "$mask" -ne 0 ]] || fail 'fresh all-empty dispatch failed the first guard'
    grep -Fq 'Legacy resume inputs are disabled; use reviewed reset-and-replay recovery.' <<< "$output" ||
      fail "resume combination $mask did not return the stable reset-and-replay rejection"
  fi
done

for literal in \
  "request_key=\$(jq -er '.planIdentity[7:]' request-plan.json)" \
  "request_key=\$(jq -er '.requestIdentity[7:]' request-plan.json)" \
  "version=\$(jq -er '.tag[1:]' request-plan.json)" \
  "version=\$(jq -er '.request.nextTag[1:]' request-plan.json)" \
  "plan_key=\$(jq -er '.finalPlan.planIdentity[7:]' state2-bundle.json)"; do
  grep -Fq -- "$literal" "$workflow" || fail "release outputs lack fail-closed assignment: $literal"
done
require_absent 'ltrimstr(\"'
require_absent 'echo "request_key=$(jq'
require_absent 'echo "version=$(jq'
require_absent 'echo "plan_key=$(jq'

checkout_count=$(grep -Fc 'uses: actions/checkout@' "$workflow")
persist_count=$(grep -Fc 'persist-credentials: false' "$workflow")
[[ "$checkout_count" -ge 6 ]] || fail "expected immutable controller/candidate checkouts; found $checkout_count"
[[ "$persist_count" -eq "$checkout_count" ]] || fail 'every checkout must discard credentials'
require_absent 'ref: main'
require_absent 'ref: ${{ github.ref }}'
require_literal 'ref: ${{ steps.guard.outputs.controller_sha }}'
require_literal 'ref: ${{ needs.guard-and-plan.outputs.controller_sha }}'
require_literal 'ref: ${{ inputs.target_sha }}'

verify_block=$(job_block verify-candidate)
candidate_checkout_block=$(sed -n '/      - name: Checkout immutable candidate$/,/      - uses: actions\/setup-node@/p' <<< "$verify_block")
grep -Fq 'fetch-depth: 0' <<< "$candidate_checkout_block" ||
  fail 'candidate verification must fetch history for cross-plane baseline tests'
for literal in \
  'needs: guard-and-plan' \
  'path: controller' \
  'path: candidate' \
  'npm ci --ignore-scripts' \
  'npm run validate' \
  'npm run build' \
  'node controller/scripts/build-widget.js' \
  '--mode release' \
  '--retention-plan request/retention-input/retention-plan.json' \
  '--request-plan request/request-plan.json' \
  '--result-path "$RUNNER_TEMP/builder-result.json"' \
  'node controller/scripts/release/workflow.mjs bundle-static' \
  'requestPlan: $requestPlan[0]' \
  'builderResultPath' \
  'request/retention-input/retention-plan.json' \
  'staticPackageDir' \
  'install -d "$RUNNER_TEMP/release-plan/static-package"' \
  'cp state2-bundle.json "$RUNNER_TEMP/release-plan/state2-bundle.json"' \
  'cp "$RUNNER_TEMP/builder-result.json" "$RUNNER_TEMP/release-plan/builder-result.json"' \
  'cp -R "$RUNNER_TEMP/static-package/." "$RUNNER_TEMP/release-plan/static-package/"' \
  'path: ${{ runner.temp }}/release-plan/' \
  'include-hidden-files: true' \
  'retention-days: 14'; do
  grep -Fq -- "$literal" <<< "$verify_block" || fail "verify-candidate lacks: $literal"
done
for removed_resume_path in \
  'RESUMING' \
  'resumePlanIdentity' \
  'Authenticate exact partial-publication retry' \
  'partial-inspection'; do
  require_absent "$removed_resume_path"
done
if grep -Fq -- '{$requestPlan:' <<< "$verify_block"; then
  fail 'slurped request plan must be a literal requestPlan field, not a dynamic object key'
fi
if grep -Fq -- '--arg base64 "$(base64' <<< "$verify_block" ||
  grep -Fq -- '--arg versionsBase64 "$(base64' <<< "$verify_block"; then
  fail 'release artifact bytes must not be passed through the process argument list'
fi
if grep -Fq '          path: |' <<< "$verify_block"; then
  fail 'State 2 evidence must upload from one root so consumers receive canonical flat paths'
fi

bundle_shape=$(jq -n \
  --argjson requestPlan '[{"schema":"proof"}]' \
  --arg staticPackageDir '/tmp/static-package' \
  --arg builderResultPath '/tmp/builder-result.json' \
  '{requestPlan: $requestPlan[0], $staticPackageDir, $builderResultPath}')
jq -e '
  .requestPlan.schema == "proof" and
  .staticPackageDir == "/tmp/static-package" and
  .builderResultPath == "/tmp/builder-result.json"
' <<< "$bundle_shape" >/dev/null || fail 'bundle-input jq shape is not executable or path-safe'
if grep -Eq 'secrets\.|environment:' <<< "$verify_block"; then
  fail 'candidate verification must not reference secrets or an environment'
fi

completed_block=$(job_block completed-summary)
for literal in \
  "needs.guard-and-plan.outputs.completed == 'true'" \
  'core no-op' \
  'No build, approval, production environment, mutation, or automatic notification was performed.'; do
  grep -Fq -- "$literal" <<< "$completed_block" || fail "completed-summary lacks: $literal"
done
if grep -Eq 'secrets\.|environment:|wrangler|gh release|git tag|DISCORD_' <<< "$completed_block"; then
  fail 'completed-plan no-op references mutation or notification authority'
fi

dry_block=$(job_block dry-run-summary)
grep -Fq 'if: inputs.dry_run' <<< "$dry_block" || fail 'dry-run job is not boolean-gated'
grep -Fq 'node controller/scripts/release/workflow.mjs state2' <<< "$dry_block" ||
  fail 'dry-run job does not authenticate the State 2 handoff'
if grep -Eq 'secrets\.|environment:|wrangler|gh release|git tag|DISCORD_' <<< "$dry_block"; then
  fail 'dry-run summary references mutation authority'
fi

capability_block=$(job_block capability-gate)
for literal in \
  "vars.RELEASE_PRODUCTION_ENABLED" \
  "vars.RELEASE_CLOUDFLARE_CAPABILITY_VALIDATED" \
  "test \"\$PRODUCTION_ENABLED\" = 'true'" \
  "test \"\$CAPABILITY_VALIDATED\" = 'true'"; do
  grep -Fq -- "$literal" <<< "$capability_block" || fail "capability gate lacks: $literal"
done
if grep -Eq 'environment:|secrets\.' <<< "$capability_block"; then
  fail 'external gates must be checked before protected environment or secrets'
fi

approval_block=$(job_block approval-baseline)
for literal in \
  'needs: [guard-and-plan, verify-candidate, capability-gate]' \
  'environment: production' \
  'artifact-ids: ${{ needs.verify-candidate.outputs.artifact_id }}' \
  'Stage exact static package below candidate trust root' \
  'diff -qr approved/static-package candidate/.release-static-package' \
  '--arg staticPackageDir "$GITHUB_WORKSPACE/candidate/.release-static-package"' \
  '--arg candidateAssets "$GITHUB_WORKSPACE/candidate/.release-static-package"' \
  'Revalidate exact plan after protected approval' \
  'node controller/scripts/release/workflow.mjs authorize' \
  'Capture exact production baseline before mutation' \
  '--arg bundlePath "$GITHUB_WORKSPACE/approved/state2-bundle.json"' \
  'node controller/scripts/release/live-release.mjs baseline'; do
  grep -Fq -- "$literal" <<< "$approval_block" || fail "approval-baseline lacks: $literal"
done
[[ $(grep -Fc 'RETENTION_BOOTSTRAP: ${{ inputs.retention_bootstrap }}' "$workflow") -eq 2 ]] ||
  fail 'bootstrap authority must be identical during planning and protected revalidation'
grep -Fq 'RETENTION_BOOTSTRAP: ${{ inputs.retention_bootstrap }}' <<< "$approval_block" ||
  fail 'protected revalidation omits bootstrap authority'
for secret in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
  grep -Fq "secrets.$secret" <<< "$approval_block" || fail "baseline lacks named $secret"
done

deploy_block=$(job_block deploy-candidate)
for literal in \
  "needs.approval-baseline.outputs.proceed == 'true'" \
  'environment: production' \
  'diff -qr release-state/static-package candidate/.release-static-package' \
  '--arg candidateAssets "$GITHUB_WORKSPACE/candidate/.release-static-package"' \
  '--arg bundlePath "$GITHUB_WORKSPACE/release-state/state2-bundle.json"' \
  'node controller/scripts/release/live-release.mjs deploy' \
  'Require exact candidate deployment' \
  "test '\${{ steps.deploy.outputs.status }}' = 'candidate-active'"; do
  grep -Fq -- "$literal" <<< "$deploy_block" || fail "deploy-candidate lacks: $literal"
done
if grep -Eq 'BUGDROP_GITHUB_TOKEN|contents: write|DISCORD_' <<< "$deploy_block"; then
  fail 'deployment job must not receive publication or notification authority'
fi

live_block=$(job_block live-e2e)
for literal in \
  'uses: ./.github/workflows/live-tests.yml' \
  'target: production' \
  'target_sha: ${{ inputs.target_sha }}' \
  'widget_sha256: ${{ needs.approval-baseline.outputs.widget_sha256 }}'; do
  grep -Fq -- "$literal" <<< "$live_block" || fail "live-e2e lacks: $literal"
done

attest_block=$(job_block attest-release)
for literal in \
  "needs.approval-baseline.outputs.proceed == 'true'" \
  'environment: production' \
  'contents: read' \
  'id-token: write' \
  'attestations: write' \
  'artifact-ids: ${{ needs.verify-candidate.outputs.artifact_id }}' \
  'node controller/scripts/release/attestation.mjs stage' \
  "test \"\$(jq -er '.subjects | length' attestation-subjects.json)\" = '6'" \
  'attestation-subjects.sha256' \
  'uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2' \
  'subject-checksums: ${{ runner.temp }}/attestation-subjects.sha256' \
  'attestation.intoto.jsonl' \
  'node controller/scripts/release/attestation.mjs verify' \
  'name: release-attestation-${{ needs.verify-candidate.outputs.plan_key }}'; do
  grep -Fq -- "$literal" <<< "$attest_block" || fail "attest-release lacks: $literal"
done
if grep -Eq 'contents: write|CLOUDFLARE_|DISCORD_' <<< "$attest_block"; then
  fail 'attestation job combines provenance with publication, deployment, or notification authority'
fi
if grep -Fq 'attest-release' <<< "$dry_block$completed_block"; then
  fail 'dry-run or completed-plan no-op can reach attestation'
fi

publish_block=$(job_block publish-release)
publish_needs=$(job_needs_block publish-release)
grep -Fq 'attest-release' <<< "$publish_needs" ||
  fail 'publish-release does not depend on attest-release'
for literal in \
  'environment: production' \
  'timeout-minutes: 15' \
  'contents: write' \
  'needs.attest-release.outputs.artifact_id' \
  '--arg attestationPath "$GITHUB_WORKSPACE/release-state/attestation.intoto.jsonl"' \
  'node controller/scripts/release/live-release.mjs publish' \
  'BUGDROP_GITHUB_TOKEN: ${{ github.token }}'; do
  grep -Fq -- "$literal" <<< "$publish_block" || fail "publish-release lacks: $literal"
done
if grep -Eq 'CLOUDFLARE_|DISCORD_' <<< "$publish_block"; then
  fail 'publication job must not receive deployment or notification credentials'
fi
if grep -Eq 'id-token: write|attestations: write' <<< "$publish_block"; then
  fail 'publication job must not receive attestation authority'
fi
[[ $(grep -Fc 'contents: write' "$workflow") -eq 1 ]] || fail 'write permission must exist only on publish-release'
[[ $(grep -Fc 'id-token: write' "$workflow") -eq 1 ]] || fail 'OIDC write must exist only on attest-release'
[[ $(grep -Fc 'attestations: write' "$workflow") -eq 1 ]] ||
  fail 'attestation write must exist only on attest-release'

notify_block=$(job_block notify)
for literal in \
  "needs: [verify-candidate, publish-release]" \
  "needs.publish-release.result == 'success'" \
  "needs.publish-release.outputs.notify == 'true'" \
  'uses: ./.github/workflows/discord-release.yml'; do
  grep -Fq -- "$literal" <<< "$notify_block" || fail "notify lacks: $literal"
done
grep -Fq 'DISCORD_RELEASE_WEBHOOK_URL: ${{ secrets.DISCORD_RELEASE_WEBHOOK_URL }}' <<< "$notify_block" ||
  fail 'notification must receive only the named Discord credential'

final_block=$(job_block finalize-cancelled)
final_needs=$(job_needs_block finalize-cancelled)
grep -Fq 'attest-release' <<< "$final_needs" ||
  fail 'finalize-cancelled does not depend on attest-release'
for literal in \
  'always()' \
  'environment: production' \
  'contents: read' \
  'DEPLOY_JOB_RESULT: ${{ needs.deploy-candidate.result }}' \
  'if [ "$DEPLOY_JOB_RESULT" = '\''skipped'\'' ]; then' \
  'status: "no-mutation", rollbackAttempted: false' \
  'test -s release-state/baseline.json' \
  'test -s release-state/expected.json' \
  'diff -qr release-state/static-package candidate/.release-static-package' \
  '--arg candidateAssets "$GITHUB_WORKSPACE/candidate/.release-static-package"' \
  '--arg bundlePath "$GITHUB_WORKSPACE/release-state/state2-bundle.json"' \
  'needs.attest-release.outputs.artifact_id' \
  '--arg attestationPath "$GITHUB_WORKSPACE/release-state/attestation.intoto.jsonl"' \
  '--argjson hasAttestation' \
  'node controller/scripts/release/live-release.mjs finalize' \
  'Preserve finalization evidence' \
  'Upload authoritative finalization outcome' \
  'name: release-finalization-${{ needs.verify-candidate.outputs.plan_key }}-${{ github.run_attempt }}' \
  'path: finalization.json' \
  'if-no-files-found: error' \
  'Require verified stable or restored production' \
  'test "$status" = '\''no-mutation'\'''; do
  grep -Fq -- "$literal" <<< "$final_block" || fail "finalizer lacks: $literal"
done

upload_line=$(grep -n 'name: Upload authoritative finalization outcome' <<< "$final_block" | cut -d: -f1)
assert_line=$(grep -n 'name: Require verified stable or restored production' <<< "$final_block" | cut -d: -f1)
[[ -n "$upload_line" && -n "$assert_line" && "$upload_line" -lt "$assert_line" ]] ||
  fail 'finalization evidence must upload before the terminal assertion'

[[ $(grep -Fc "if: \${{ needs.deploy-candidate.result != 'skipped' }}" <<< "$final_block") -eq 7 ]] ||
  fail 'skipped deployment must bypass all recovery setup and artifact downloads'

require_absent 'CAPABILITY_NOT_INSTALLED'

for command in 'wrangler deploy' 'wrangler rollback' 'gh release' 'git tag'; do
  require_absent "$command"
done

semantic_release_matches=$(grep -RInF --include='*.yml' --include='*.yaml' -- 'semantic-release' "$workflows_dir" || true)
[[ -z "$semantic_release_matches" ]] ||
  fail "semantic-release remains executable in a workflow: $semantic_release_matches"

wrangler_deploy_matches=$(grep -RInF --include='*.yml' --include='*.yaml' -- 'wrangler deploy' "$workflows_dir" || true)
[[ $(printf '%s\n' "$wrangler_deploy_matches" | awk 'NF { count += 1 } END { print count + 0 }') -eq 1 ]] ||
  fail "only preview CI may deploy before WP7: $wrangler_deploy_matches"
[[ "$wrangler_deploy_matches" == *'.github/workflows/ci.yml:'*'wrangler deploy --env preview'* ]] ||
  fail "remaining Wrangler deploy is not preview-only: $wrangler_deploy_matches"

[[ -s "$capability_workflow" ]] || fail 'Cloudflare capability workflow is missing'
for literal in \
  'workflow_dispatch:' \
  'group: bugdrop-shared-preview' \
  'cancel-in-progress: false' \
  'test "$DISPATCH_REF" = '\''refs/heads/main'\''' \
  'git -C controller merge-base --is-ancestor "$SHA_A" "$SHA_B"' \
  'persist-credentials: false' \
  'node controller/scripts/release/cloudflare-capability-drill.mjs' \
  'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}' \
  'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}' \
  'if: always()'; do
  grep -Fq -- "$literal" "$capability_workflow" ||
    fail "Cloudflare capability workflow lacks: $literal"
done
grep -Fq 'group: bugdrop-shared-preview' "$ci_workflow" ||
  fail 'merge-queue preview and capability drill must share one mutation lock'
if grep -Eq 'environment: production|contents: write|issues: write|DISCORD_|BUGDROP_CANARY_' "$capability_workflow"; then
  fail 'Cloudflare capability workflow receives unrelated or production authority'
fi

(
  cd "$repo_root"
  npx vitest run test/release/retention-integration.test.ts \
    -t 'authenticates published v2 N through createGithubTransport, handoff, CLI, and real State 2' \
    >/dev/null
) || fail 'installed builder-result to bundle-static boundary did not execute successfully'

(
  cd "$repo_root"
  npx vitest run test/release/github-adapter.test.ts \
    -t 'reproduces protected bootstrap history revalidation exactly' \
    >/dev/null
) || fail 'protected bootstrap/history revalidation did not execute successfully'

echo 'Guarded manual release workflow contract checks passed'
