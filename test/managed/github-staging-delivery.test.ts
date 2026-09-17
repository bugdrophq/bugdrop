import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleGitHubDelivery,
  type GitHubTransport,
} from '../../src/managed/github-staging/delivery';
import {
  canary,
  config,
  installation,
  privateKey,
  report,
  request,
  token,
  tokenResponse,
} from './github-staging-fixtures';

afterEach(() => vi.useRealTimers());
function upstream(custom?: (request: Request) => Promise<Response>) {
  const calls: Request[] = [];
  const transport: GitHubTransport = async req => {
    calls.push(req);
    if (req.url.endsWith('/access_tokens')) return Response.json(tokenResponse(), { status: 201 });
    if (req.url.endsWith('/issues'))
      return custom
        ? custom(req)
        : Response.json({ html_url: `https://github.com/${canary}` }, { status: 201 });
    return Response.json(installation);
  };
  return { calls, transport };
}
async function outcome(transport: GitHubTransport, configuration: unknown = config) {
  const response = await handleGitHubDelivery(
    request(),
    configuration,
    { privateKey },
    Date.now() + 30_000,
    transport
  );
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const value = await response.json();
  expect(Object.keys(value as object)).toEqual(['outcome']);
  expect(JSON.stringify(value)).not.toContain(canary);
  expect(JSON.stringify(value)).not.toContain(token);
  return value;
}

describe('staging GitHub adapter with intercepted external transport', () => {
  it('accepts current opaque stateless installation tokens without a format override', async () => {
    const opaque = `${'a'.repeat(180)}.${'b-'.repeat(150)}.${'c_'.repeat(25)}`;
    const { calls, transport: fallback } = upstream();
    const transport: GitHubTransport = async req => {
      if (req.url.endsWith('/access_tokens')) {
        calls.push(req);
        return Response.json({ ...tokenResponse(), token: opaque }, { status: 201 });
      }
      return fallback(req);
    };
    expect(await outcome(transport)).toEqual({ outcome: 'delivered' });
    expect(calls[2].headers.get('Authorization')).toBe(`Bearer ${opaque}`);
  });
  it.each([false, undefined])(
    'rejects a matching repository whose private flag is %s',
    async visibility => {
      const calls: Request[] = [];
      const transport: GitHubTransport = async req => {
        calls.push(req);
        if (req.url.endsWith('/access_tokens')) {
          const granted = tokenResponse();
          return Response.json(
            { ...granted, repositories: [{ ...granted.repositories[0], private: visibility }] },
            { status: 201 }
          );
        }
        return req.url.endsWith('/issues')
          ? new Response(null, { status: 201 })
          : Response.json(installation);
      };
      expect(await outcome(transport)).toEqual({ outcome: 'failed_before_delivery' });
      expect(calls).toHaveLength(2);
    }
  );
  it('does not dispatch after authority expires during token preflight', async () => {
    vi.useFakeTimers();
    const calls: Request[] = [];
    const transport: GitHubTransport = async req => {
      calls.push(req);
      if (req.url.endsWith('/access_tokens')) {
        vi.setSystemTime(Date.now() + 2_000);
        return Response.json(tokenResponse(), { status: 201 });
      }
      return Response.json(installation);
    };
    const response = await handleGitHubDelivery(
      request(),
      config,
      { privateKey },
      Date.now() + 1_000,
      transport
    );
    expect(await response.json()).toEqual({ outcome: 'failed_before_delivery' });
    expect(calls).toHaveLength(2);
  });

  it.each([0, NaN, Infinity, 31_000])(
    'rejects an invalid trusted authorization deadline %s',
    async offset => {
      const transport = vi.fn();
      const response = await handleGitHubDelivery(
        request(),
        config,
        { privateKey },
        Date.now() + offset,
        transport
      );
      expect(await response.json()).toEqual({ outcome: 'failed_before_delivery' });
      expect(transport).not.toHaveBeenCalled();
    }
  );
  it('restricts installation token to one repository and makes one issue POST without redirects', async () => {
    const { calls, transport } = upstream();
    expect(await outcome(transport)).toEqual({ outcome: 'delivered' });
    expect(calls.map(call => call.url)).toEqual([
      'https://api.github.com/app/installations/202',
      'https://api.github.com/app/installations/202/access_tokens',
      'https://api.github.com/repos/fixture-org/fixture-dogfood/issues',
    ]);
    expect(await calls[1].json()).toEqual({
      repository_ids: [404],
      permissions: { issues: 'write' },
    });
    expect(await calls[2].json()).toEqual({
      title: 'BugDrop staging dogfood report',
      body: report,
    });
    expect(calls[2].headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(calls.every(call => call.redirect === 'error')).toBe(true);
  });

  it.each([
    { enabled: false },
    { environment: 'production' },
    { dedicatedDogfood: false },
    { repository: '../customer' },
    { owner: 'fixture-org.evil' },
    { repositoryId: 0 },
    { appId: 1.2 },
    { appSlug: 'current-public-app' },
    { destination: 'customer' },
  ])('rejects unapproved configuration before any outbound call (%j)', async patch => {
    const { calls, transport } = upstream();
    expect(await outcome(transport, { ...config, ...patch })).toEqual({
      outcome: 'failed_before_delivery',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { id: 999 },
    { app_id: 999 },
    { app_slug: 'other-staging' },
    { account: { ...installation.account, id: 999 } },
    { repository_selection: 'all' },
    { suspended_at: new Date().toISOString() },
    { permissions: { issues: 'write', contents: 'write' } },
  ])('rejects installation substitution or excess authority (%j)', async patch => {
    const transport = vi.fn(async () => Response.json({ ...installation, ...patch }));
    expect(await outcome(transport)).toEqual({ outcome: 'failed_before_delivery' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['repository', 'permission', 'expiry', 'token'] as const)(
    'rejects a mismatched %s in the granted token',
    async kind => {
      const value = tokenResponse();
      if (kind === 'repository') value.repositories[0] = { ...value.repositories[0], id: 999 };
      if (kind === 'permission') Object.assign(value.permissions, { administration: 'write' });
      if (kind === 'expiry') value.expires_at = new Date(0).toISOString();
      if (kind === 'token') value.token = 'invalid token with spaces';
      const transport = vi.fn(async (req: Request) =>
        req.url.endsWith('/access_tokens')
          ? Response.json(value, { status: 201 })
          : Response.json(installation)
      );
      expect(await outcome(transport)).toEqual({ outcome: 'failed_before_delivery' });
      expect(transport).toHaveBeenCalledTimes(2);
    }
  );

  it.each([301, 401, 403, 404, 422, 429, 500])('never retries issue response %i', async status => {
    const { calls, transport } = upstream(async () => new Response(canary, { status }));
    expect(await outcome(transport)).toEqual({ outcome: 'indeterminate' });
    expect(calls.filter(call => call.url.endsWith('/issues'))).toHaveLength(1);
  });

  it('hides thrown provider content and retains ambiguity after dispatch', async () => {
    const { calls, transport } = upstream(async () => {
      throw new Error(`${canary} ${token}`);
    });
    expect(await outcome(transport)).toEqual({ outcome: 'indeterminate' });
    expect(calls).toHaveLength(3);
  });

  it('times out after dispatch, aborts it, and never dispatches again on late completion', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const { calls, transport } = upstream(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const pending = outcome(transport);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ outcome: 'indeterminate' });
    expect(calls[2].signal.aborted).toBe(true);
    complete(new Response(canary, { status: 201 }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(3);
  });

  it('never starts issue delivery when a preflight response arrives after timeout', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          complete = resolve;
        })
    );
    const pending = outcome(transport);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ outcome: 'failed_before_delivery' });
    complete(Response.json(installation));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
