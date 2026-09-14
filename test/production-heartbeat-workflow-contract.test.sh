#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$repo_root/.github/workflows/production-heartbeat.yml"

fail() {
  echo "Production heartbeat workflow contract failed: $*" >&2
  exit 1
}

require() {
  grep -Fq -- "$1" "$workflow" || fail "missing: $1"
}

require_absent() {
  if grep -Fq -- "$1" "$workflow"; then fail "must not contain: $1"; fi
}

job_gate=$(awk '
  /^    if: >-$/ { capture = 1 }
  capture && /^    runs-on:/ { exit }
  capture { print }
' "$workflow")

grep -Fq "github.event.schedule == '17 2 * * *' &&" <<< "$job_gate" ||
  fail 'daily cron is missing from the schedule gate'
grep -Fq "vars.BUGDROP_PRODUCTION_HEARTBEAT_MODE == 'daily')" <<< "$job_gate" ||
  fail 'daily cron is not authorized exclusively by daily mode'
grep -Fq "github.event.schedule == '47 1/4 * * *' &&" <<< "$job_gate" ||
  fail 'four-hour cron is missing from the schedule gate'
grep -Fq "vars.BUGDROP_PRODUCTION_HEARTBEAT_MODE == 'four-hour'" <<< "$job_gate" ||
  fail 'four-hour cron is not authorized exclusively by four-hour mode'
if grep -Fq "BUGDROP_PRODUCTION_HEARTBEAT_MODE == 'daily' ||" <<< "$job_gate"; then
  fail 'daily and four-hour schedule modes must be mutually exclusive'
fi

require 'name: Production Heartbeat'
require 'workflow_dispatch:'
require "cron: '17 2 * * *'"
require "cron: '47 1/4 * * *'"
require "vars.BUGDROP_PRODUCTION_HEARTBEAT_MODE == 'daily'"
require "vars.BUGDROP_PRODUCTION_HEARTBEAT_MODE == 'four-hour'"
require 'group: bugdrop-production-heartbeat'
require 'cancel-in-progress: false'
require 'timeout-minutes: 30'
require_absent 'environment: production'
require 'persist-credentials: false'
require 'name: Validate production heartbeat configuration'
require 'node scripts/production-heartbeat-config.mjs export'
require 'BUGDROP_TEST_REPOSITORY: ${{ vars.BUGDROP_TEST_REPOSITORY }}'
for variable in \
  BUGDROP_HEARTBEAT_WIDGET_ORIGIN \
  BUGDROP_HEARTBEAT_VENUE_ORIGIN \
  BUGDROP_HEARTBEAT_TEST_REPO \
  BUGDROP_HEARTBEAT_EXPECTED_AUTHOR \
  BUGDROP_HEARTBEAT_EXPECTED_LABELS; do
  require "$variable: \${{ vars.$variable }}"
done
require 'curl --max-time 30 -sSf "$EXPECTED_WIDGET_ORIGIN/widget.js"'
require 'curl --max-time 30 -sSf "${bypass_args[@]}" "$PLAYWRIGHT_BASE_URL"'
require 'grep -Fq "$EXPECTED_WIDGET_ORIGIN/widget.js"'
require '--repo "$BUGDROP_CANARY_REPO"'
require_absent '--repo mean-weasel/bugdrop-widget-test'
require_absent 'https://bugdrop.neonwatty.workers.dev'
require_absent 'https://bugdrop-widget-test.vercel.app'
require 'node scripts/release/verify-live.mjs observe'
require 'bugdrop-production-heartbeat:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}:${worker_sha}'
require 'BUGDROP_CANARY_POST_EVIDENCE_FILE=$RUNNER_TEMP/production-heartbeat-post-evidence'
require 'npx playwright test e2e/widget.issue-canary.spec.ts --project=chromium-issue-canary --workers=1 --retries=0'

[[ $(grep -Fc -- '--profile production' "$workflow") -eq 5 ]] ||
  fail 'exactly five production GitHub operations must select the production profile'
require 'uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349'
require 'app-id: ${{ vars.BUGDROP_HEARTBEAT_MONITOR_APP_ID }}'
require_absent 'client-id:'
require_absent 'BUGDROP_HEARTBEAT_MONITOR_CLIENT_ID'
require 'private-key: ${{ secrets.BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY }}'
require 'owner: ${{ env.BUGDROP_CANARY_REPO_OWNER }}'
require 'repositories: ${{ env.BUGDROP_CANARY_REPO_NAME }}'
require 'permission-issues: write'
require_absent 'skip-token-revoke:'
require_absent 'BUGDROP_CANARY_GITHUB_TOKEN: ${{ secrets.BUGDROP_CANARY_GITHUB_TOKEN }}'
[[ $(grep -Fc 'BUGDROP_CANARY_GITHUB_TOKEN: ${{ steps.heartbeat-monitor-token.outputs.token }}' "$workflow") -eq 5 ]] ||
  fail 'the installation token must exist only on preflight, verify, evidence, cleanup, and sweep'
require_absent 'BUGDROP_CANARY_GITHUB_TOKEN: ${{ github.token }}'

token_step=$(awk '
  /name: Mint monitoring-only GitHub App token/ { capture = 1 }
  capture && /name: Preflight production heartbeat cleanup/ { exit }
  capture { print }
' "$workflow")
for required in \
  'id: heartbeat-monitor-token' \
  "if: always() && steps.checkout.outcome == 'success'" \
  'uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349' \
  'app-id: ${{ vars.BUGDROP_HEARTBEAT_MONITOR_APP_ID }}' \
  'private-key: ${{ secrets.BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY }}' \
  'owner: ${{ env.BUGDROP_CANARY_REPO_OWNER }}' \
  'repositories: ${{ env.BUGDROP_CANARY_REPO_NAME }}' \
  'permission-issues: write'; do
  grep -Fq -- "$required" <<< "$token_step" || fail "monitor token step missing: $required"
done
[[ $(grep -Fc 'BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY' "$workflow") -eq 1 ]] ||
  fail 'the monitoring App private key must appear only in the token-mint action'
[[ $(grep -Fc 'BUGDROP_HEARTBEAT_MONITOR_APP_ID' "$workflow") -eq 1 ]] ||
  fail 'the monitoring App identifier must appear only in the token-mint action'
for forbidden in 'client-id:' 'BUGDROP_HEARTBEAT_MONITOR_CLIENT_ID' 'permission-contents:' 'permission-actions:' 'skip-token-revoke: true'; do
  if grep -Fq -- "$forbidden" <<< "$token_step"; then
    fail "monitor token step broadens scope: $forbidden"
  fi
done

for helper in \
  'Preflight production heartbeat cleanup' \
  'Verify production canary independently' \
  'Classify sanitized authoritative delivery evidence' \
  'Cleanup current production marker' \
  'Final production-prefix sweep'; do
  helper_block=$(awk -v helper="$helper" '
    $0 ~ "name: " helper { capture = 1 }
    capture && $0 ~ /^      - name:/ && $0 !~ "name: " helper { exit }
    capture { print }
  ' "$workflow")
  grep -Fq 'BUGDROP_CANARY_GITHUB_TOKEN: ${{ steps.heartbeat-monitor-token.outputs.token }}' <<< "$helper_block" ||
    fail "$helper does not consume the installation token"
done

playwright_block=$(awk '
  /name: Run one production Issue canary/ { capture = 1 }
  capture && /name: Verify production canary independently/ { exit }
  capture { print }
' "$workflow")
for forbidden in heartbeat-monitor-token BUGDROP_CANARY_GITHUB_TOKEN BUGDROP_HEARTBEAT_MONITOR_PRIVATE_KEY; do
  if grep -Fq "$forbidden" <<< "$playwright_block"; then
    fail "Playwright received monitoring App credential material: $forbidden"
  fi
done

for step in \
  'Cleanup current production marker' \
  'Final production-prefix sweep' \
  'Classify sanitized authoritative delivery evidence' \
  'Summarize heartbeat stages' \
  'Upload heartbeat diagnostics' \
  'Reconcile one stable incident Issue' \
  'Fail closed on every required outcome' \
  'Classify final sanitized outcome' \
  'Send sanitized production heartbeat outcome'; do
  require "name: $step"
done
require 'if: always() && steps.identity.outcome'
require 'if: always() && steps.checkout.outcome'
require 'needs: [heartbeat, incident]'
require 'HEARTBEAT_OK: ${{ needs.heartbeat.outputs.heartbeat_ok }}'
require 'ARTIFACT_OUTCOME: ${{ needs.heartbeat.outputs.artifact_outcome }}'
require 'INCIDENT_JOB: ${{ needs.incident.result }}'
require 'issues: write'
require 'GITHUB_TOKEN: ${{ github.token }}'
require 'BUGDROP_HEARTBEAT_INCIDENT_REPO: ${{ github.repository }}'
require 'Controlled post-cleanup failure'
require 'inputs.controlled_failure'
require 'diagnostics_path="$RUNNER_TEMP/production-heartbeat-diagnostics.json"'
require 'name: Prepare heartbeat diagnostics artifact'
require 'diagnostics_tmp="$RUNNER_TEMP/production-heartbeat-diagnostics.tmp"'
require '> "$diagnostics_tmp"'
require 'test -s "$diagnostics_tmp"'
require "' \"\$diagnostics_tmp\" > /dev/null"
require 'mv "$diagnostics_tmp" "$diagnostics_path"'
require 'test -s "$diagnostics_path"'
require "' \"\$diagnostics_path\" > /dev/null"
require 'cp "$diagnostics_path" "$artifact_path/diagnostics.json"'
require_absent 'cp -R playwright-report'
require_absent 'cp -R test-results'
require 'name: production-heartbeat-diagnostics-${{ github.run_attempt }}'
require_absent 'name: production-heartbeat-diagnostics$'
require_absent 'overwrite: true'
require '${{ runner.temp }}/production-heartbeat-artifact/'
require 'if-no-files-found: error'
require_absent 'if-no-files-found: ignore'
require_absent 'test -f "$diagnostics_path"'
require_absent '> "$diagnostics_path"'
require "'{schemaVersion: \$schemaVersion, stages:"
require_absent '--arg runId'
require_absent '--arg runAttempt'
require '--arg config "$CONFIG"'
require '"config"'
require 'EVIDENCE: ${{ steps.evidence.outcome }}'
require '--arg evidence "$EVIDENCE"'
require '"evidence"'
require 'if [ "$evidence_verified" != true ]; then heartbeat_ok=false; fi'
require 'parsed.toISOString() !== value'

summary_block=$(awk '
  /name: Summarize heartbeat stages/ { capture = 1 }
  capture && /name: Upload heartbeat diagnostics/ { exit }
  capture { print }
' "$workflow")
for forbidden in BUGDROP_CANARY_GITHUB_TOKEN GITHUB_TOKEN VERCEL_AUTOMATION_BYPASS_SECRET secrets.; do
  if grep -Fq "$forbidden" <<< "$summary_block"; then
    fail "token-free diagnostics summary contains credential input: $forbidden"
  fi
done

summary_script=$(mktemp)
summary_workspace=$(mktemp -d)
summary_output=$(mktemp)
summary_evidence="$summary_workspace/evidence.json"
trap 'rm -f -- "$summary_script" "$summary_output" "$summary_workspace"/*; rmdir "$summary_workspace"' EXIT
awk '
  /name: Summarize heartbeat stages/ { step = 1 }
  step && /run: \|/ { capture = 1; next }
  capture && /^      - name:/ { exit }
  capture { sub(/^          /, ""); print }
' "$workflow" > "$summary_script"
test -s "$summary_script" || fail 'heartbeat summary script could not be extracted'

run_summary_contract() {
  local evidence_step=$1
  local evidence_payload=$2
  local expected_heartbeat_ok=$3
  local expected_outcome=${4:-}
  rm -f -- "$summary_evidence" "$summary_workspace/production-heartbeat-diagnostics.json"
  : > "$summary_output"
  if [ "$evidence_payload" != missing ]; then
    printf '%s\n' "$evidence_payload" > "$summary_evidence"
  fi
  CHECKOUT=success NODE=success INSTALL=success CONFIG=success BROWSER=success IDENTITY=success \
    PREFLIGHT=success VENUE=success CANARY=success VERIFY=success EVIDENCE="$evidence_step" \
    CLEANUP=success SWEEP=success CONTROLLED=skipped RUNNER_TEMP="$summary_workspace" \
    BUGDROP_CANARY_EVIDENCE_FILE="$summary_evidence" GITHUB_OUTPUT="$summary_output" \
    bash -euo pipefail "$summary_script" || fail 'heartbeat summary contract execution failed'
  grep -Fxq "heartbeat_ok=$expected_heartbeat_ok" "$summary_output" ||
    fail "evidence $evidence_step/$expected_outcome produced the wrong aggregate"
  if [ -n "$expected_outcome" ]; then
    grep -Fxq "evidence_outcome=$expected_outcome" "$summary_output" ||
      fail "valid $expected_outcome evidence was not preserved for reporting"
  elif grep -Fq 'evidence_outcome=' "$summary_output"; then
    fail 'missing or malformed evidence was published'
  fi
}

run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2024-02-29T12:34:56.789Z"}' \
  true verified
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"delivery_failed","reasonCode":"issue_absent","observedAt":"2026-08-12T12:34:56.789Z"}' \
  false delivery_failed
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"inconclusive","reasonCode":"github_network","observedAt":"2026-08-12T12:34:56.789Z"}' \
  false inconclusive
run_summary_contract success missing false
run_summary_contract success '{"schemaVersion":1,"outcome":"verified"}' false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-99-99T99:99:99.999Z"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T12:34:56.789Z\n"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-02-29T12:34:56.789Z"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T24:00:00.000Z"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T23:59:60.000Z"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T12:34:56.789+00:00"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T12:34:56.7890Z"}' \
  false
run_summary_contract success \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T12:34:56.789z"}' \
  false
run_summary_contract failure \
  '{"schemaVersion":1,"outcome":"verified","reasonCode":"issue_verified","observedAt":"2026-08-12T12:34:56.789Z"}' \
  false

rm -f -- "$summary_script" "$summary_output" "$summary_workspace"/*
rmdir "$summary_workspace"
trap - EXIT
[[ $(grep -Fc 'ARTIFACT_PREPARE_OUTCOME: ${{ needs.heartbeat.outputs.artifact_prepare_outcome }}' "$workflow") -eq 3 ]] ||
  fail 'artifact preparation must feed incident selection, classification, and final conclusion'
[[ $(grep -Fc 'SUMMARIZE_OUTCOME: ${{ needs.heartbeat.outputs.summarize_outcome }}' "$workflow") -eq 2 ]] ||
  fail 'summarize outcome must feed both incident selection and final conclusion'
require '[ "$SUMMARIZE_OUTCOME" = success ]'
require '[ "$SUMMARIZE_OUTCOME" != success ]'
require '[ "$ARTIFACT_PREPARE_OUTCOME" = success ]'
require '[ "$ARTIFACT_PREPARE_OUTCOME" != success ]'

incident_script=$(mktemp)
incident_capture=$(mktemp)
incident_output=$(mktemp)
trap 'rm -f -- "$incident_script" "$incident_capture" "$incident_output"' EXIT
awk '
  /name: Reconcile one stable incident Issue/ { step = 1 }
  step && /run: \|/ { capture = 1; next }
  capture && /^  conclusion:/ { exit }
  capture { sub(/^          /, ""); print }
' "$workflow" > "$incident_script"
test -s "$incident_script" || fail 'native incident selector could not be extracted'

node() {
  printf '%s\n' "$*" > "$INCIDENT_CAPTURE"
}
export -f node

run_incident_contract() {
  local expected_outcome=$1
  local expected_reason=$2
  local evidence_outcome=$3
  local evidence_reason=$4
  local heartbeat_ok=$5
  local summarize=$6
  local cleanup=$7
  local sweep=$8
  local artifact_prepare=$9
  local artifact=${10}
  : > "$incident_capture"
  : > "$incident_output"
  INCIDENT_CAPTURE="$incident_capture" EVIDENCE_OUTCOME="$evidence_outcome" \
    EVIDENCE_REASON="$evidence_reason" HEARTBEAT_OK="$heartbeat_ok" \
    SUMMARIZE_OUTCOME="$summarize" CLEANUP_OUTCOME="$cleanup" SWEEP_OUTCOME="$sweep" \
    ARTIFACT_PREPARE_OUTCOME="$artifact_prepare" ARTIFACT_OUTCOME="$artifact" \
    GITHUB_OUTPUT="$incident_output" bash -euo pipefail "$incident_script" ||
    fail 'native incident selector execution failed'
  grep -Fxq "scripts/github-heartbeat-incident.mjs $expected_outcome --reason-code $expected_reason" "$incident_capture" ||
    fail "native incident selected the wrong result for $evidence_outcome/$expected_reason"
  grep -Fxq "transition=$expected_outcome" "$incident_output" ||
    fail 'native incident transition output did not match selection'
}

run_incident_contract failure issue_absent delivery_failed issue_absent false success failure failure failure failure
run_incident_contract recovery issue_verified verified issue_verified true success success success success success
run_incident_contract inconclusive cleanup_failed verified issue_verified false success failure failure failure failure
run_incident_contract inconclusive sweep_failed verified issue_verified false success success failure failure failure
run_incident_contract inconclusive artifact_failed verified issue_verified false success success success failure success
run_incident_contract inconclusive artifact_failed verified issue_verified false success success success success failure
run_incident_contract inconclusive classification_failed verified issue_verified false success success success success success
run_incident_contract inconclusive classification_failed verified issue_verified false failure success success success success

unset -f node
rm -f -- "$incident_script" "$incident_capture" "$incident_output"
trap - EXIT

sender_block=$(awk '
  /name: Send sanitized production heartbeat outcome/ { capture = 1 }
  capture { print }
' "$workflow")
for required in \
  'if: always()' \
  'continue-on-error: true' \
  'MONITOR_HEARTBEAT_SECRET: ${{ secrets.MONITOR_HEARTBEAT_SECRET }}' \
  'HEARTBEAT_ID: ${{ github.run_id }}:${{ github.run_attempt }}' \
  'HEARTBEAT_OUTCOME: ${{ steps.classify.outputs.outcome }}' \
  'HEARTBEAT_REASON_CODE: ${{ steps.classify.outputs.reason_code }}' \
  'HEARTBEAT_OBSERVED_AT: ${{ steps.classify.outputs.observed_at }}' \
  'EVIDENCE_OUTCOME: ${{ needs.heartbeat.outputs.evidence_outcome }}' \
  'EVIDENCE_REASON: ${{ needs.heartbeat.outputs.evidence_reason }}' \
  'EVIDENCE_OBSERVED_AT: ${{ needs.heartbeat.outputs.evidence_observed_at }}' \
  'if [ "${{ steps.checkout.outcome }}" = success ] && \' \
  '[ "${{ steps.classify.outcome }}" = success ] && \' \
  '[ -n "$HEARTBEAT_OUTCOME" ] && [ -n "$HEARTBEAT_REASON_CODE" ] && \' \
  'node scripts/production-heartbeat-outcome.mjs send'; do
  grep -Fq -- "$required" <<< "$sender_block" || fail "sender step missing: $required"
done
for required in \
  'schemaVersion: 1' \
  "evidenceOutcome === 'verified' && evidenceReason === 'issue_verified'" \
  "evidenceOutcome === 'delivery_failed'" \
  "['issue_absent', 'issue_duplicate', 'issue_contract_invalid'].includes(evidenceReason)" \
  "outcome: 'inconclusive'" \
  "reasonCode: 'setup_failed'" \
  "if (!secret || !/^\\d+:\\d+$/.test(heartbeatId || ''))" \
  "redirect: 'manual'" \
  "'X-BugDrop-Heartbeat-Id': heartbeatId" \
  'const delays = [1_000, 2_000]' \
  'for (let attempt = 0; attempt < 3; attempt += 1)' \
  'if ([500, 502, 503, 504].includes(response.status) && attempt < 2)' \
  'responseText = await response.text()' \
  "response.headers.get('cache-control')?.toLowerCase() !== 'no-store'" \
  "keys !== 'accepted,duplicate,effect,observedAt,outcome,schemaVersion'"; do
  grep -Fq -- "$required" <<< "$sender_block" || fail "checkout-independent sender missing: $required"
done

fallback_script=$(mktemp)
fallback_harness=$(mktemp)
fallback_error=$(mktemp)
trap 'rm -f -- "$fallback_script" "$fallback_harness" "$fallback_error"' EXIT
awk '
  /node --input-type=module <<'"'"'NODE'"'"'/ { capture = 1; next }
  capture && /^          NODE$/ { exit }
  capture { sub(/^          /, ""); print }
' "$workflow" > "$fallback_script"
test -s "$fallback_script" || fail 'checkout-independent fallback script could not be extracted'

{
  cat <<'NODE'
const attempts = [];
globalThis.setTimeout = callback => (queueMicrotask(callback), 0);
globalThis.fetch = async (endpoint, request) => {
  attempts.push({ endpoint, request });
  if (attempts.length === 1) throw new Error(`network ${process.env.MONITOR_HEARTBEAT_SECRET}`);
  if (attempts.length === 2) return new Response(null, { status: 503 });
  const report = JSON.parse(request.body);
  if (
    endpoint !== 'https://bugdrop.dev/api/monitor/heartbeat' ||
    request.method !== 'POST' ||
    request.redirect !== 'manual' ||
    request.headers.Authorization !== `Bearer ${process.env.MONITOR_HEARTBEAT_SECRET}` ||
    request.headers['Content-Type'] !== 'application/json' ||
    request.headers['X-BugDrop-Heartbeat-Id'] !== process.env.HEARTBEAT_ID ||
    Object.keys(report).sort().join(',') !== 'observedAt,outcome,reasonCode,schemaVersion' ||
    report.schemaVersion !== 1 ||
    report.outcome !== process.env.EXPECTED_OUTCOME ||
    report.reasonCode !== process.env.EXPECTED_REASON ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.observedAt) ||
    attempts.some(attempt => attempt.request.body !== request.body)
  ) throw new Error('fallback request contract mismatch');
  return Response.json(
    { schemaVersion: 1, accepted: true, duplicate: false, outcome: report.outcome, effect: 'recorded_only', observedAt: report.observedAt },
    { headers: { 'cache-control': 'no-store' } }
  );
};
process.on('beforeExit', () => {
  if (attempts.length !== 3) throw new Error(`expected three attempts, received ${attempts.length}`);
});
NODE
  cat "$fallback_script"
} > "$fallback_harness"

run_fallback_success() {
  local evidence_outcome=$1
  local evidence_reason=$2
  local evidence_observed_at=$3
  local expected_outcome=$4
  local expected_reason=$5
  MONITOR_HEARTBEAT_SECRET='fallback-secret-redaction-sentinel' \
    HEARTBEAT_ID='123:2' EVIDENCE_OUTCOME="$evidence_outcome" EVIDENCE_REASON="$evidence_reason" \
    EVIDENCE_OBSERVED_AT="$evidence_observed_at" EXPECTED_OUTCOME="$expected_outcome" \
    EXPECTED_REASON="$expected_reason" node "$fallback_harness" 2> "$fallback_error" ||
    fail 'checkout-independent fallback did not satisfy its executable request contract'
  test ! -s "$fallback_error" || fail 'successful checkout fallback emitted diagnostics'
}

run_fallback_success delivery_failed issue_absent '2026-08-12T12:34:56.789Z' delivery_failed issue_absent
run_fallback_success verified issue_verified '2026-08-12T12:34:56.789Z' verified issue_verified
run_fallback_success delivery_failed issue_absent invalid inconclusive setup_failed
run_fallback_success __proto__ issue_verified '2026-08-12T12:34:56.789Z' inconclusive setup_failed

{
  cat <<'NODE'
const attempts = [];
globalThis.setTimeout = callback => (queueMicrotask(callback), 0);
globalThis.fetch = async (endpoint, request) => {
  attempts.push({ endpoint, request });
  if (attempts.length === 1) {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  }
  const report = JSON.parse(request.body);
  if (
    attempts.length !== 2 ||
    attempts[0].endpoint !== endpoint ||
    attempts[0].request.body !== request.body ||
    attempts[0].request.headers['X-BugDrop-Heartbeat-Id'] !==
      request.headers['X-BugDrop-Heartbeat-Id']
  ) throw new Error('fallback body retry changed request identity');
  return Response.json(
    { schemaVersion: 1, accepted: true, duplicate: true, outcome: report.outcome, effect: 'recorded_only', observedAt: report.observedAt },
    { headers: { 'cache-control': 'no-store' } }
  );
};
process.on('beforeExit', () => {
  if (attempts.length !== 2) throw new Error(`expected two attempts, received ${attempts.length}`);
});
NODE
  cat "$fallback_script"
} > "$fallback_harness"
MONITOR_HEARTBEAT_SECRET='fallback-secret-redaction-sentinel' HEARTBEAT_ID='123:2' \
  node "$fallback_harness" 2> "$fallback_error" ||
  fail 'checkout-independent fallback did not retry a terminated response body'
test ! -s "$fallback_error" || fail 'successful fallback body retry emitted diagnostics'

run_fallback_rejection() {
  local response_expression=$1
  local expected_attempts=$2
  {
    cat <<NODE
let attempts = 0;
globalThis.setTimeout = callback => (queueMicrotask(callback), 0);
globalThis.fetch = async () => {
  attempts += 1;
  return $response_expression;
};
process.on('beforeExit', () => {
  if (attempts !== $expected_attempts) throw new Error(\`expected $expected_attempts attempts, received \${attempts}\`);
});
NODE
    cat "$fallback_script"
  } > "$fallback_harness"
  MONITOR_HEARTBEAT_SECRET='fallback-secret-redaction-sentinel' \
    HEARTBEAT_ID='123:2' node "$fallback_harness" 2> "$fallback_error" &&
    fail 'checkout-independent fallback unexpectedly accepted an invalid response'
  grep -Fxq '[production-heartbeat-outcome] operation_failed' "$fallback_error" ||
    fail 'checkout-independent fallback rejection was not generic'
  if grep -Fq 'fallback-secret-redaction-sentinel' "$fallback_error"; then
    fail 'checkout-independent fallback rejection leaked its monitoring secret'
  fi
}

run_fallback_rejection "new Response(null, { status: 302, headers: { location: 'https://example.invalid' } })" 1
run_fallback_rejection "new Response(null, { status: 400 })" 1
run_fallback_rejection "Response.json({ schemaVersion: 1 }, { headers: { 'cache-control': 'no-store' } })" 1
run_fallback_rejection "new Response('not-json', { status: 200, headers: { 'cache-control': 'no-store' } })" 1
run_fallback_rejection "Response.json({ schemaVersion: 1, accepted: true, duplicate: false, outcome: 'inconclusive', effect: 'recorded_only', observedAt: new Date().toISOString() }, { headers: { 'cache-control': 'max-age=60' } })" 1

{
  cat <<'NODE'
let attempts = 0;
globalThis.setTimeout = callback => (queueMicrotask(callback), 0);
globalThis.fetch = async () => {
  attempts += 1;
  throw new Error(`network ${process.env.MONITOR_HEARTBEAT_SECRET}`);
};
process.on('beforeExit', () => {
  if (attempts !== 3) throw new Error(`expected three attempts, received ${attempts}`);
});
NODE
  cat "$fallback_script"
} > "$fallback_harness"
MONITOR_HEARTBEAT_SECRET='fallback-secret-redaction-sentinel' \
  HEARTBEAT_ID='123:2' node "$fallback_harness" 2> "$fallback_error" &&
  fail 'checkout-independent fallback unexpectedly accepted three network failures'
grep -Fxq '[production-heartbeat-outcome] operation_failed' "$fallback_error" ||
  fail 'checkout-independent fallback error was not generic'
if grep -Fq 'fallback-secret-redaction-sentinel' "$fallback_error"; then
  fail 'checkout-independent fallback leaked its monitoring secret'
fi

MONITOR_HEARTBEAT_SECRET='' HEARTBEAT_ID='123:2' node "$fallback_script" 2> "$fallback_error" &&
  fail 'checkout-independent fallback accepted a missing secret'
grep -Fxq '[production-heartbeat-outcome] operation_failed' "$fallback_error" ||
  fail 'missing-secret fallback rejection was not generic'
MONITOR_HEARTBEAT_SECRET='fallback-secret-redaction-sentinel' HEARTBEAT_ID='invalid' \
  node "$fallback_script" 2> "$fallback_error" &&
  fail 'checkout-independent fallback accepted an invalid heartbeat ID'
grep -Fxq '[production-heartbeat-outcome] operation_failed' "$fallback_error" ||
  fail 'invalid-ID fallback rejection was not generic'
[[ $(grep -Fc 'MONITOR_HEARTBEAT_SECRET: ${{ secrets.MONITOR_HEARTBEAT_SECRET }}' "$workflow") -eq 1 ]] ||
  fail 'monitoring secret must exist only in the final sender step'
require_absent 'curl --fail --silent --show-error --max-time 10'
require 'node scripts/github-issue-canary.mjs evidence'
require '--post-evidence-file "$BUGDROP_CANARY_POST_EVIDENCE_FILE"'
require '--evidence-file "$BUGDROP_CANARY_EVIDENCE_FILE"'
require '> /dev/null'
require 'node scripts/production-heartbeat-outcome.mjs classify'
require 'outcome=inconclusive'
require 'if [ "$EVIDENCE_OUTCOME" = delivery_failed ]'
require 'elif [ "$EVIDENCE_OUTCOME" = verified ]'
require 'reason="${EVIDENCE_REASON:-classification_failed}"'
require 'reason=classification_failed'
require 'node scripts/github-heartbeat-incident.mjs "$outcome"'
require '--reason-code "$reason" > /dev/null'
require_absent '--run-url'
require_absent '--details'

summary_move_line=$(grep -n 'mv "$diagnostics_tmp" "$diagnostics_path"' "$workflow" | cut -d: -f1)
summary_output_line=$(grep -n 'echo "heartbeat_ok=$heartbeat_ok" >> "$GITHUB_OUTPUT"' "$workflow" | cut -d: -f1)
(( summary_move_line < summary_output_line )) ||
  fail 'heartbeat outputs must not publish before atomic diagnostics completion'

cleanup_line=$(grep -n 'name: Cleanup current production marker' "$workflow" | cut -d: -f1)
sweep_line=$(grep -n 'name: Final production-prefix sweep' "$workflow" | cut -d: -f1)
controlled_line=$(grep -n 'name: Controlled post-cleanup failure' "$workflow" | cut -d: -f1)
(( cleanup_line < sweep_line && sweep_line < controlled_line )) ||
  fail 'controlled failure must occur only after both cleanup passes'

conclusion_line=$(grep -n 'name: Fail closed on every required outcome' "$workflow" | cut -d: -f1)
sender_line=$(grep -n 'name: Send sanitized production heartbeat outcome' "$workflow" | cut -d: -f1)
(( conclusion_line < sender_line )) ||
  fail 'outcome sender must be the final step after the fail-closed conclusion'

echo 'Production heartbeat workflow contract checks passed'
