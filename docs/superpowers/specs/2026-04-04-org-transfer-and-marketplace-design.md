# BugDrop Org Transfer & Marketplace Listing — Design Spec

**Date:** 2026-04-04
**Status:** Draft

## Goal

Transfer bugdrop and feedback-widget-test from `neonwatty` (personal account) to `mean-weasel` (organization), create a new `bugdrop` GitHub App under the org, set up the Vercel preview deployment pipeline, and list the app on the GitHub Marketplace.

## Why

- GitHub merge queue (needed for serialized preview E2E tests) requires an org repo
- GitHub Marketplace listing requires the app to be owned by an org
- Consolidates project identity under the mean-weasel org

## ⚠ Immediate action: daily cron is failing

`live-tests.yml` is already merged with a `schedule: '0 6 * * *'` trigger, but contains two unresolved placeholders (`<STABLE_VERCEL_PREVIEW_URL>`, `<ACCOUNT>`). The cron fails on every run. Either merge a hotfix PR removing the `schedule` trigger until Phase 3 Step 4 fills in the placeholders, or prioritize Phase 3 Step 4 before starting Phase 1.

## What stays the same

- **Cloudflare Workers URL**: `bugdrop.neonwatty.workers.dev` — unchanged, existing user embeds keep working
- **Widget behavior**: zero user-facing impact
- **GitHub redirects**: GitHub auto-redirects all `neonwatty/bugdrop` URLs (web, git, API) to `mean-weasel/bugdrop`

## Blast radius

External references found via GitHub code search:

| Reference | Location | Impact |
|-----------|----------|--------|
| App install URL (`neonwatty-bugdrop`) | `neonwatty/blog`, `mean-weasel/growth` | Own repos — update manually |
| Widget embed URL | `mean-weasel/growth` (2 docs) | Own repo — update manually |
| External users | None found in public code search | Low risk |

Current GitHub App installations: exact count unknown (requires app-level JWT auth — enumerated in Phase 1 before any destructive action).

---

## Phase 1: Pre-flight & GitHub Transfers (manual)

### Step 1: Enumerate existing installations

Before any changes, determine who has `neonwatty-bugdrop` installed:

```bash
# Generate JWT from old app's private key, then:
curl -H "Authorization: Bearer $JWT" \
  https://api.github.com/app/installations
```

Record the full list. This determines whether the old app needs a parallel transition period (Phase 2, Step 6) or can be deleted immediately.

### Step 2: Transfer repos

Transfer both repos via GitHub UI (Settings → Danger Zone → Transfer):

| From | To |
|------|----|
| `neonwatty/bugdrop` | `mean-weasel/bugdrop` |
| `neonwatty/feedback-widget-test` | `mean-weasel/feedback-widget-test` |

GitHub automatically:
- Sets up redirects from old URLs to new URLs (git, web, API)
- Transfers all issues, PRs, releases, stars, watchers
- Transfers repo-level secrets (they stay attached to the repo)

### Step 3: Update local git remotes

GitHub redirects handle the old URLs, but update local clones to avoid confusion:

```bash
# In bugdrop local clone:
git remote set-url origin git@github.com:mean-weasel/bugdrop.git

# In feedback-widget-test local clone:
git remote set-url origin git@github.com:mean-weasel/feedback-widget-test.git
```

### Step 4: Post-transfer smoke test

Immediately after transfer, verify the production worker is unaffected:

```bash
curl -sfo /dev/null https://bugdrop.neonwatty.workers.dev/api/health && echo "OK"
```

Also verify CI secrets transferred:
- Check `mean-weasel/bugdrop` → Settings → Secrets and variables → Actions in the GitHub UI
- Confirm `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present
- Optionally, push a trivial commit to a feature branch to trigger a CI run and confirm the workflow passes

If either check fails, stop and fix before proceeding.

### Step 5: Create new GitHub App under org

Create a new GitHub App at `https://github.com/organizations/mean-weasel/settings/apps/new`:

| Field | Value |
|-------|-------|
| Name | `BugDrop` (slug will be `bugdrop` — verified available 2026-04-04, re-verify before executing) |
| Homepage URL | `https://github.com/mean-weasel/bugdrop` |
| Webhook | Disable (not used — the app only needs installation tokens) |
| Permissions | Repository: Contents (read & write), Issues (read & write), Metadata (read) |
| Where can this app be installed? | Any account |

Generate a private key and note the App ID.

> **Note on permissions:** `Contents: write` is needed only for screenshot uploads to the `bugdrop-screenshots` branch. This grants push access to any branch on installed repos. Accept this risk explicitly, or consider a narrower scope in a future iteration.

### Step 6: Install new app on both repos

Install the `bugdrop` app on `mean-weasel/bugdrop` and `mean-weasel/feedback-widget-test`.

---

## Phase 2: Update References, Deploy & Rotate Secrets

**Critical sequencing rule:** The code deploy with updated app slug references MUST land before the Cloudflare secret rotation. If secrets are rotated first, the widget still hardcodes `neonwatty-bugdrop` as the install URL while the backend authenticates as the new app — causing 403 failures for all submissions and contradictory error messages.

### Step 1: bugdrop repo code changes

Two PRs — one per repo. These PRs are independent and can be prepared in parallel. The sequencing constraint (code deploy before secret rotation) applies only to the bugdrop PR (Step 4). The feedback-widget-test PR can merge at any time after Phase 1.

**Replacements:**

| Find | Replace | Files affected |
|------|---------|----------------|
| `neonwatty/bugdrop` | `mean-weasel/bugdrop` | README, CONTRIBUTING, TERMS, PRIVACY, api.ts, ui.ts, public/index.html |
| `neonwatty/feedback-widget-test` | `mean-weasel/feedback-widget-test` | test HTML files (`public/test/*.html`), e2e tests |
| `neonwatty-bugdrop` (app slug) | `bugdrop` | wrangler.toml, src/widget/index.ts, public/index.html, README |
| `neonwatty@gmail.com` | `jeremy@mean-weasel.com` | SECURITY.md (keep both addresses until new mailbox is confirmed active) |
| `Built by <a href="https://github.com/neonwatty" target="_blank">neonwatty</a>` | `Built by <a href="https://github.com/mean-weasel" target="_blank">mean-weasel</a>` | public/index.html |

> **Deferred replacement:** `neonwatty.github.io/feedback-widget-test/` → Vercel production URL. This depends on Phase 3 (Vercel setup). Handle in Phase 3, Step 5 after the URL is known.

**Special cases requiring careful edits (not blind find-replace):**

- `src/widget/index.ts:641-643` — hardcoded domain check for app name:
  ```typescript
  const appName = config.apiUrl.includes('bugdrop.neonwatty.workers.dev')
    ? 'neonwatty-bugdrop'
  ```
  Update the fallback app name to `bugdrop`. The domain check stays as-is (CF Workers URL unchanged).

- `src/routes/api.ts:261` — hardcoded repo link in issue body footer:
  ```typescript
  *Submitted via [BugDrop](https://github.com/neonwatty/bugdrop)*
  ```
  Update to `mean-weasel/bugdrop`.

- `wrangler.toml` — top-level `GITHUB_APP_NAME` var:
  ```toml
  GITHUB_APP_NAME = "bugdrop"
  ```
  Also update `[env.preview.vars]` section.

- `github.com/apps/neonwatty-bugdrop/installations/new` → `github.com/apps/bugdrop/installations/new` (README, public/index.html)

**Do NOT change:**
- `bugdrop.neonwatty.workers.dev` — CF Workers URL stays unchanged (appears in `test/widgetApiUrl.test.ts`, `SECURITY.md:25`, `src/widget/index.ts`, and elsewhere)
- CHANGELOG version comparison URLs — historical references, GitHub redirects handle them
- `docs/plans/**/*.md`, `docs/superpowers/plans/**/*.md`, `docs/superpowers/specs/**/*.md` — historical docs, GitHub redirects handle them

### Step 2: feedback-widget-test repo code changes

**Replacements:**

| Find | Replace | Files affected |
|------|---------|----------------|
| `neonwatty/bugdrop` | `mean-weasel/bugdrop` | App.tsx, index.html, README |
| `neonwatty/feedback-widget-test` | `mean-weasel/feedback-widget-test` | App.tsx, index.html, README |
| `neonwatty-bugdrop` (app slug) | `bugdrop` | App.tsx, README |

> **Deferred:** `neonwatty.github.io/feedback-widget-test/` replacement — handle in Phase 3, Step 5.

**Do NOT change:**
- `bugdrop.neonwatty.workers.dev` in vite.config.ts default — CF Workers URL stays unchanged

### Step 3: External repos (manual, low priority)

Update references in own repos found via code search:
- `neonwatty/blog` — blog post referencing app install URL
- `mean-weasel/growth` — 2 docs referencing widget embed URL and app install URL

### Step 4: Deploy updated code to Cloudflare Workers

After the bugdrop repo PR merges to `main`, the CI pipeline (`ci.yml` → Release → Deploy to Cloudflare) automatically deploys to production. Monitor the workflow run in GitHub Actions to confirm success.

Verify the deploy succeeded and the widget serves the updated install URL:
```bash
curl -s https://bugdrop.neonwatty.workers.dev/widget.js | grep -o 'apps/[^/]*'
# Should show: apps/bugdrop
```

### Step 5: Rotate Cloudflare Workers secrets (AFTER code deploy)

Only after Step 4 confirms the updated code is live:

```bash
wrangler secret put GITHUB_APP_ID        # new app ID
wrangler secret put GITHUB_PRIVATE_KEY   # new app private key
```

Immediately after rotation, revoke the old app's private key (the old app can remain listed for its redirect notice without a valid signing key).

### Step 6: Handle existing app users

Based on the installation list from Phase 1, Step 1: if no external installs were found, delete the old app. Otherwise, add a redirect notice to the old app's description pointing to the new `bugdrop` app, open a GitHub issue on each affected repo with the new install URL, keep the old app listed for 30 days (private key already revoked — it cannot mint tokens), then delete it.

---

## Phase 3: Vercel + CF Workers Preview Setup

### Step 1: Import feedback-widget-test into Vercel

1. Go to vercel.com/new, import `mean-weasel/feedback-widget-test`
2. Vercel auto-detects Vite — no config needed
3. Set environment variables in Vercel project settings:

   | Variable | Production | Preview |
   |----------|-----------|---------|
   | `VITE_BUGDROP_URL` | `https://bugdrop.neonwatty.workers.dev` | `https://bugdrop-preview.neonwatty.workers.dev` |

4. The `base: '/feedback-widget-test/'` in vite.config.ts must be removed for Vercel (serves from root). This is handled in Step 5 alongside the GitHub Pages disable — do not remove it separately or the Pages deployment breaks in between.

### Step 2: Get stable Vercel preview URL

Deploy a `preview` branch once:
```bash
git checkout -b preview
git push -u origin preview
```

Note the **actual** stable URL Vercel generates — the format varies by account type (e.g., `feedback-widget-test-git-preview-mean-weasel.vercel.app` or `feedback-widget-test-git-preview-mean-weasels-projects.vercel.app`). Record the real URL from the Vercel dashboard.

If the Vercel project has Deployment Protection enabled (Settings → Deployment Protection), generate a bypass secret and add it as a GitHub Actions secret (`VERCEL_AUTOMATION_BYPASS_SECRET`) in `mean-weasel/bugdrop`. The Playwright `chromium-live` config sends this as an `x-vercel-protection-bypass` header when available.

### Step 3: Set up CF Workers preview environment

In `mean-weasel/bugdrop`:

> **Note:** The top-level `[[kv_namespaces]]` already has `preview_id = "ff8f3809037d4403befd09369a9f7e36"` — that's for `wrangler dev` (local development) only. The deployed preview worker (`bugdrop-preview`) needs its own KV namespace binding in `[env.preview.kv_namespaces]`, so create a new one:

```bash
wrangler kv namespace create RATE_LIMIT --env preview
# Use returned ID to replace <PREVIEW_KV_ID> in wrangler.toml

# Same app credentials as production (the `bugdrop` app from Phase 1, Step 5):
wrangler secret put GITHUB_APP_ID --env preview
wrangler secret put GITHUB_PRIVATE_KEY --env preview

wrangler deploy --env preview --dry-run  # verify [assets] inheritance
```

> If the dry-run shows `[assets]` is not inherited by the preview environment, add an explicit `[env.preview.assets]` section with `directory = "public"` and `binding = "ASSETS"`.

### Step 4: Fill in placeholders and guard the daily cron

Update `live-tests.yml`:
- Replace `<STABLE_VERCEL_PREVIEW_URL>` with the URL from Step 2
- Replace `<ACCOUNT>` with `neonwatty` (CF account subdomain — unchanged)
- Add `VERCEL_AUTOMATION_BYPASS_SECRET` env var to the Playwright step so the bypass header reaches the browser:
  ```yaml
  - name: Run live E2E tests
    run: npx playwright test --project=chromium-live --workers=1
    env:
      VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
  ```

Update `wrangler.toml`:
- Replace `<PREVIEW_KV_ID>` with the ID from Step 3

**⚠ Blocking:** The daily cron in `live-tests.yml` (`schedule: '0 6 * * *'`) runs against these URLs. The workflow file is already merged, so the cron is failing on every run until placeholders are filled. Complete this step promptly, or remove the `schedule` trigger in a hotfix PR until you're ready.

### Step 5: Disable GitHub Pages and back-fill URLs for feedback-widget-test

Once Vercel is serving both production and preview, create a **single PR** in feedback-widget-test that:
1. Removes `base: '/feedback-widget-test/'` from vite.config.ts (noted in Step 1 — must ship together with the Pages disable)
2. Removes `.github/workflows/deploy.yml` (GitHub Pages workflow)
3. Replaces `neonwatty.github.io/feedback-widget-test/` with the Vercel production URL in README
4. Disables GitHub Pages in repo settings
5. Updates the Vercel production domain if desired

Then in bugdrop, create a separate PR to back-fill the remaining deferred replacements:

| Find | Replace | Files |
|------|---------|-------|
| `neonwatty.github.io/feedback-widget-test/` | Vercel production URL | README, public/index.html |

### Step 6: Validate preview pipeline end-to-end

Before enabling the merge queue, confirm the full pipeline works:

```bash
wrangler deploy --env preview       # deploy preview worker
# Trigger a Vercel preview deploy on the preview branch
# Run: npx playwright test --project=chromium-live --workers=1
```

At least one successful run of the live tests workflow is required before proceeding.

### Step 7: Enable merge queue

In `mean-weasel/bugdrop` repo settings:
- Rules → Branch protection for `main` → Require merge queue
- After 2-week bake period with successful daily cron runs: add `Live Preview Tests / Live E2E Tests` as required check

---

## Phase 4: Lock Down & Marketplace Listing

### Step 1: Lock down ALLOWED_ORIGINS

Before the Marketplace listing exposes the app to a wider audience, replace `ALLOWED_ORIGINS = "*"` in the top-level `[vars]` section of `wrangler.toml`:

```toml
# wrangler.toml — top-level vars (used by production deploy):
[vars]
ENVIRONMENT = "development"
ALLOWED_ORIGINS = "https://your-allowed-domains.com"  # comma-separated
```

The preview environment keeps `"*"` in its own `[env.preview.vars]` since it's only used for testing. Do **not** use `[env.production.vars]` — production deploys via `wrangler deploy` (no `--env` flag) and reads from the top-level `[vars]` section. Adding `[env.production.vars]` would require changing the CI pipeline to pass `--env production`.

> **Why this matters:** With `ALLOWED_ORIGINS = "*"`, anyone can POST to `/api/feedback` from any domain and create issues on any repo where the app is installed. The `/api/check/:owner/:repo` endpoint also leaks installation status to any origin. The 10/15min IP rate limit is the only brake.

### Step 2: Prerequisites

- App owned by org (Phase 1)
- App has a description, logo, and homepage URL
- Terms of service URL: `https://github.com/mean-weasel/bugdrop/blob/main/TERMS.md`
- Privacy policy URL: `https://github.com/mean-weasel/bugdrop/blob/main/PRIVACY.md`
- Support URL: `https://github.com/mean-weasel/bugdrop/issues`

### Step 3: Prepare listing assets

- **Logo**: create or use existing BugDrop logo (square, at least 200x200px)
- **Description**: "In-app feedback → GitHub Issues. Screenshots, annotations, the works."
- **Categories**: Developer Tools, Code Review
- **Pricing**: Free

### Step 4: Publish to Marketplace

1. Go to the app settings → Marketplace listing
2. Fill in all required fields
3. Add screenshots showing the widget in action
4. Set pricing plan to Free
5. Submit for review (GitHub reviews Marketplace submissions)

### Step 5: Update docs with Marketplace links

- Add Marketplace badge to README
- Update installation instructions to point to `github.com/marketplace/bugdrop`
- Update `public/index.html` install links

---

## Sequencing constraints

- Phase 2, Step 4 (code deploy) MUST complete before Phase 2, Step 5 (secret rotation)
- Phase 3, Step 5 (Pages disable + URL back-fill) depends on Phase 3, Step 2 (Vercel URL)
- Phase 3, Step 7 (merge queue) depends on Phase 3, Step 6 (validated pipeline run)
- Phase 4, Step 1 (ALLOWED_ORIGINS lockdown) should precede Phase 4, Step 4 (Marketplace publish)
- Phases 2 (through Step 3) and 3 (through Step 1) can start in parallel after Phase 1

---

## Rollback plan

If something goes wrong after transfer:
- **Production widget keeps working** — CF Workers URL is unaffected regardless of GitHub state
- **GitHub redirects are durable** — `neonwatty` is a personal account, so no one else can create `neonwatty/bugdrop` to hijack the redirect
- **Old GitHub App is revoked but listed** — it can't mint tokens, but the notice pointing to the new app remains visible
- **Repos can be transferred back** to `neonwatty` if needed
- **Partial Phase 2 rollback** — if references are partially updated and you need to revert, the GitHub auto-redirects mean both old and new org references resolve correctly; the inconsistency is cosmetic
