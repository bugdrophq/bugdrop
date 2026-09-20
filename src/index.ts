import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { Env } from './types';
import api from './routes/api';
import githubWebhook from './routes/github-webhook';
import { createBoardDogfoodToken } from './lib/boardDogfood';
import { sweepInstallationRecords } from './lib/installation-retention';
import { listActiveGitHubInstallations } from './lib/github-installation-inventory';
import { reconcileInstallationRecords } from './lib/installation-reconciliation';

export { FeedbackCounter } from './lib/feedback-counter';

const app = new Hono<{ Bindings: Env }>();

// Log warning about missing credentials (but don't block non-authenticated routes)
let envChecked = false;
app.use('*', async (c, next) => {
  if (!envChecked) {
    const missing: string[] = [];
    if (!c.env.GITHUB_APP_ID) missing.push('GITHUB_APP_ID');
    if (!c.env.GITHUB_PRIVATE_KEY) missing.push('GITHUB_PRIVATE_KEY');

    if (missing.length > 0) {
      console.warn(
        `[BugDrop] Missing env vars (feedback endpoint will fail): ${missing.join(', ')}`
      );
    }

    // Warn about development-only settings
    if (c.env.ALLOWED_ORIGINS === '*' && c.env.ENVIRONMENT !== 'development') {
      console.warn('WARNING: ALLOWED_ORIGINS is set to "*" in non-development environment');
    }
    if (isWeakAuthTokenSecret(c.env.AUTH_TOKEN_SECRET)) {
      console.warn(
        '[BugDrop] AUTH_TOKEN_SECRET should be a long random value of at least 32 characters.'
      );
    }
    if (hasWeakAdditionalAuthTokenSecret(c.env.AUTH_TOKEN_ADDITIONAL_SECRETS)) {
      console.warn(
        '[BugDrop] AUTH_TOKEN_ADDITIONAL_SECRETS contains a value shorter than 32 characters.'
      );
    }

    envChecked = true;
  }
  return next();
});

// Request logging
app.use('*', logger());

// Mount API routes
app.route('/api', api);
app.route('/api', githubWebhook);

export function isWeakAuthTokenSecret(secret?: string): boolean {
  return typeof secret === 'string' && secret.length > 0 && secret.length < 32;
}

export function hasWeakAdditionalAuthTokenSecret(value?: string): boolean {
  if (!value) return false;
  return value
    .split(/[,\n]/)
    .map(secret => secret.trim())
    .some(isWeakAuthTokenSecret);
}

export function resolveRootRedirectUrl(rawUrl?: string): string {
  if (!rawUrl) {
    return 'https://bugdrop.dev';
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return rawUrl;
    }
  } catch {
    // Fall through to the hosted default.
  }

  console.warn(`[BugDrop] Ignoring invalid ROOT_REDIRECT_URL: ${rawUrl}`);
  return 'https://bugdrop.dev';
}

// Redirect to landing page on Vercel
app.get('/', c => {
  return c.redirect(resolveRootRedirectUrl(c.env.ROOT_REDIRECT_URL), 301);
});

app.get('/board-dogfood', c => {
  const viewer = c.req.query('viewer');
  const suffix = viewer ? `?viewer=${encodeURIComponent(viewer)}` : '';
  return c.redirect(`/board${suffix}`, 302);
});

app.get('/board', c => {
  return serveAsset(c, '/board/index.html');
});

app.get('/board/', c => {
  return serveAsset(c, '/board/index.html');
});

app.get('/board/assets/*', c => {
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get('/api/bugdrop-board-token', async c => {
  try {
    const token = await createBoardDogfoodToken(c.env, c.req.query('viewer') ?? null);
    return c.json({ token }, 200, {
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'BugDrop Board dogfood token failed' },
      503,
      {
        'Cache-Control': 'no-store',
      }
    );
  }
});

// Serve widget.js from static assets
app.get('/widget.js', async c => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Local self-hosting override. If the ignored file is absent, return an empty
// script so test fixtures do not emit missing-resource console errors.
app.get('/test/local-config.js', async c => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.ok) {
    return response;
  }
  return new Response('', {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
    },
  });
});

function serveAsset(c: { env: Env; req: { raw: Request } }, pathname: string): Promise<Response> {
  const url = new URL(c.req.raw.url);
  url.pathname = pathname;
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
}

export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  await sweepInstallationRecords(env, {
    listActiveInstallationIds: async () => {
      const inventory = await listActiveGitHubInstallations(env);
      await reconcileInstallationRecords(env, { mode: 'apply', inventory });
      return new Set(inventory.installationIds);
    },
  });
}

export default {
  fetch: app.fetch,
  scheduled,
};
