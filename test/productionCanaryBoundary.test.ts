import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
const { jwt } = vi.hoisted(() => ({ jwt: vi.fn(async () => 'synthetic-app-jwt') }));
vi.mock('../src/lib/jwt', () => ({ generateGitHubAppJWT: jwt }));
import { getInstallationAccess } from '../src/lib/github';
import { createGitHubWebhook } from '../src/routes/github-webhook';

const env = {
  GITHUB_APP_ID: '2508027',
  GITHUB_PRIVATE_KEY: 'synthetic',
  MANAGED_CANARY_EXCLUSION_ENABLED: '1',
} as unknown as Env;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('production managed canary legacy exclusion', () => {
  it('denies the current canary login before any provider access', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    expect(
      await getInstallationAccess(env, 'JermWattML-SVG', 'bugdrop-managed-staging-fixture')
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(jwt).not.toHaveBeenCalled();
  });
  it('denies a numeric canary installation reached through another login before token minting', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 123, account: { id: 335115387 } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await getInstallationAccess(env, 'renamed-account', 'repo')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it('preserves other installations and leaves self-hosted defaults unchanged', async () => {
    for (const accountId of [12345, 335115387]) {
      const current =
        accountId === 335115387 ? { ...env, MANAGED_CANARY_EXCLUSION_ENABLED: undefined } : env;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ id: 123, account: { id: accountId } }))
        .mockResolvedValueOnce(Response.json({ token: 'synthetic-installation-token' }));
      vi.stubGlobal('fetch', fetcher);
      expect(await getInstallationAccess(current, 'another-owner', 'repo')).toEqual({
        installationId: 123,
        token: 'synthetic-installation-token',
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('fails closed for incomplete provider identity and invalid enabled configuration', async () => {
    for (const data of [
      { id: 123 },
      { id: 123, account: { id: '335115387' } },
      { id: 123, account: null },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
      vi.stubGlobal('fetch', fetcher);
      expect(await getInstallationAccess(env, 'another-owner', 'repo')).toBeNull();
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    for (const config of [
      { ...env, MANAGED_CANARY_EXCLUSION_ENABLED: 'true' },
      { ...env, GITHUB_APP_ID: '4983032' },
    ])
      expect(await getInstallationAccess(config, 'another-owner', 'repo')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('production webhook secret overlap', () => {
  const previous = 'previous-webhook-secret-abcdefghijklmnopqrstuvwxyz';
  const next = 'next-webhook-secret-abcdefghijklmnopqrstuvwxyz';
  const body = '{"zen":"synthetic webhook rotation proof"}';
  const hook = createGitHubWebhook();
  const request = (secret: string) =>
    new Request('https://bugdrop.dev/github/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    });
  it('accepts both keys during overlap without resetting or reading customer storage', async () => {
    const config = { ...env, GITHUB_WEBHOOK_SECRET: previous, GITHUB_WEBHOOK_SECRET_NEXT: next };
    for (const secret of [previous, next])
      expect((await hook.fetch(request(secret), config)).status).toBe(202);
    expect((await hook.fetch(request('unknown'), config)).status).toBe(401);
  });
  it('keeps single-key behavior and rejects malformed rotation configuration', async () => {
    const config = { ...env, GITHUB_WEBHOOK_SECRET: previous };
    expect((await hook.fetch(request(previous), config)).status).toBe(202);
    expect((await hook.fetch(request(next), config)).status).toBe(401);
    expect(
      (await hook.fetch(request(next), { ...config, GITHUB_WEBHOOK_SECRET_NEXT: 'short' })).status
    ).toBe(503);
  });
});
