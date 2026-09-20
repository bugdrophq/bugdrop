import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  FeedbackCounter,
  getFeedbackCountBaseline,
  getPublicFeedbackCount,
  isExcludedFromFeedbackCount,
  roundFeedbackCount,
  scheduleSuccessfulFeedbackCount,
} from '../src/lib/feedback-counter';

const baseEnv: Env = {
  GITHUB_APP_ID: 'test-app-id',
  GITHUB_PRIVATE_KEY: 'test-private-key',
  ENVIRONMENT: 'test',
  ALLOWED_ORIGINS: '*',
  GITHUB_APP_NAME: 'test-bugdrop-app',
  MAX_SCREENSHOT_SIZE_MB: '5',
  ASSETS: {} as Fetcher,
};

describe('anonymous feedback counter', () => {
  it('initializes from the audited baseline and stores no identifying values', async () => {
    const values = new Map<string, unknown>();
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      FEEDBACK_COUNT_BASELINE: '3116',
    });

    const firstEventId = '11111111-1111-4111-8111-111111111111';
    const secondEventId = '22222222-2222-4222-8222-222222222222';
    const first = await counter.fetch(incrementRequest(firstEventId));
    const second = await counter.fetch(incrementRequest(secondEventId));

    expect(await first.json()).toEqual({ total: 3117 });
    expect(await second.json()).toEqual({ total: 3118 });
    expect(values.get('total')).toBe(3118);
    expect(values.get('recentEventIds')).toEqual([firstEventId, secondEventId]);
    expect(JSON.stringify([...values.values()])).not.toContain('external/app');
  });

  it('deduplicates an ambiguous retry using the same opaque event ID', async () => {
    const values = new Map<string, unknown>();
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      FEEDBACK_COUNT_BASELINE: '3116',
    });
    const eventId = '11111111-1111-4111-8111-111111111111';

    const first = await counter.fetch(incrementRequest(eventId));
    const retry = await counter.fetch(incrementRequest(eventId));

    expect(await first.json()).toEqual({ total: 3117 });
    expect(await retry.json()).toEqual({ total: 3117 });
    expect(values.get('total')).toBe(3117);
  });

  it('publishes only a rounded-down bucket', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ total: 3199 }));
    const env = { ...baseEnv, FEEDBACK_COUNTER: createNamespace(fetch) };

    await expect(getPublicFeedbackCount(env)).resolves.toBe(3100);
    expect(fetch).toHaveBeenCalledWith('https://feedback-counter/total');
    expect(roundFeedbackCount(3200)).toBe(3200);
  });

  it('uses a rounded baseline when the binding is intentionally absent', async () => {
    await expect(
      getPublicFeedbackCount({ ...baseEnv, FEEDBACK_COUNT_BASELINE: '3116' })
    ).resolves.toBe(3100);
    await expect(getPublicFeedbackCount(baseEnv)).resolves.toBeNull();
  });

  it('excludes configured first-party owners without persisting repository identity', () => {
    const env = {
      ...baseEnv,
      FEEDBACK_COUNT_EXCLUDED_OWNERS: 'mean-weasel, NeonWatty',
    };

    expect(isExcludedFromFeedbackCount(env, 'mean-weasel/bugdrop')).toBe(true);
    expect(isExcludedFromFeedbackCount(env, 'neonwatty/test-repo')).toBe(true);
    expect(isExcludedFromFeedbackCount(env, 'external/app')).toBe(false);
  });

  it('isolates counter failures from successful feedback responses', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('counter unavailable'));
    const waitUntil = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { ...baseEnv, FEEDBACK_COUNTER: createNamespace(fetch) };

    expect(() =>
      scheduleSuccessfulFeedbackCount(env, 'external/app', {
        executionCtx: { waitUntil },
      })
    ).not.toThrow();

    const queued = waitUntil.mock.calls[0][0] as Promise<void>;
    await expect(queued).rejects.toThrow('counter unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      '[BugDrop] Failed to record successful feedback count:',
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('reuses one opaque event ID when retrying an ambiguous delivery failure', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(Response.json({ total: 3117 }));
    const waitUntil = vi.fn();
    const env = { ...baseEnv, FEEDBACK_COUNTER: createNamespace(fetch) };

    scheduleSuccessfulFeedbackCount(env, 'external/app', {
      executionCtx: { waitUntil },
    });
    await (waitUntil.mock.calls[0][0] as Promise<void>);

    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = (fetch.mock.calls[0][1] as RequestInit).body;
    const retryBody = (fetch.mock.calls[1][1] as RequestInit).body;
    expect(firstBody).toBe(retryBody);
  });

  it('keeps waitUntil pending until both independent counter deliveries settle', async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error('global unavailable'));
    let finishInstallation: (response: Response) => void = () => undefined;
    const installationFetch = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          finishInstallation = resolve;
        })
    );
    const namespace = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn((id: DurableObjectId) => ({
        fetch: String(id).startsWith('installation-feedback:') ? installationFetch : globalFetch,
      })),
    } as unknown as DurableObjectNamespace;
    const waitUntil = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    scheduleSuccessfulFeedbackCount(
      {
        ...baseEnv,
        FEEDBACK_COUNTER: namespace,
        INSTALLATION_USAGE_ENABLED: 'true',
      },
      'external/app',
      { executionCtx: { waitUntil } },
      42
    );
    const queued = waitUntil.mock.calls[0][0] as Promise<void>;
    let settled = false;
    void queued
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(globalFetch).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);

    finishInstallation(Response.json({ total: 1 }));
    await expect(queued).rejects.toThrow('global unavailable');
    expect(installationFetch).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('does not schedule counter work for excluded owners', () => {
    const fetch = vi.fn();
    const waitUntil = vi.fn();
    const env = {
      ...baseEnv,
      FEEDBACK_COUNTER: createNamespace(fetch),
      FEEDBACK_COUNT_EXCLUDED_OWNERS: 'mean-weasel',
    };

    scheduleSuccessfulFeedbackCount(env, 'mean-weasel/bugdrop', {
      executionCtx: { waitUntil },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('stores an exact private count for one active installation without repository data', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>([['installation:42', '{"active":true}']]);
    const store = createKv(kvValues);
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    const request = installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111');
    expect(await (await counter.fetch(request)).json()).toEqual({ total: 1 });
    await counter.alarm();

    expect(JSON.parse(kvValues.get('installation-usage:42') ?? '')).toEqual({
      schemaVersion: 1,
      installationId: 42,
      successfulFeedbackCount: 1,
    });
    expect(JSON.stringify([...values.values(), ...kvValues.values()])).not.toContain(
      'external/app'
    );
  });

  it('does not lose a valid first count while the installation identity is still propagating', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>();
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(kvValues),
    });

    const response = await counter.fetch(
      installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111')
    );
    await counter.alarm();

    expect(response.status).toBe(200);
    expect(values.get('total')).toBe(1);
    expect(kvValues.has('installation-usage:42')).toBe(false);

    kvValues.set('installation:42', '{"active":true}');
    await counter.alarm();
    expect(JSON.parse(kvValues.get('installation-usage:42') ?? '')).toMatchObject({
      successfulFeedbackCount: 1,
    });
  });

  it('purges an unanchored count if no installation identity arrives within a day', async () => {
    const values = new Map<string, unknown>([
      ['total', 1],
      ['installationId', 42],
      ['identityChecksRemaining', 0],
    ]);
    const kvValues = new Map<string, string>();
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(kvValues),
    });

    await counter.alarm();

    expect(values.size).toBe(0);
    expect(kvValues.has('installation-usage:42')).toBe(false);
  });

  it('keeps the durable purge anchor until a failed KV deletion can retry', async () => {
    const values = new Map<string, unknown>([
      ['total', 1],
      ['installationId', 42],
      ['identityChecksRemaining', 0],
    ]);
    const kvValues = new Map<string, string>([
      ['installation-usage:42', '{"successfulFeedbackCount":1}'],
    ]);
    const store = createKv(kvValues);
    vi.mocked(store.delete).mockRejectedValueOnce(new Error('KV unavailable'));
    const state = createState(values);
    const counter = new FeedbackCounter(state, {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    await expect(counter.alarm()).rejects.toThrow('KV unavailable');
    expect(values.get('installationId')).toBe(42);
    expect(await state.storage.getAlarm()).not.toBeNull();

    await counter.alarm();
    expect(values.size).toBe(0);
    expect(kvValues.has('installation-usage:42')).toBe(false);
  });

  it('retries tombstone cleanup without dropping its durable purge anchor', async () => {
    const values = new Map<string, unknown>([
      ['total', 7],
      ['installationId', 42],
      ['identityChecksRemaining', 1],
    ]);
    const kvValues = new Map<string, string>([
      ['installation-usage:42', '{"successfulFeedbackCount":7}'],
      ['installation-usage-deleted:42', '1'],
    ]);
    const store = createKv(kvValues);
    vi.mocked(store.delete).mockRejectedValueOnce(new Error('KV unavailable'));
    const state = createState(values);
    const counter = new FeedbackCounter(state, {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    await expect(counter.alarm()).rejects.toThrow('KV unavailable');
    expect(values.get('installationId')).toBe(42);
    expect(values.get('total')).toBe(7);
    expect(await state.storage.getAlarm()).not.toBeNull();

    await counter.alarm();
    expect(values.size).toBe(0);
    expect(kvValues.has('installation-usage:42')).toBe(false);
  });

  it('re-arms the alarm after a transient KV read failure', async () => {
    const values = new Map<string, unknown>([
      ['total', 1],
      ['installationId', 42],
      ['identityChecksRemaining', 1],
    ]);
    const store = createKv(new Map());
    vi.mocked(store.get).mockRejectedValueOnce(new Error('KV unavailable'));
    const state = createState(values);
    const counter = new FeedbackCounter(state, {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    await expect(counter.alarm()).rejects.toThrow('KV unavailable');
    expect(values.get('installationId')).toBe(42);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  it('does not reset the identity retry budget when more feedback arrives', async () => {
    const values = new Map<string, unknown>();
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(new Map()),
    });

    await counter.fetch(installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111'));
    const originalBudget = values.get('identityChecksRemaining');
    await counter.alarm();
    const reducedBudget = values.get('identityChecksRemaining');
    await counter.fetch(installationIncrementRequest(42, '22222222-2222-4222-8222-222222222222'));

    expect(originalBudget).toBe(1440);
    expect(reducedBudget).toBe(1439);
    expect(values.get('identityChecksRemaining')).toBe(reducedBudget);
    expect(values.get('total')).toBe(2);
    expect([...values.keys()]).not.toContain('identityDeadline');
    expect(
      [...values.values()]
        .filter((value): value is number => typeof value === 'number')
        .every(value => value < 1_000_000_000)
    ).toBe(true);
  });

  it('keeps a pending mirror retryable when installation analytics is unavailable', async () => {
    const values = new Map<string, unknown>([
      ['total', 1],
      ['installationId', 42],
      ['identityChecksRemaining', 1],
    ]);
    const state = createState(values);
    const counter = new FeedbackCounter(state, {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
    });

    await expect(counter.alarm()).rejects.toThrow('analytics binding is unavailable');

    expect(values.get('total')).toBe(1);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  it('deduplicates per-install retries and repairs a missing KV mirror', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>([['installation:42', '{"active":true}']]);
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(kvValues),
    });
    const eventId = '11111111-1111-4111-8111-111111111111';

    await counter.fetch(installationIncrementRequest(42, eventId));
    await counter.alarm();
    kvValues.delete('installation-usage:42');
    await counter.fetch(installationIncrementRequest(42, eventId));
    await counter.alarm();

    expect(values.get('total')).toBe(1);
    expect(JSON.parse(kvValues.get('installation-usage:42') ?? '')).toMatchObject({
      successfulFeedbackCount: 1,
    });
  });

  it('refuses and purges delayed increments after an uninstall tombstone', async () => {
    const values = new Map<string, unknown>([['total', 7]]);
    const kvValues = new Map<string, string>([
      ['installation:42', '{"active":true}'],
      ['installation-usage:42', '{"successfulFeedbackCount":7}'],
      ['installation-usage-deleted:42', '1'],
    ]);
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(kvValues),
    });

    const response = await counter.fetch(
      installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111')
    );

    expect(response.status).toBe(409);
    expect(values.size).toBe(0);
    expect(kvValues.has('installation-usage:42')).toBe(false);
  });

  it('keeps a strongly consistent deletion marker when KV still looks active', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>([['installation:42', '{"active":true}']]);
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: createKv(kvValues),
    });

    expect(
      (
        await counter.fetch(
          new Request('https://feedback-counter/installation/delete', { method: 'POST' })
        )
      ).status
    ).toBe(204);
    const response = await counter.fetch(
      installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111')
    );

    expect(response.status).toBe(409);
    expect(values.get('total')).toBeUndefined();
    expect(kvValues.has('installation-usage:42')).toBe(false);
  });

  it('hard-purges without retaining a deletion marker while collection is disabled', async () => {
    const values = new Map<string, unknown>([
      ['total', 7],
      ['installationId', 42],
    ]);
    const state = createState(values);
    const counter = new FeedbackCounter(state, baseEnv);

    const response = await counter.fetch(
      new Request('https://feedback-counter/installation/purge', { method: 'POST' })
    );

    expect(response.status).toBe(204);
    expect(values.size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it('coalesces concurrent increments into one exact KV mirror write', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>([['installation:42', '{"active":true}']]);
    const store = createKv(kvValues);
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    await Promise.all([
      counter.fetch(installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111')),
      counter.fetch(installationIncrementRequest(42, '22222222-2222-4222-8222-222222222222')),
    ]);
    expect(kvValues.has('installation-usage:42')).toBe(false);
    await counter.alarm();

    expect(JSON.parse(kvValues.get('installation-usage:42') ?? '')).toMatchObject({
      successfulFeedbackCount: 2,
    });
    expect(store.put).toHaveBeenCalledOnce();
  });

  it('retries a failed asynchronous mirror without incrementing again', async () => {
    const values = new Map<string, unknown>();
    const kvValues = new Map<string, string>([['installation:42', '{"active":true}']]);
    const store = createKv(kvValues);
    vi.mocked(store.put).mockRejectedValueOnce(new Error('KV rate limited'));
    const counter = new FeedbackCounter(createState(values), {
      ...baseEnv,
      INSTALLATION_USAGE_ENABLED: 'true',
      INSTALLATION_ANALYTICS: store,
    });

    await counter.fetch(installationIncrementRequest(42, '11111111-1111-4111-8111-111111111111'));
    await expect(counter.alarm()).rejects.toThrow('KV rate limited');
    await counter.alarm();

    expect(values.get('total')).toBe(1);
    expect(JSON.parse(kvValues.get('installation-usage:42') ?? '')).toMatchObject({
      successfulFeedbackCount: 1,
    });
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it('keeps per-install counting off unless the gate is exactly true', async () => {
    const fetch = vi.fn();
    const waitUntil = vi.fn();
    const env = {
      ...baseEnv,
      FEEDBACK_COUNTER: createNamespace(fetch),
      FEEDBACK_COUNT_EXCLUDED_OWNERS: 'mean-weasel',
    };

    scheduleSuccessfulFeedbackCount(
      env,
      'mean-weasel/bugdrop',
      { executionCtx: { waitUntil } },
      42
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('targets the installation-specific object and carries no repository identity', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ total: 1 }));
    const namespace = createNamespace(fetch);
    const waitUntil = vi.fn();
    const env = {
      ...baseEnv,
      FEEDBACK_COUNTER: namespace,
      FEEDBACK_COUNT_EXCLUDED_OWNERS: 'mean-weasel',
      INSTALLATION_USAGE_ENABLED: 'true',
    };

    scheduleSuccessfulFeedbackCount(
      env,
      'mean-weasel/private-repo',
      { executionCtx: { waitUntil } },
      42
    );
    await (waitUntil.mock.calls[0][0] as Promise<void>);

    expect(namespace.idFromName).toHaveBeenCalledExactlyOnceWith('installation-feedback:42');
    const body = String((fetch.mock.calls[0][1] as RequestInit).body);
    expect(JSON.parse(body)).toMatchObject({ installationId: 42 });
    expect(body).not.toContain('mean-weasel');
    expect(body).not.toContain('private-repo');
  });

  it.each([
    [undefined, 0],
    ['3116', 3116],
    ['invalid', 0],
    ['3116issues', 0],
    ['-1', 0],
  ])('normalizes baseline %s to %d', (value, expected) => {
    expect(getFeedbackCountBaseline({ ...baseEnv, FEEDBACK_COUNT_BASELINE: value })).toBe(expected);
  });
});

function incrementRequest(eventId: string): Request {
  return new Request('https://feedback-counter/increment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  });
}

function installationIncrementRequest(installationId: number, eventId: string): Request {
  return new Request('https://feedback-counter/installation/increment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, installationId }),
  });
}

function createNamespace(fetch: ReturnType<typeof vi.fn>): DurableObjectNamespace {
  const id = {} as DurableObjectId;
  return {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue({ fetch }),
  } as unknown as DurableObjectNamespace;
}

function createStorage(values: Map<string, unknown>): DurableObjectStorage {
  let alarm: number | null = null;
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      values.set(key, value);
    },
    delete: async (keyOrKeys: string | string[]) => {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      const deleted = keys.filter(key => values.delete(key)).length;
      return Array.isArray(keyOrKeys) ? deleted : deleted > 0;
    },
    deleteAll: async () => values.clear(),
    getAlarm: async () => alarm,
    setAlarm: async (value: number | Date) => {
      alarm = value instanceof Date ? value.getTime() : value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async <T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>
    ): Promise<T> =>
      closure({
        get: async <Value>(key: string) => values.get(key) as Value | undefined,
        put: async <Value>(key: string, value: Value) => {
          values.set(key, value);
        },
      } as DurableObjectTransaction),
  } as DurableObjectStorage;
}

function createState(values: Map<string, unknown>): DurableObjectState {
  const storage = createStorage(values);
  let tail = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      const result = tail.then(callback, callback);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  } as unknown as DurableObjectState;
}

function createKv(values: Map<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}
