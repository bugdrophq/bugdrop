# Self-Hosting Guide

Run your own instance of BugDrop with your own GitHub App.

## Prerequisites

- Node.js 22+
- Cloudflare account (free tier works)
- GitHub account

## 1. Create a GitHub App

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
2. Configure:
   - **Name**: Choose a unique name (becomes your app's URL slug)
   - **Homepage URL**: Your worker URL (e.g., `https://bugdrop.you.workers.dev`)
   - **Webhook**: Uncheck "Active" (not needed)
3. Set permissions:
   - **Repository > Issues**: Read & Write
   - **Repository > Contents**: Read & Write
4. Click "Create GitHub App"
5. Note the **App ID** (shown at top)
6. Scroll down and click **"Generate a private key"** (downloads a .pem file)

## 2. Clone, Install, and Configure

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/bugdrop
cd bugdrop
make install

# Configure environment
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your GitHub App credentials:

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...your key content...
-----END RSA PRIVATE KEY-----"
```

Next, keep local configuration in ignored files so your fork does not accumulate noisy diffs.

In `.dev.vars`, uncomment and set your GitHub App slug:

```bash
GITHUB_APP_NAME=your-app-name
```

The committed `wrangler.toml` contains the upstream development defaults used by this repository. For local development, prefer `.dev.vars` overrides instead of editing `wrangler.toml`.

If you want the local test pages under `/test/` to submit to a repository where your GitHub App is installed, copy the local test config example:

```bash
cp public/test/local-config.example.js public/test/local-config.js
```

Then edit `public/test/local-config.js`:

```js
window.BugDropTestConfig = {
  ...(window.BugDropTestConfig || {}),
  repo: 'your-org/your-repo',
};
```

`public/test/local-config.js` is ignored by git. Without it, test pages keep using the upstream test repository `mean-weasel/bugdrop-widget-test`, which is what CI expects.

## 3. Build the Widget

The widget source must be compiled before the dev server can serve it (the built files are not checked into git):

```bash
make build-widget
```

## 4. Run Locally

```bash
make dev
# Opens http://localhost:8787
```

Visit http://localhost:8787/test/ to try the widget.

## 5. Set Up Rate Limiting (Optional)

Rate limiting prevents spam and protects GitHub API quotas. It uses Cloudflare KV for distributed storage.

> **Important:** The `[[kv_namespaces]]` IDs in `wrangler.toml` belong to the upstream deployment and will not work for your account.

For local development, you can leave rate limiting unconfigured. BugDrop disables rate limiting when no `RATE_LIMIT` binding is present.

For production, create your own KV namespaces and update your deployment configuration with the IDs from Wrangler. Do not reuse the upstream IDs committed in this repository.

```bash
# Create KV namespaces
npx wrangler kv:namespace create RATE_LIMIT
npx wrangler kv:namespace create RATE_LIMIT --preview
```

Copy the IDs from the output and update your production deployment configuration:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "<your-production-id>"
preview_id = "<your-preview-id>"
```

**Default limits:**

- 20 requests per 15 minutes per IP
- 50 requests per hour per repository

To customize limits, edit `src/middleware/rateLimit.ts` and the middleware config in `src/routes/api.ts`.

> **Note:** If you skip this step, rate limiting is disabled but the app still works.

## 6. Deploy to Cloudflare

### Manual Deploy

```bash
# Set production secrets
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY
# Optional: require signed host-app auth tokens before accepting feedback
wrangler secret put AUTH_TOKEN_SECRET

# Deploy
make deploy
```

### Repository Release Workflow

Publishing a GitHub Release does not deploy BugDrop. The repository's production workflow has
only an explicit `workflow_dispatch` trigger. It derives the next tag from the latest authenticated
published Release plus the operator-selected SemVer bump; package metadata and commit prefixes are
not release-version authority.

The workflow is tailored to the canonical BugDrop production service, including its protected
environment, Cloudflare target, static-asset origin, and external capability gates. It is disabled
until separately authorized production setup is complete. Self-hosters should use the manual
`make deploy` path above or deliberately adapt and validate the guarded workflow for their own
environment. Do not copy its production settings or assume that creating a tag or Release activates
it. Maintainers of the canonical service should follow [the release runbook](docs/releasing.md).

### Optional Production Heartbeat

Self-hosted deployments do not automatically run BugDrop's production heartbeat. The workflow is
inert until explicitly enabled, and canonical service defaults are accepted only in the upstream
`bugdrophq/bugdrop` repository. A private fork or copy must provide its own Worker origin, fixed
test venue, separate synthetic-Issue repository, GitHub App author, and narrowly scoped verification
credential.

After the deployment is stable, follow the
[self-hosted and private repository heartbeat runbook](docs/production-heartbeat.md#self-hosted-and-private-repositories).
It covers production build identity, private-repository Actions settings, required variables and
secret, a controlled incident exercise, scheduled soak, and four-hour activation. Do not enable the
schedule before the manual success and recovery runs pass and the controlled-failure exercise
produces its expected failed conclusion and incident.

## Configuration

### Environment Variables

| Variable                        | Required | Description                                                                                   |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                 | Yes      | Your GitHub App's numeric ID                                                                  |
| `GITHUB_PRIVATE_KEY`            | Yes      | Private key from GitHub App settings                                                          |
| `ENVIRONMENT`                   | No       | `development` disables rate limiting; `production` enables all checks                         |
| `ALLOWED_ORIGINS`               | No       | Comma-separated allowed domains (default: `*`)                                                |
| `GITHUB_APP_NAME`               | No       | Your app's URL slug for install links                                                         |
| `MAX_SCREENSHOT_SIZE_MB`        | No       | Max screenshot size in MB (default: `5`)                                                      |
| `CATEGORY_LABELS`               | No       | JSON mapping from repos/categories to GitHub labels                                           |
| `ALLOW_CLIENT_CATEGORY_LABELS`  | No       | Set to `true` to trust `data-category-labels` from your own pages                             |
| `ROOT_REDIRECT_URL`             | No       | Landing page URL for `/` redirects (default: `https://bugdrop.dev`)                           |
| `AUTH_TOKEN_SECRET`             | No       | HMAC secret that requires signed host-app tokens for `/feedback`                              |
| `AUTH_TOKEN_ADDITIONAL_SECRETS` | No       | Comma/newline-separated extra HMAC secrets accepted during rotation or multi-app self-hosting |
| `AUTH_TOKEN_AUDIENCE`           | No       | Expected token `aud` claim, usually your BugDrop worker hostname                              |
| `AUTH_TOKEN_ISSUER`             | No       | Expected token `iss` claim, usually your app hostname                                         |
| `AUTH_TOKEN_REQUIRED_FOR_CHECK` | No       | Set to `true` to require auth tokens for `/check/:owner/:repo` too                            |
| `RATE_LIMIT`                    | No       | KV namespace binding for rate limiting (see section 5)                                        |

### Custom Category Labels

For authoritative mappings, configure labels on the worker. Two JSON shapes are supported.

**Flat** — applies to every repo your worker serves:

```toml
[vars]
CATEGORY_LABELS = '{"bug":["defect","frontend"],"feature":"product-feedback","question":"support"}'
```

**Per-repo** with optional `"*"` wildcard fallback:

```toml
[vars]
CATEGORY_LABELS = '{"owner/repo":{"bug":["defect","frontend"]},"*":{"bug":"triage"}}'
```

The shape is detected automatically: top-level keys containing `/` or equal to `*` are treated as repos; otherwise the object is treated as flat.

Validation rules:

- Recognized categories: `bug`, `feature`, `question`. Unknown keys are dropped with a warning.
- Each category accepts a single label or an array of **1-5** labels.
- Each label must be **1-50 characters** after trimming (matching GitHub's label-name limit). Whitespace-only labels and labels containing control characters (newlines, NUL, etc.) are rejected.
- Every issue also receives the `bugdrop` label automatically.

Self-hosted deployments can also opt into script-tag mappings by setting `ALLOW_CLIENT_CATEGORY_LABELS = "true"` (case-sensitive — values like `"True"`, `"1"`, or `"yes"` keep the gate closed) and using `data-category-labels` on pages you control. Only enable this when your worker is locked down to trusted origins.

When both are set, `CATEGORY_LABELS` takes precedence: the worker uses the server-side mapping and ignores `data-category-labels`. If `CATEGORY_LABELS` is set but unusable (malformed JSON, wrong shape, or a per-repo map with no entry for the current repo and no `"*"` fallback), the worker falls back to default GitHub labels and surfaces a warning in the issue body — it does **not** fall through to the browser-supplied mapping. This keeps a typo in your env config from silently handing label control back to the page.

Warnings emitted during label resolution are also written to worker logs (visible via `wrangler tail`) and returned in the `/feedback` success response under `labelMappingWarnings` so monitoring can detect misconfigurations without parsing issue bodies.

### Locking Down Allowed Origins (Recommended)

> **Security:** When self-hosting, you should always set `ALLOWED_ORIGINS` to only the domains where you embed the widget. The default `"*"` allows any website to submit requests to your worker — meaning anyone who discovers your worker URL could create issues on repos where your app is installed (subject to rate limits).

For self-hosted deployments, restrict origins to your known domains:

```toml
[vars]
ENVIRONMENT = "production"
ALLOWED_ORIGINS = "https://mysite.com,https://app.mysite.com"
GITHUB_APP_NAME = "my-bugdrop-app"
```

Only list the exact origins (scheme + host) of sites where you embed the BugDrop widget. The worker validates the `Origin` header on incoming requests and rejects any not in this list.

> **Note:** `ALLOWED_ORIGINS` is a CORS-level check — it only blocks browser-based cross-origin requests. Direct API calls (curl, scripts) don't send an `Origin` header and bypass CORS entirely. Rate limiting (section 5) is your primary defense against non-browser abuse.

### Requiring Host-App Auth Tokens (Recommended for Private Apps)

For self-hosted deployments embedded in authenticated apps, add a short-lived signed token so the worker only accepts feedback from users your app has already authorized. This is stronger than CORS alone because direct API callers must also produce a valid token.

Set a long random secret on the BugDrop worker:

```bash
wrangler secret put AUTH_TOKEN_SECRET
```

Use the exact same secret bytes in the host app that mints BugDrop tokens. The worker and
host-app signing secret must be byte-for-byte identical, including whitespace. Prefer a long
random no-newline value, and avoid shell or file flows that append a trailing newline. For
example, when setting a known value with Wrangler:

```bash
printf '%s' "$secret" | wrangler secret put AUTH_TOKEN_SECRET
```

Use an equivalent no-newline secret-setting flow for your host app platform. If your host app
successfully returns a `bd1` token but the worker logs `Invalid token signature`, check for a
secret mismatch, trailing newline, or quoting difference before debugging token claims.

Then set optional claim checks in your worker vars:

```toml
[vars]
AUTH_TOKEN_AUDIENCE = "bugdrop.your-subdomain.workers.dev"
AUTH_TOKEN_ISSUER = "app.yourdomain.com"
AUTH_TOKEN_REQUIRED_FOR_CHECK = "true"
```

When `AUTH_TOKEN_SECRET` or `AUTH_TOKEN_ADDITIONAL_SECRETS` is set, `/feedback` requires an `Authorization: Bearer <token>` header. `/check/:owner/:repo` remains public by default for backwards compatibility; set `AUTH_TOKEN_REQUIRED_FOR_CHECK = "true"` if even installation status should be visible only to authenticated users.

Use `AUTH_TOKEN_ADDITIONAL_SECRETS` when rotating tokens or when one self-hosted worker is shared by multiple authenticated host apps. Keep the existing `AUTH_TOKEN_SECRET` as the primary secret, then add comma- or newline-separated additional secrets so newly migrated apps can verify without breaking apps that still sign with the primary value.

Your application should expose a same-origin endpoint that returns a token only after checking its own session:

```js
window.getBugDropToken = async function getBugDropToken() {
  const response = await fetch('/api/bugdrop-token', { credentials: 'include' });
  if (!response.ok) throw new Error('Unable to create BugDrop token');
  const { token } = await response.json();
  return token;
};
```

Then point the widget at that global function:

```html
<script
  src="https://bugdrop.your-subdomain.workers.dev/widget.js"
  data-repo="owner/repo"
  data-auth-token-provider="getBugDropToken"
></script>
```

Tokens use a compact HMAC-SHA256 format with a `bd1` prefix. The payload is JSON with these claims:

```json
{
  "iss": "app.yourdomain.com",
  "aud": "bugdrop.your-subdomain.workers.dev",
  "sub": "user_123",
  "repo": "owner/repo",
  "iat": 1779700000,
  "exp": 1779700300,
  "jti": "unique-token-id"
}
```

Use short expirations, usually 5 minutes or less. The `repo` claim must exactly match the widget's `data-repo` value. `sub` and `jti` are not persisted by BugDrop today, but including them gives you useful audit material in your own token issuer logs.

### Root URL Redirect

By default, the worker redirects `/` to `https://bugdrop.dev` (the upstream landing page). For self-hosted deployments, set `ROOT_REDIRECT_URL` instead of editing source code.

`ROOT_REDIRECT_URL` must be an `http` or `https` URL. Invalid values are ignored with a worker log warning, and `/` falls back to `https://bugdrop.dev`.

Local `.dev.vars`:

```bash
ROOT_REDIRECT_URL=https://example.com
```

Production `wrangler.toml`:

```toml
[vars]
ROOT_REDIRECT_URL = "https://example.com"
```

## Commands

```bash
make help        # Show all commands
make dev         # Start dev server (localhost:8787)
make check       # Run lint, typecheck, knip
make test        # Run unit tests
make test-e2e    # Run E2E tests
make ci          # Run full CI pipeline
make build-all   # Build widget + worker
make deploy      # Deploy to Cloudflare
```

## Project Structure

```
src/
├── index.ts           # Worker entry
├── routes/api.ts      # API endpoints
├── lib/github.ts      # GitHub API
└── widget/            # Client widget
    ├── index.ts       # Entry point
    ├── ui.ts          # UI + theming
    ├── screenshot.ts  # Capture
    ├── picker.ts      # Element selection
    └── annotator.ts   # Drawing tools
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Hono
- **Auth**: GitHub App (installation tokens)
- **Widget**: TypeScript IIFE in Shadow DOM
- **Testing**: Vitest + Playwright
