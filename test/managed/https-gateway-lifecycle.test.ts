import { afterEach, expect, it, vi } from 'vitest';
import gateway from '../../src/managed/staging/https-gateway';
const endpoint = 'https://issuance.example.test/v1/submission-capabilities';
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
  'X-BugDrop-Contract-Version': '1',
  'X-BugDrop-SDK-Version': '0.1.0',
};
const env = (
  fetch = vi.fn(
    async (_request: Request) =>
      new Response('{}', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
  )
) => ({
  ENVIRONMENT: 'staging',
  GATEWAY_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://issuance.example.test',
  STAGING_CAPABILITY_INGRESS: { fetch },
});
function streaming(url = endpoint, extra = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const request = new Request(url, {
    method: 'POST',
    headers: { ...headers, ...extra },
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, cancel };
}
afterEach(() => vi.useRealTimers());
it.each(['path', 'length', 'header'])('cancels rejected unread request body: %s', async mode => {
  const s = streaming(
    mode === 'path' ? 'https://issuance.example.test/github/staging/webhook' : endpoint,
    mode === 'length'
      ? { 'Content-Length': '65537' }
      : mode === 'header'
        ? { Authorization: 'x'.repeat(17000) }
        : {}
  );
  const e = env();
  expect((await gateway.fetch(s.request, e)).status).toBe(mode === 'path' ? 404 : 502);
  expect(e.STAGING_CAPABILITY_INGRESS.fetch).not.toHaveBeenCalled();
  expect(s.cancel).toHaveBeenCalled();
});
it('bounds a stalled client body before the first binding invocation', async () => {
  vi.useFakeTimers();
  const s = streaming();
  const e = env();
  const p = gateway.fetch(s.request, e);
  await vi.advanceTimersByTimeAsync(8000);
  expect((await p).status).toBe(502);
  expect(s.cancel).toHaveBeenCalled();
  expect(e.STAGING_CAPABILITY_INGRESS.fetch).not.toHaveBeenCalled();
});
it('returns only fixed failures for raw and encoded exception canaries', async () => {
  const canary = 'PRIVATE_BEARER_CANARY';
  const spy = vi.spyOn(console, 'error');
  const fetch = vi.fn(async () => {
    throw new Error(
      canary + encodeURIComponent('https://example.test/?secret=' + canary) + btoa(canary)
    );
  });
  const r = await gateway.fetch(
    new Request(endpoint, { method: 'POST', headers, body: '{}' }),
    env(fetch)
  );
  expect(r.status).toBe(502);
  expect(await r.text()).toBe('{"error":"staging_gateway_unavailable"}');
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
it('cancels a redirected response even if its status is 200', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  Object.defineProperty(response, 'redirected', { value: true });
  const e = env(vi.fn(async () => response));
  expect(
    (await gateway.fetch(new Request(endpoint, { method: 'POST', headers, body: '{}' }), e)).status
  ).toBe(502);
  expect(cancel).toHaveBeenCalled();
});

it('aborts an in-flight binding and cancels its late body without accepting late success', async () => {
  const client = new AbortController();
  let release!: (response: Response) => void;
  let entered!: () => void;
  const called = new Promise<void>(resolve => {
    entered = resolve;
  });
  let forwarded: AbortSignal | undefined;
  const fetch = vi.fn((request: Request) => {
    forwarded = request.signal;
    entered();
    return new Promise<Response>(resolve => {
      release = resolve;
    });
  });
  const pending = gateway.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers,
      body: '{}',
      signal: client.signal,
    }),
    env(fetch)
  );
  await called;
  client.abort();
  expect((await pending).status).toBe(502);
  expect(forwarded?.aborted).toBe(true);
  const canceled = vi.fn(() => Promise.reject(new Error('PRIVATE_CANCEL_CANARY')));
  release(
    new Response(new ReadableStream({ cancel: canceled }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(canceled).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});
