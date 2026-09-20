import { describe, expect, it, vi } from 'vitest';
import adminInstallations from '../src/routes/admin-installations';
import worker from '../src/index';
import type { Env } from '../src/types';

const SECRET = 'A'.repeat(43);
const PREVIOUS_SECRET = 'B'.repeat(43);
const identity = (id: number) =>
  JSON.stringify({
    schemaVersion: 1,
    installationId: id,
    account: {
      login: `customer-${id}`,
      type: 'Organization',
      profileUrl: `https://github.com/customer-${id}`,
    },
    installedAt: '2026-09-01T00:00:00.000Z',
  });
const usage = (id: number, count: number) =>
  JSON.stringify({ schemaVersion: 1, installationId: id, successfulFeedbackCount: count });

function createStore(values: Map<string, string>) {
  const list = vi.fn(async (options: { prefix: string; limit: number; cursor?: string }) => {
    const keys = [...values.keys()].filter(key => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const selected = keys.slice(start, start + options.limit);
    const next = start + selected.length;
    return {
      keys: selected.map(name => ({ name })),
      list_complete: next >= keys.length,
      cursor: next >= keys.length ? undefined : String(next),
      cacheStatus: null,
    };
  });
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  return { store: { list, get } as unknown as KVNamespace, list, get };
}

function createCounter(deletedIds = new Set<number>()) {
  const fetch = vi.fn(async (_url: string, id: number) =>
    Response.json({ deleted: deletedIds.has(id) })
  );
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: (url: string) => fetch(url, Number(String(id).split(':')[1])),
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, fetch };
}

function createEnv(values: Map<string, string>, overrides: Partial<Env> = {}) {
  const kv = createStore(values);
  const counter = createCounter();
  const env: Env = {
    GITHUB_APP_ID: 'test',
    GITHUB_PRIVATE_KEY: 'test',
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: '*',
    GITHUB_APP_NAME: 'test',
    MAX_SCREENSHOT_SIZE_MB: '5',
    ASSETS: {} as Fetcher,
    ADMIN_READ_API_SECRET: SECRET,
    INSTALLATION_USAGE_ENABLED: 'true',
    INSTALLATION_ANALYTICS: kv.store,
    FEEDBACK_COUNTER: counter.namespace,
    ...overrides,
  };
  return { env, ...kv, counter };
}

function request(env: Env, suffix = '', headers: Record<string, string> = {}) {
  return adminInstallations.fetch(
    new Request(`https://worker.example/installations${suffix}`, {
      headers: { Authorization: `Bearer ${SECRET}`, ...headers },
    }),
    env
  );
}

describe('server-only administrator installation inventory', () => {
  it('authenticates before storage access and sends no cacheable or CORS response', async () => {
    const { env, list, get } = createEnv(new Map([['installation:1', identity(1)]]));
    for (const response of [
      await request({ ...env, ADMIN_READ_API_SECRET: undefined }),
      await request(env, '', { Authorization: `Bearer ${'Z'.repeat(43)}` }),
      await request(env, '', { Origin: 'https://bugdrop.dev' }),
    ]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('mounts outside the public API CORS middleware', async () => {
    const { env } = createEnv(new Map());
    const read = await worker.fetch(
      new Request('https://worker.example/internal/admin/installations', {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env,
      {} as ExecutionContext
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ items: [], nextCursor: null });
    const response = await worker.fetch(
      new Request('https://worker.example/internal/admin/installations', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://bugdrop.dev',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization',
        },
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not put the opaque cursor in the global request log', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const { default: mounted } = await import('../src/index');
      const { env } = createEnv(new Map());
      await mounted.fetch(
        new Request('https://worker.example/internal/admin/installations', {
          headers: {
            Authorization: `Bearer ${SECRET}`,
            'X-BugDrop-Inventory-Cursor': 'opaque-cursor',
          },
        }),
        env,
        {} as ExecutionContext
      );
      await mounted.fetch(
        new Request(
          'https://worker.example/internal/admin/installations?cursor=accidental-secret',
          {
            headers: { Authorization: `Bearer ${SECRET}` },
          }
        ),
        env,
        {} as ExecutionContext
      );
      await mounted.fetch(
        new Request(
          'https://worker.example/intern%61l/admin/installations?cursor=accidental-secret',
          { headers: { Authorization: `Bearer ${SECRET}` } }
        ),
        env,
        {} as ExecutionContext
      );
      expect(logs).not.toHaveBeenCalled();
      await mounted.fetch(
        new Request('https://worker.example/api/health'),
        env,
        {} as ExecutionContext
      );
      expect(logs).toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  it('accepts a previous credential only during an explicitly configured rotation', async () => {
    const { env } = createEnv(new Map(), { ADMIN_READ_API_PREVIOUS_SECRET: PREVIOUS_SECRET });
    expect((await request(env, '', { Authorization: `Bearer ${PREVIOUS_SECRET}` })).status).toBe(
      200
    );
    expect(
      (
        await request({ ...env, ADMIN_READ_API_PREVIOUS_SECRET: undefined }, '', {
          Authorization: `Bearer ${PREVIOUS_SECRET}`,
        })
      ).status
    ).toBe(401);
    expect((await request({ ...env, ADMIN_READ_API_PREVIOUS_SECRET: 'weak' })).status).toBe(503);
  });

  it('pages only installation identities and preserves missing versus zero mirror counts', async () => {
    const values = new Map([
      ['installation:1', identity(1)],
      ['installation:2', identity(2)],
      ['installation-usage:1', usage(1, 0)],
    ]);
    const { env, list } = createEnv(values);
    const first = await request(env, '?limit=1');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      items: [
        {
          installationId: 1,
          account: {
            login: 'customer-1',
            type: 'Organization',
            profileUrl: 'https://github.com/customer-1',
          },
          installedAt: '2026-09-01T00:00:00.000Z',
          successfulFeedbackCount: 0,
        },
      ],
      nextCursor: '1',
    });
    const second = await request(env, '?limit=1', { 'X-BugDrop-Inventory-Cursor': '1' });
    expect((await second.json()).items[0].successfulFeedbackCount).toBeNull();
    expect(list).toHaveBeenCalledWith({ prefix: 'installation:', limit: 1 });
    expect(list).toHaveBeenCalledWith({ prefix: 'installation:', limit: 1, cursor: '1' });
  });

  it('passes an opaque KV cursor through the header without interpreting it', async () => {
    const values = new Map([
      ['installation:1', identity(1)],
      ['installation:2', identity(2)],
    ]);
    const { env, list } = createEnv(values);
    const opaqueCursor = 'AQID+/=opaque';
    list.mockResolvedValueOnce({
      keys: [{ name: 'installation:1' }],
      list_complete: false,
      cursor: opaqueCursor,
      cacheStatus: null,
    });
    list.mockResolvedValueOnce({
      keys: [{ name: 'installation:2' }],
      list_complete: true,
      cursor: undefined,
      cacheStatus: null,
    });
    const first = await request(env, '?limit=1');
    expect((await first.json()).nextCursor).toBe(opaqueCursor);
    const second = await request(env, '?limit=1', {
      'X-BugDrop-Inventory-Cursor': opaqueCursor,
    });
    expect((await second.json()).items[0].installationId).toBe(2);
    expect(list).toHaveBeenLastCalledWith({
      prefix: 'installation:',
      limit: 1,
      cursor: opaqueCursor,
    });
  });

  it('returns an empty page with a continuation when identity disappears after listing', async () => {
    const values = new Map([['installation:1', identity(1)]]);
    const { env, list } = createEnv(values);
    list.mockImplementationOnce(async () => {
      values.delete('installation:1');
      return {
        keys: [{ name: 'installation:1' }],
        list_complete: false,
        cursor: 'next-page',
        cacheStatus: null,
      };
    });
    const response = await request(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: 'next-page' });
  });

  it('rejects unbounded, duplicate, and unknown pagination parameters', async () => {
    const { env, list } = createEnv(new Map());
    for (const suffix of ['?limit=9', '?limit=0', '?limit=1&limit=2', '?cursor=1', '?all=true']) {
      expect((await request(env, suffix)).status).toBe(400);
    }
    expect((await request(env, '', { 'X-BugDrop-Inventory-Cursor': '' })).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable storage and malformed identity or mirror records', async () => {
    const values = new Map([['installation:1', identity(1)]]);
    const { env } = createEnv(values);
    expect((await request({ ...env, INSTALLATION_ANALYTICS: undefined })).status).toBe(503);
    expect((await request({ ...env, FEEDBACK_COUNTER: undefined })).status).toBe(503);
    expect((await request({ ...env, INSTALLATION_USAGE_ENABLED: undefined })).status).toBe(503);
    values.set('installation:1', '{"bad":true}');
    expect((await request(env)).status).toBe(503);
    values.set('installation:1', identity(1));
    values.set('installation-usage:1', '{"successfulFeedbackCount":1}');
    expect((await request(env)).status).toBe(503);
  });

  it('fails closed when the Durable Object deletion status is malformed', async () => {
    const values = new Map([['installation:1', identity(1)]]);
    const { env } = createEnv(values);
    const brokenCounter = {
      idFromName: () => 'installation-feedback:1' as unknown as DurableObjectId,
      get: () => ({ fetch: async () => Response.json({ deleted: 'no' }) }),
    } as unknown as DurableObjectNamespace;
    expect((await request({ ...env, FEEDBACK_COUNTER: brokenCounter })).status).toBe(503);
  });

  it('fails the whole page when a Durable Object read is unavailable', async () => {
    const values = new Map([
      ['installation:1', identity(1)],
      ['installation:2', identity(2)],
    ]);
    const { env } = createEnv(values);
    const brokenCounter = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({
        fetch: async () => {
          if (String(id).endsWith(':2')) throw new Error('private storage failure');
          return Response.json({ deleted: false });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const response = await request({ ...env, FEEDBACK_COUNTER: brokenCounter });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Administrator inventory unavailable' });
  });

  it('omits uninstalling installations when a KV guard appears during the read', async () => {
    const values = new Map([
      ['installation:1', identity(1)],
      ['installation-usage:1', usage(1, 7)],
    ]);
    const { env, get } = createEnv(values);
    let guardReads = 0;
    get.mockImplementation(async (key: string) => {
      if (key === 'installation-usage-deleted:1') return ++guardReads === 2 ? '1' : null;
      return values.get(key) ?? null;
    });
    const response = await request(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
  });

  it('omits stale KV records when the Durable Object has a deletion marker', async () => {
    const values = new Map([
      ['installation:1', identity(1)],
      ['installation-usage:1', usage(1, 7)],
    ]);
    const { env } = createEnv(values, { FEEDBACK_COUNTER: createCounter(new Set([1])).namespace });
    expect(await (await request(env)).json()).toEqual({ items: [], nextCursor: null });
  });
});
