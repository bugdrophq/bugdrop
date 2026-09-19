import { Hono } from 'hono';
import { getInstallationRecord, INSTALLATION_RECORD_PREFIX } from '../lib/installation-analytics';
import { installationCounterWasDeleted } from '../lib/feedback-counter';
import {
  getInstallationUsageRecord,
  installationUsageEnabled,
  installationUsageWasDeleted,
} from '../lib/installation-usage';
import type { Env } from '../types';

const MAX_PAGE_SIZE = 8;
const MAX_CURSOR_LENGTH = 4096;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const adminInstallations = new Hono<{ Bindings: Env }>();

adminInstallations.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

adminInstallations.use('*', async (c, next) => {
  const current = c.env.ADMIN_READ_API_SECRET;
  const previous = c.env.ADMIN_READ_API_PREVIOUS_SECRET;
  if (!validSecret(current) || (previous !== undefined && !validSecret(previous))) {
    return c.json({ error: 'Administrator inventory unavailable' }, 503);
  }
  // This credential belongs to the account backend, never to a browser.
  if (c.req.header('Origin') !== undefined) return c.json({ error: 'Forbidden' }, 403);
  const bearer = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!bearer || (!equalSecret(bearer[1], current) && !equalSecret(bearer[1], previous))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

adminInstallations.get('/installations', async c => {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => key !== 'limit')) {
    return c.json({ error: 'Invalid pagination' }, 400);
  }
  if (params.getAll('limit').length > 1) {
    return c.json({ error: 'Invalid pagination' }, 400);
  }
  const limit = parseLimit(params.get('limit'));
  // Hono's request logger includes the URL; keep opaque KV cursors in a header.
  const cursor = c.req.header('X-BugDrop-Inventory-Cursor') ?? null;
  if (limit === null || (cursor !== null && !validCursor(cursor))) {
    return c.json({ error: 'Invalid pagination' }, 400);
  }

  const store = c.env.INSTALLATION_ANALYTICS;
  if (!installationUsageEnabled(c.env) || !store || !c.env.FEEDBACK_COUNTER) {
    return c.json({ error: 'Administrator inventory unavailable' }, 503);
  }

  try {
    const page = await store.list({
      prefix: INSTALLATION_RECORD_PREFIX,
      limit,
      ...(cursor === null ? {} : { cursor }),
    });
    if (page.keys.length > limit || typeof page.list_complete !== 'boolean') {
      throw new Error('Invalid installation inventory page');
    }
    const nextCursor = page.list_complete ? null : page.cursor;
    if (nextCursor !== null && !validCursor(nextCursor)) {
      throw new Error('Invalid installation inventory cursor');
    }

    const items = [];
    for (const key of page.keys) {
      const installationId = parseInstallationKey(key.name);
      if (await installationUsageWasDeleted(store, installationId)) continue;
      const identity = await getInstallationRecord(store, installationId);
      if (identity === null) continue; // Deleted between list and get.
      const usage = await getInstallationUsageRecord(store, installationId);
      // Repeat the KV check after reading and consult the durable deletion marker.
      if (await installationUsageWasDeleted(store, installationId)) continue;
      if (await installationCounterWasDeleted(c.env, installationId)) continue;
      items.push({
        installationId,
        account: identity.account,
        installedAt: identity.installedAt,
        successfulFeedbackCount: usage?.successfulFeedbackCount ?? null,
      });
    }
    return c.json({ items, nextCursor });
  } catch {
    console.error('[BugDrop] Administrator inventory read failed');
    return c.json({ error: 'Administrator inventory unavailable' }, 503);
  }
});

function parseLimit(value: string | null): number | null {
  if (value === null) return MAX_PAGE_SIZE;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_PAGE_SIZE ? limit : null;
}

function validCursor(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
  );
}

function parseInstallationKey(key: string): number {
  if (!key.startsWith(INSTALLATION_RECORD_PREFIX)) throw new Error('Invalid installation key');
  const suffix = key.slice(INSTALLATION_RECORD_PREFIX.length);
  if (!/^[1-9]\d*$/.test(suffix)) throw new Error('Invalid installation key');
  const installationId = Number(suffix);
  if (!Number.isSafeInteger(installationId)) throw new Error('Invalid installation key');
  return installationId;
}

function validSecret(value: string | undefined): value is string {
  return typeof value === 'string' && SECRET_PATTERN.test(value);
}

function equalSecret(candidate: string, expected: string | undefined): boolean {
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected ?? '');
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export default adminInstallations;
