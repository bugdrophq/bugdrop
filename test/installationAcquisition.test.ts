import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countInstallationCreated,
  acquisitionDayExpiresAt,
} from '../src/lib/installation-acquisition';
import { FeedbackCounter } from '../src/lib/feedback-counter';
import { createGitHubWebhook } from '../src/routes/github-webhook';
import type { Env } from '../src/types';

const start = '2026-10-09T00:00:00.000Z';
const installation = {
  installationId: 987654321,
  installedAt: '2026-10-09T10:00:00.000Z',
  account: {
    login: 'private-account',
    type: 'User' as const,
    profileUrl: 'https://github.com/private-account',
  },
};
afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T12:00:00.000Z'));
  const values = new Map<string, unknown>();
  const mirrors = new Map<string, string>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value;
    },
    list: async ({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    delete: async (keys: string[]) => {
      keys.forEach(key => values.delete(key));
    },
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(storage),
  };
  const state = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
  const env = {
    GITHUB_APP_ID: '123',
    GITHUB_WEBHOOK_SECRET: 'signature-test',
    INSTALLATION_ACQUISITION_STARTED_AT: start,
    INSTALLATION_ACQUISITION_HMAC_SECRET: 'a'.repeat(64),
    INSTALLATION_ANALYTICS: {
      get: vi.fn(async () => null),
      delete: vi.fn(),
      put: vi.fn(async (key: string, value: string) => {
        mirrors.set(key, value);
      }),
    },
  } as unknown as Env;
  const counter = new FeedbackCounter(state, env);
  const fetch = vi.fn(async (url: string, init: RequestInit) =>
    counter.fetch(new Request(url, init))
  );
  env.FEEDBACK_COUNTER = {
    idFromName: vi.fn(),
    get: () => ({ fetch }),
  } as unknown as DurableObjectNamespace;
  return { values, mirrors, counter, env, fetch, alarm: () => alarm };
}

describe('installation acquisition', () => {
  it('deduplicates redelivery and stores only daily totals plus opaque temporary receipts', async () => {
    const f = fixture();
    await countInstallationCreated(f.env, installation);
    await countInstallationCreated(f.env, installation);
    await f.counter.alarm();
    expect(f.values.get('acquisitionTotal')).toBe(1);
    expect([...f.values.keys()].filter(k => k.startsWith('acquisitionReceipt:'))).toHaveLength(1);
    const mirror = JSON.parse(f.mirrors.get('acquisition:daily:2026-10-09')!);
    expect(mirror).toEqual({
      schemaVersion: 1,
      date: '2026-10-09',
      installations: 1,
      coverageStartedAt: start,
      updatedAt: expect.any(String),
    });
    const stored = JSON.stringify([...f.values, ...f.mirrors]);
    for (const privateValue of ['private-account', '987654321', 'github.com', 'signature-test']) {
      expect(stored).not.toContain(privateValue);
    }
    expect(f.alarm()).toBe(acquisitionDayExpiresAt('2026-10-09'));
  });

  it('does not count disabled, pre-start, expired or excluded installations', async () => {
    const f = fixture();
    await countInstallationCreated(
      { ...f.env, INSTALLATION_ACQUISITION_STARTED_AT: undefined },
      installation
    );
    await countInstallationCreated(f.env, {
      ...installation,
      installedAt: '2026-10-08T23:59:59.000Z',
    });
    await countInstallationCreated(
      { ...f.env, INSTALLATION_ACQUISITION_EXCLUDED_OWNERS: ' PRIVATE-account ' },
      installation
    );
    vi.spyOn(Date, 'now').mockReturnValue(acquisitionDayExpiresAt('2026-10-09'));
    await countInstallationCreated(f.env, installation);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('fails closed on missing secrets and future creation times', async () => {
    const f = fixture();
    await expect(
      countInstallationCreated(
        { ...f.env, INSTALLATION_ACQUISITION_HMAC_SECRET: undefined },
        installation
      )
    ).rejects.toThrow('not configured');
    await expect(
      countInstallationCreated(f.env, { ...installation, installedAt: '2026-10-09T13:00:00.000Z' })
    ).rejects.toThrow('future');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('survives a lost acknowledgement without adding another install', async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async (url, init) => {
      await f.counter.fetch(new Request(url, init));
      throw new Error('response lost');
    });
    await expect(countInstallationCreated(f.env, installation)).rejects.toThrow('response lost');
    await countInstallationCreated(f.env, installation);
    expect(f.values.get('acquisitionTotal')).toBe(1);
    expect(f.alarm()).not.toBeNull();
  });

  it('erases receipts at expiry but retains totals and rejects replay', async () => {
    const f = fixture();
    await countInstallationCreated(f.env, installation);
    const [, init] = f.fetch.mock.calls[0];
    vi.spyOn(Date, 'now').mockReturnValue(acquisitionDayExpiresAt('2026-10-09'));
    await f.counter.alarm();
    expect([...f.values.keys()].some(k => k.startsWith('acquisitionReceipt:'))).toBe(false);
    expect(f.values.get('acquisitionTotal')).toBe(1);
    const replay = await f.counter.fetch(
      new Request('https://counter/acquisition/increment', init)
    );
    expect(replay.status).toBe(409);
    expect(f.values.get('acquisitionTotal')).toBe(1);
  });

  it('schedules cleanup when publication crosses the receipt expiry boundary', async () => {
    const f = fixture();
    await countInstallationCreated(f.env, installation);
    const expiresAt = acquisitionDayExpiresAt('2026-10-09');
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
    vi.mocked(f.env.INSTALLATION_ANALYTICS!.put).mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    });
    await f.counter.alarm();
    expect(f.alarm()).toBe(expiresAt + 2);
    await f.counter.alarm();
    expect([...f.values.keys()].some(key => key.startsWith('acquisitionReceipt:'))).toBe(false);
    expect(f.values.get('acquisitionTotal')).toBe(1);
  });

  it('retries KV publication without incrementing or retaining expired receipts', async () => {
    const f = fixture();
    await countInstallationCreated(f.env, installation);
    vi.mocked(f.env.INSTALLATION_ANALYTICS!.put).mockRejectedValueOnce(new Error('KV unavailable'));
    vi.spyOn(Date, 'now').mockReturnValue(acquisitionDayExpiresAt('2026-10-09'));
    await expect(f.counter.alarm()).rejects.toThrow('KV unavailable');
    expect(f.alarm()).toBe(Date.now() + 60_000);
    expect([...f.values.keys()].some(k => k.startsWith('acquisitionReceipt:'))).toBe(false);
    await f.counter.alarm();
    expect(JSON.parse(f.mirrors.get('acquisition:daily:2026-10-09')!).installations).toBe(1);
  });

  it('counts a signed created delivery once even if already uninstalled, and ignores deletion', async () => {
    const f = fixture();
    const app = createGitHubWebhook({ confirmInstallationIsInactive: async () => true });
    f.env.FEEDBACK_COUNTER = {
      idFromName: vi.fn(),
      get: () => ({ fetch: f.fetch }),
    } as unknown as DurableObjectNamespace;
    async function send(action: string, validSignature = true) {
      const body = JSON.stringify({
        action,
        installation: {
          id: installation.installationId,
          created_at: installation.installedAt,
          account: { ...installation.account, html_url: installation.account.profileUrl },
        },
      });
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(f.env.GITHUB_WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
      const signature = Array.from(new Uint8Array(digest), b =>
        b.toString(16).padStart(2, '0')
      ).join('');
      return app.request(
        '/github/webhook',
        {
          method: 'POST',
          body,
          headers: {
            'x-github-event': 'installation',
            'x-hub-signature-256': `sha256=${validSignature ? signature : '0'.repeat(64)}`,
          },
        },
        f.env
      );
    }
    expect((await send('created', false)).status).toBe(401);
    expect(f.values.size).toBe(0);
    expect((await send('created')).status).toBe(202);
    expect((await send('created')).status).toBe(202);
    expect(f.values.get('acquisitionTotal')).toBe(1);
    // Cleanup addresses the installation-feedback object, not the daily acquisition object.
    f.env.FEEDBACK_COUNTER = {
      idFromName: vi.fn(),
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    } as unknown as DurableObjectNamespace;
    expect((await send('deleted')).status).toBe(200);
    expect(f.values.get('acquisitionTotal')).toBe(1);
  });
});
