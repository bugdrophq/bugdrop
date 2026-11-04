# Allowed Repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add an optional server-side repository allowlist to upstream BugDrop without changing unconfigured deployments.

**Architecture:** A pure shared matcher owns configuration semantics. Installation checks, legacy feedback, and structured feedback each enforce that matcher after their existing validation and before GitHub access. Existing authentication, rate limits, and payload dispatch remain in place.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Vitest; existing npm tooling, no new dependencies.

**Spec:** The design and acceptance contract below captures the accepted investigation recommendation. The user subsequently authorized implementation; remote publication and deployment are not part of this execution.

## Context and baseline

- Upstream: `mean-weasel/bugdrop`, `origin/main` at `cbf871bd56a0c805a30f429843943b326dfce6b1`.
- Fresh worktree: `/tmp/bugdrop-allowed-repositories-plan`.
- Branch: `codex/plan-allowed-repositories`.
- Source reference: `mean-weasel/bugdrop-personal` PR #5, head `fe1bf767be9377f81d2a144810c4d967962ad902`, merged as `6dd465d69aa4ee249e03f2d40e67f693f94384d5`. Current fork `42e67e239def9a7ad4e948f3d208bfa021980777` retains the policy.
- Fork checks passed during investigation: 396 PR-head tests; 410 current-tip tests. Live read-only checks rejected an unlisted repo and accepted the permitted test repo.
- Upstream has no equivalent policy. Its structured submission dispatch precedes legacy validation; copying only the fork's legacy guard would omit this GitHub write path.
- Planning baseline: `npm ci --ignore-scripts` completed. `npm test` returned 1 failed / 1596 passed, across 102 files. `test/variantPublicTypes.test.ts:48` failed parsing package command output as JSON (`Unexpected token 'e', "error: cou"...`). Log: `/tmp/bugdrop-allowlist-plan-baseline.log`. Root cause is not established. Resolve or independently explain this before claiming the implementation suite is green; do not silently waive it.

## Global constraints

- Implementation authorized by the subsequent user request, "Lets begin." Publication and deployment remain outside this execution.
- Preserve existing behavior when the setting is absent, blank, or standalone `*`.
- No personal repository names, Seatify secrets, private App routing, or active production restriction.
- No changes to token claim comparison, CORS, quotas, release workflows, widget API, or feedback schemas.
- No runtime dependencies. Strict TypeScript; use existing formatting conventions.
- Use `bugdrop.localhost` for local server URLs.
- Run the repository-required PR review against the actual upstream base before merge. Do not bypass a failed review tool by treating it as a clean result.
- Review is read-only; simplification requires its own authorized implementation scope.

## Design and acceptance contract

### Chosen approach

Use one matcher with three explicit call sites. This keeps malformed-payload handling and middleware precedence intact while preventing divergence in list parsing.

Alternatives considered:

1. An early shared middleware: fewer call sites, but it would need to duplicate payload validation or change 400/401/429 precedence.
2. A low-level GitHub-client restriction: covers more calls but confuses request-target policy with webhook, installation inventory, and scheduled maintenance responsibilities, and makes HTTP 403 handling indirect.

Both alternatives are outside this focused port. Future repository-target entry points must use the same matcher before GitHub access.

### Configuration semantics

| Input | Result |
| --- | --- |
| `undefined`, `''`, whitespace | Unrestricted |
| Standalone `*`, including surrounding whitespace | Unrestricted |
| Comma or newline list | Trim each entry, lowercase, remove empty entries, compare exact full name |
| Duplicate names | Harmless |
| `team/*` or `*,team/repo` | No glob expansion; only literal exact membership |
| Separator-only nonblank value | Deny all |
| Unknown/malformed entry | Does not expand access; no fallback to unrestricted |

The matcher does not rewrite payloads, GitHub owner/repo arguments, or signed token claims. Case-insensitive policy comparison does not make token claims case-insensitive. Do not introduce a new repository grammar or repair existing malformed-input behavior in this port. Existing validation rejects malformed inputs as before; exact restricted membership also rejects extra segments not present in the list.

### Enforcement and precedence

- `/api/check/:owner/:repo`: guard after forming `fullRepo`, before optional token authentication and installation lookup. Disallowed targets return 403 even if check authentication is enabled.
- Legacy `/api/feedback`: guard after existing owner/repo validation, before route-level token check and `getInstallationAccess`.
- Structured `/api/feedback`: guard after successful `validateStructuredFeedback`, before `getInstallationAccess` in `handleStructuredFeedback`.
- Both submission formats still traverse IP limiter, authentication middleware, and repository limiter first. Missing/invalid tokens may return 401; exhausted quotas may return 429. A valid authenticated denied submission can consume quota. Preserve this behavior explicitly.
- A reached denial returns exactly `{ error: 'Repository is not allowed' }`, HTTP 403. No installation lookup, token minting, upload, visibility lookup, issue/label write, or successful-feedback accounting may follow it.
- Health, static assets, public stats, webhook verification, and scheduled inventory are unaffected. This is a request-target policy, not a universal prohibition on every GitHub API operation.

### Files and responsibilities

| File | Work |
| --- | --- |
| `src/lib/repository-policy.ts` (new) | Pure matcher |
| `src/types.ts` | Optional `ALLOWED_REPOSITORIES?: string` binding |
| `src/routes/api.ts` | Installation and legacy guards |
| `src/routes/structured-feedback.ts` | Structured guard |
| `test/repositoryPolicy.test.ts` (new) | Configuration truth table |
| `test/api.test.ts` | Installation/legacy denial, success, auth and quota behavior |
| `test/structuredFeedback.test.ts` | Structured denial, success, authenticated adversarial test |
| `test/repositoryPolicyIntegration.test.ts` (new) | Real Hono route integration with network tripwire |
| `docs/website/configuration.mdx` | Server setting and examples |
| `docs/website/security.mdx` | Boundary and response precedence |
| `README.md` | Short self-hosting note linking to configuration |
| `wrangler.toml` | Commented examples only in root/preview/production vars blocks |

## Task 1: Matcher and binding contract

**Files:** Create `src/lib/repository-policy.ts`, `test/repositoryPolicy.test.ts`; modify `src/types.ts`.

**Interface produced:** `isRepositoryAllowed(configuredRepositories: string | undefined, repo: string): boolean`.

- [x] Write table-driven tests using this core truth table; include CRLF lists, duplicate entries, and trimmed request names as additional rows.

```ts
import { expect, it } from 'vitest';
import { isRepositoryAllowed } from '../src/lib/repository-policy';

it.each([
  [undefined, 'other/repo', true],
  ['', 'other/repo', true],
  [' \n ', 'other/repo', true],
  [' * ', 'other/repo', true],
  [' Team/Repo , second/repo\nthird/repo ', 'TEAM/REPO', true],
  ['team/repo', 'team/repo-extra', false],
  ['team/repo', 'team/repo/extra', false],
  ['team/repo', 'team%2Frepo', false],
  ['team/*', 'team/repo', false],
  ['*,team/repo', 'other/repo', false],
  ['*,team/repo', 'team/repo', true],
  [',\n,', 'team/repo', false],
  ['invalid-entry', 'team/repo', false],
] as const)('policy %j for %s => %s', (config, repo, allowed) => {
  expect(isRepositoryAllowed(config, repo)).toBe(allowed);
});
```

- [x] Run `npx vitest run test/repositoryPolicy.test.ts`; confirm failure due to missing helper.
- [x] Add the optional Env field beside `ALLOWED_ORIGINS` and implement:

```ts
export function isRepositoryAllowed(
  configuredRepositories: string | undefined,
  repo: string
): boolean {
  const configured = configuredRepositories?.trim();
  if (!configured || configured === '*') return true;
  return configured.split(/[,\n]/)
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(repo.trim().toLowerCase());
}
```

- [x] Format changed files; rerun helper tests and `npm run typecheck`.
- [x] Commit the helper/type/tests as `feat: add optional repository policy matcher`.

## Task 2: Enforce all three entry points

**Files:** Modify both route files and their existing tests.

**Consumes:** Task 1 matcher and Env field. **Produces:** the specified 403 denial on each GitHub-reaching request path.

- [x] Add denied check and legacy feedback tests in `test/api.test.ts` using its existing `app`, `mockEnv`, and `validPayload`. Set the list to `approved/repo`; existing `testowner/testrepo` must be denied. Assert exact response and every existing GitHub mock is untouched.
- [x] Add the equivalent structured test using the existing fixture and env in `test/structuredFeedback.test.ts`. Drive the public API router, not just the structured function.

```ts
const response = await app.fetch(new Request('http://bugdrop.localhost/feedback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(validPayload),
}), { ...env, ALLOWED_REPOSITORIES: 'approved/repo' });
expect(response.status).toBe(403);
expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
expect(mockGetInstallationToken).not.toHaveBeenCalled();
expect(mockCreateIssue).not.toHaveBeenCalled();
expect(mockIsRepoPublic).not.toHaveBeenCalled();
```

In legacy tests use `mockEnv` and also assert `mockUploadScreenshotAsAsset` and `mockUploadAttachmentAsAsset` have no calls. Supply the existing valid screenshot/attachment fixtures so denial covers evidence-bearing requests.

- [x] Run `npx vitest run test/api.test.ts test/structuredFeedback.test.ts` and record failures before implementing guards.
- [x] Import the matcher into both route modules. Insert this guard at each placement specified in the design, using `fullRepo` for installation checks and `payload.repo` for both submissions:

```ts
if (!isRepositoryAllowed(c.env.ALLOWED_REPOSITORIES, payload.repo)) {
  return c.json({ error: 'Repository is not allowed' }, 403);
}
```

- [x] Add explicit allowed success for each path using a case-varied configuration entry, retaining the payload's original spelling for GitHub calls and token claims. Preserve existing no-setting success assertions. Check malformed JSON and missing owner/repo still take existing validation paths with auth disabled; structured invalid schema remains 400.
- [x] Rerun both suites and helper tests; commit as `feat: enforce repository policy on all feedback paths`.

## Task 3: Adversarial authentication and quota proof

**Files:** Existing API/structured tests. **Consumes:** Task 2 guarded routes and existing `createBugDropAuthTokenForTest` export. **Produces:** proof that successful authentication cannot bypass policy, with documented middleware precedence.

- [x] In both suites, create a valid token for the denied fixture repo using the existing signing helper. Use `ENVIRONMENT: 'production'` and a KV stub with `get: vi.fn().mockResolvedValue('0')`, `put: vi.fn().mockResolvedValue(undefined)`, cast via `unknown as KVNamespace` as existing tests do.

```ts
const secret = 'repository-policy-test-secret-at-least-32-bytes';
const now = Math.floor(Date.now() / 1000);
const token = await createBugDropAuthTokenForTest({
  sub: 'policy-test-user', repo: validPayload.repo,
  iat: now, exp: now + 300, jti: 'policy-denial-test',
}, secret);
```

Submit the valid fixture with this bearer token, `AUTH_TOKEN_SECRET: secret`, `ALLOWED_REPOSITORIES: 'approved/repo'`, and the KV stub. Assert 403 and zero GitHub mocks. Assert repository quota writes occurred: authenticated denial currently follows quota accounting.

- [x] Repeat with no bearer token: expect 401 and no repo quota write. Repeat with KV returning `'50'` only for keys starting `repo:` and `'0'` otherwise: valid-token request returns 429 and zero GitHub calls.
- [x] Add denied GET with `AUTH_TOKEN_REQUIRED_FOR_CHECK: 'true'` and no token: expect policy 403 before check auth. Add allowed GET with required auth and no token: expect 401.
- [x] Run the focused suites. Temporarily remove ONLY the structured guard, rerun its valid-token denial test, and require it to fail; restore the guard immediately and rerun. Repeat for the legacy and GET denial tests one guard at a time. Record these mutation results as the strongest bypass proof. Never commit disabled guards.
- [x] Commit tests as `test: prove repository denial survives authentication and quotas`.

## Task 4: Route integration with a network tripwire

**Files:** Create `test/repositoryPolicyIntegration.test.ts`. **Consumes:** real `src/routes/api.ts`; no GitHub module mocks. **Produces:** deterministic API integration evidence with no external writes.

- [x] Import the real API router into a Hono app mounted at `/api`. Use an Env fixture with placeholder GitHub credentials, `ENVIRONMENT: 'development'`, `ALLOWED_ORIGINS: '*'`, `MAX_SCREENSHOT_SIZE_MB: '5'`, `ASSETS: {} as Fetcher`, and `ALLOWED_REPOSITORIES: 'approved/repo'`.
- [x] Stub global fetch with a tripwire, restore globals after each case:

```ts
const network = vi.fn(() => { throw new Error('Unexpected external request'); });
vi.stubGlobal('fetch', network);
```

- [x] Exercise `app.request` at `http://bugdrop.localhost/api/check/blocked/repo` and POST both valid legacy and structured payloads to `/api/feedback`, all targeting `blocked/repo`. Use the structured fixture's required fields (`kind`, `schemaVersion`, `variantId`, `submissionId`, `issue`, `metadata`) exactly as in the existing suite. Assert exact 403 body and `expect(network).not.toHaveBeenCalled()` for every case.
- [x] Include malformed JSON and a health request to verify normal 400/200 behavior with a restrictive list. Do not send allowed requests to a real GitHub client with real credentials.
- [x] Run `npx vitest run test/repositoryPolicyIntegration.test.ts`; this is the local API integration gate. It uses real routing/client imports without starting a server or requiring deployed secrets.
- [x] Commit as `test: verify repository policy before external access`.

## Task 5: Operator documentation and release handoff

**Files:** README, configuration/security MDX, commented `wrangler.toml` examples.

- [x] Add a server-configuration subsection with the full semantics table, deployment-wide scope, no widget attribute, 403 body, and authentication/quota precedence. Explain that an allowlist grants no GitHub permissions and replaces neither auth nor CORS. Explain that blank or `*` disables restriction.
- [x] Add this commented example under each relevant vars block without introducing an active assignment:

```toml
# Optional exact repository allowlist (unset allows all installed repositories).
# ALLOWED_REPOSITORIES = "example-org/app,example-org/feedback"
```

- [x] Explain configuring root, preview, and production environments explicitly rather than assuming vars inheritance. Document listing both names during a transfer and issuing tokens for the actual new repo name; remove the old name after transfer verification.
- [x] Add a short README note linking the self-hosting setting to configuration documentation. Update security documentation with the three guarded paths and limits. Keep personal identities out of all examples.
- [x] Format only changed docs/code; run `npm run validate` and `npm run verify:legacy-compat`. Investigate the recorded package-test baseline failure before declaring full verification. Do not change unrelated code merely to make the plan appear green.
- [x] Verify no active policy was introduced: inspect `git diff -- wrangler.toml` and run `rg -n '^\s*ALLOWED_REPOSITORIES\s*=' wrangler.toml` (expected no matches). Confirm release workflows and credentials are unchanged.
- [x] Run `git diff --check`; inspect the final diff for all three guard placements, no payload mutation, no fork-specific behavior, and no accidental production enablement.
- [x] Commit documentation as `docs: explain optional repository restrictions`.
- [ ] For a later authorized PR, run `codex-pr-review-toolkit:review-pull-request` against the then-current resolved upstream base, including fresh validation of candidates. The investigation's native review failed due to CLI/model incompatibility; ensure a supported native reviewer or report the unresolved review limitation explicitly. Follow current repository CI and merge requirements.

## Acceptance checklist and rollout

- [x] Truth table implemented and tested; missing configuration preserves existing clients.
- [x] All three entry points deny before GitHub access, including authenticated structured feedback.
- [x] Zero upload/issue/lookup calls on denial; network tripwire passes.
- [x] Existing invalid-input handling and auth/quota precedence preserved.
- [x] Default/preview/production configuration remains unrestricted unless an operator opts in.
- [x] Documentation matches executable behavior; no personal-only functionality ported.
- [x] Guard-removal mutation tests fail and restored code passes; retain command receipts.
- [x] Full validation is green or a concrete unresolved baseline blocker is reported without a completion claim.

The implementation should ship as one focused upstream PR containing the capability only. Production activation is a separate operator action: inventory intended repositories, configure the appropriate environment, deploy through the existing release process, and check allowed/denied targets. Any live issue-writing canary requires explicit authorization. Roll back an activation by restoring the prior setting/deployment through that process; removing the setting restores unrestricted compatibility behavior. No activation or deployment is part of this plan-writing task.

## Execution receipt — 2026-09-10

Implemented locally; no remote publication, merge, production activation, or deployment.

- Tests for route enforcement and authentication/quota precedence were consolidated in `test/repositoryPolicyRoutes.test.ts` rather than extending the large existing API/structured suites. Existing suites were also run unchanged.
- Matcher tests first failed on the missing module; six route-denial tests then failed on absent guards (26 other route cases passed). After adding the guards, all four helper/new-route/existing-route suites passed (172 tests).
- Each guard was removed independently and restored in a `finally` block. GET, legacy, and structured suites each failed under the corresponding mutation. Restored policy suites passed 52 tests, including five real-client integration cases asserting no external requests. Logs: `/tmp/allowlist-mutation-0.log`, `/tmp/allowlist-mutation-1.log`, `/tmp/allowlist-mutation-2.log`, `/tmp/allowlist-final-focused.log`.
- Full verification: `HUSKY=0 npm_config_foreground_scripts=false npm run validate` passed lint, formatting, both TypeScript configurations, and 1,649 tests across 105 files. Log: `/tmp/allowlist-validate.log`. `npm run verify:legacy-compat` verified both immutable fixtures and the gzip budget.
- Baseline package failure explained and avoided without a source change: concurrent package tests invoke npm/pacote prepare scripts despite `--ignore-scripts`; Husky's shared Git config write can encounter a lock and print non-JSON output into `npm pack --json`. An isolated locked fixture reproduced the failure. Disabling Husky and foreground lifecycle output for validation avoided both the write and stdout contamination; the two package suites independently passed 35 tests.
- Independent read-only implementation review found no high-confidence issues. This is a local implementation review, not the required pre-merge PR toolkit review. That later gate remains unchecked above.
- `git diff --check` passed; direct inspection and a no-match search for active `ALLOWED_REPOSITORIES` assignments confirmed only comments were added to Wrangler configuration.
- Authentication/quota tests were committed with the route implementation rather than as a separate tests-only commit; behavior and coverage are unchanged from the plan.
