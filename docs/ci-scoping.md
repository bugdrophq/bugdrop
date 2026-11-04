# CI scope

CI keeps its required check names on every pull request and merge-group event.
It scopes work inside the workflows instead of filtering away required workflows.

| Changes | Checks |
| --- | --- |
| Listed root documentation, non-executable documentation under `docs/`, and `LICENSE` | Changed-file formatting |
| Only `license` in `package.json` and/or `packages[""].license` in `package-lock.json` | JSON comparison and changed-file formatting |
| Source, tests, browser fixtures, benchmarks, or public assets | Full lint/typecheck/audit, unit/build, browser tests, and CodeQL |
| Dependencies, package scripts, build configuration, workflows, or unknown paths | Full CI, CodeQL, and dependency review |

The license exception compares committed JSON objects after removing only the
project license field, preserving object key order because conditional exports are
order-sensitive. Changes to dependencies, transitive lock entries, scripts,
exports, versions, or any other field still require full CI. Deleted, malformed,
new, and non-regular manifests also require full CI. Nested manifests are always
treated as dependency changes.

Dependency review skips known source/test/asset-only changes. Unknown paths and
dependency tooling changes retain the scan. CodeQL still runs its weekly full scan;
pushes to main use the complete push range, and pull requests use their merge base.
Missing refs, empty diffs, and unsupported events default to full checks.

For a documentation or license-only merge group, the preview job reports a no-op
success without deploying, downloading browsers, or creating canary Issues. The
live-preview bridge requires that job to succeed. A group containing any runtime
change requires all local test jobs to succeed before deployment and live testing.

A documentation/metadata-only follow-up to a source PR may reuse the preceding
successful full CI suite, as before. Without that proof, only a wholly lightweight
PR can skip full CI. Non-fast-forward follow-ups default to full CI.

Run `make check-ci-scope check-ci-workflow check-security-analysis-workflows` to
exercise committed-change fixtures, preview gate states, required context names,
and security workflow mutation checks. The scope fixtures include license changes
mixed with dependency changes, lifecycle scripts, malformed/deleted manifests,
source renames, and merge groups containing runtime changes.
