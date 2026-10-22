#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
checker="$repo_root/scripts/check-workflow-permissions.mjs"
fixture_root=$(mktemp -d /tmp/bugdrop-workflow-permissions-test.XXXXXX)
trap 'rm -rf "$fixture_root"' EXIT

make_fixture() {
  local name=$1
  local directory="$fixture_root/$name"
  mkdir -p "$directory"
  cp "$repo_root"/.github/workflows/*.yml "$directory/"
  printf '%s\n' "$directory"
}

expect_failure() {
  local directory=$1
  local expected=$2
  if node "$checker" "$directory" > "$fixture_root/output" 2>&1; then
    echo "Permission checker unexpectedly accepted an unsafe fixture" >&2
    exit 1
  fi
  grep -Fq "$expected" "$fixture_root/output" || {
    cat "$fixture_root/output" >&2
    exit 1
  }
}

node "$checker" "$repo_root/.github/workflows" > /dev/null

missing_attestation_oidc=$(make_fixture missing-attestation-oidc)
perl -0pi -e \
  's/(  attest-release:.*?    permissions:\n      contents: read\n)      id-token: write\n/$1/s' \
  "$missing_attestation_oidc/deploy.yml"
expect_failure "$missing_attestation_oidc" \
  'deploy.yml:attest-release: effective permissions must be {"attestations":"write","contents":"read","id-token":"write"}'

missing_attestation_write=$(make_fixture missing-attestation-write)
perl -0pi -e \
  's/(  attest-release:.*?    permissions:\n      contents: read\n      id-token: write\n)      attestations: write\n/$1/s' \
  "$missing_attestation_write/deploy.yml"
expect_failure "$missing_attestation_write" \
  'deploy.yml:attest-release: effective permissions must be {"attestations":"write","contents":"read","id-token":"write"}'

misplaced_attestation_write=$(make_fixture misplaced-attestation-write)
perl -0pi -e \
  's/(  publish-release:.*?    permissions:\n      contents: write\n)/$1      attestations: write\n/s' \
  "$misplaced_attestation_write/deploy.yml"
expect_failure "$misplaced_attestation_write" \
  'deploy.yml:publish-release: attestations: write is not an approved grant'

broad_attestation_job=$(make_fixture broad-attestation-job)
perl -0pi -e \
  's/(  attest-release:.*?    permissions:\n)      contents: read\n/$1      contents: write\n/s' \
  "$broad_attestation_job/deploy.yml"
expect_failure "$broad_attestation_job" \
  'deploy.yml:attest-release: contents: write is not an approved grant'

top_level_oidc=$(make_fixture top-level-oidc)
perl -0pi -e 's/(permissions:\n  contents: read\n)/$1  id-token: write\n/' \
  "$top_level_oidc/deploy.yml"
expect_failure "$top_level_oidc" \
  'deploy.yml: top-level permissions must be {"contents":"read"}'

missing_top=$(make_fixture missing-top)
perl -0pi -e 's/\npermissions: \{\}\n/\n/' "$missing_top/benchmark-ci.yml"
expect_failure "$missing_top" 'benchmark-ci.yml: top-level permissions must be explicitly declared'

null_top=$(make_fixture null-top)
perl -0pi -e 's/permissions: \{\}/permissions: null/' "$null_top/benchmark-ci.yml"
expect_failure "$null_top" \
  'benchmark-ci.yml: top-level permissions must be an explicit permission map'

null_job=$(make_fixture null-job)
perl -0pi -e 's/(  live-preview-tests:\n)/$1    permissions: null\n/' \
  "$null_job/ci.yml"
expect_failure "$null_job" \
  'ci.yml:live-preview-tests: permissions must be an explicit permission map'

unexpected_write=$(make_fixture unexpected-write)
perl -0pi -e 's/(    permissions:\n      contents: read\n)/$1      issues: write\n/' \
  "$unexpected_write/benchmark-ci.yml"
expect_failure "$unexpected_write" 'benchmark-ci.yml:lint: issues: write is not an approved grant'

broad_job=$(make_fixture broad-job)
perl -0pi -e 's/(  prove:\n)/$1    permissions: write-all\n/' \
  "$broad_job/cloudflare-capability.yml"
expect_failure "$broad_job" \
  'cloudflare-capability.yml:prove: permissions must be an explicit permission map'

missing_job_boundary=$(make_fixture missing-job-boundary)
perl -0pi -e 's/(  e2e:\n.*?    needs: check\n)    permissions:\n      contents: read\n/$1/s or die "E2E permission fixture mutation did not match\n"' \
  "$missing_job_boundary/ci.yml"
expect_failure "$missing_job_boundary" \
  'ci.yml:e2e: effective permissions must be {"contents":"read"}'

echo 'Workflow permission policy checks passed'
