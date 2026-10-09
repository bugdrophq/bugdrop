import { Hono } from 'hono';
import type { Env } from '../types';
import { countInstallationCreated } from '../lib/installation-acquisition';
import {
  confirmGitHubInstallationIsInactive,
  deleteInstallationData,
  verifyGitHubWebhookSignature,
} from '../lib/installation-retention';
import {
  createInstallationRecord,
  isCanonicalGitHubProfileUrl,
  isGitHubAccountLogin,
  isInstallationAccountType,
  type NewInstallationRecord,
} from '../lib/installation-analytics';

interface GitHubWebhookDependencies {
  confirmInstallationIsInactive?: (env: Env, installationId: number) => Promise<boolean>;
}

export function createGitHubWebhook(dependencies: GitHubWebhookDependencies = {}) {
  const githubWebhook = new Hono<{ Bindings: Env }>();
  const confirmInstallationIsInactive =
    dependencies.confirmInstallationIsInactive ?? confirmGitHubInstallationIsInactive;

  githubWebhook.post('/github/webhook', async c => {
    const secret = c.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return c.json({ error: 'GitHub webhook is not configured' }, 503);
    }

    const body = await c.req.text();
    const signatureIsValid = await verifyGitHubWebhookSignature(
      secret,
      c.req.header('x-hub-signature-256'),
      body
    );
    if (!signatureIsValid) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const event = c.req.header('x-github-event');
    if (!event) {
      return c.json({ error: 'Missing GitHub event type' }, 400);
    }
    if (event !== 'installation') {
      return c.json({ accepted: true }, 202);
    }

    const payload = parseInstallationPayload(body);
    if (!payload) {
      return c.json({ error: 'Invalid installation webhook payload' }, 400);
    }
    if (payload.kind === 'ignored') {
      return c.json({ accepted: true }, 202);
    }

    const store = c.env.INSTALLATION_ANALYTICS;
    if (!store) {
      return c.json({ error: 'Installation identity storage is unavailable' }, 503);
    }

    if (payload.kind === 'created') {
      try {
        await countInstallationCreated(c.env, payload.installation);
      } catch {
        return c.json({ error: 'Installation acquisition is unavailable' }, 503);
      }
      if (await confirmInstallationIsInactive(c.env, payload.installation.installationId)) {
        return c.json({ accepted: true }, 202);
      }
      await createInstallationRecord(store, payload.installation);
      if (await confirmInstallationIsInactive(c.env, payload.installation.installationId)) {
        await deleteInstallationData(c.env, payload.installation.installationId);
        return c.json({ accepted: true }, 202);
      }
      return c.json({ created: true }, 201);
    }

    await deleteInstallationData(c.env, payload.installation.installationId);
    return c.json({ deleted: true }, 200);
  });

  return githubWebhook;
}

type InstallationPayload =
  | { kind: 'created'; installation: NewInstallationRecord }
  | { kind: 'deleted'; installation: { installationId: number } }
  | { kind: 'ignored'; installation: { installationId: number } };

function parseInstallationPayload(body: string): InstallationPayload | null {
  try {
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object') return null;
    const candidate = payload as {
      action?: unknown;
      installation?: {
        id?: unknown;
        account?: { login?: unknown; type?: unknown; html_url?: unknown };
        created_at?: unknown;
      };
    };
    const id = candidate.installation?.id;
    if (
      typeof candidate.action !== 'string' ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0
    ) {
      return null;
    }
    if (candidate.action !== 'created') {
      return {
        kind: candidate.action === 'deleted' ? 'deleted' : 'ignored',
        installation: { installationId: id },
      };
    }

    const account = candidate.installation?.account;
    const installedAt = normalizeGitHubDate(candidate.installation?.created_at);
    if (
      !account ||
      typeof account.login !== 'string' ||
      !isGitHubAccountLogin(account.login) ||
      !isInstallationAccountType(account.type) ||
      typeof account.html_url !== 'string' ||
      !isCanonicalGitHubProfileUrl(account.html_url, account.login) ||
      !installedAt
    ) {
      return null;
    }

    return {
      kind: 'created',
      installation: {
        installationId: id,
        account: {
          login: account.login,
          type: account.type,
          profileUrl: account.html_url,
        },
        installedAt,
      },
    };
  } catch {
    return null;
  }
}

function normalizeGitHubDate(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export default createGitHubWebhook();
