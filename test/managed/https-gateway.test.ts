import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from '../../src/managed/staging/https-gateway';
const origin = 'https://issuance.example.test';
const endpoint = origin + '/v1/submission-capabilities';
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
  'X-BugDrop-Contract-Version': '1',
  'X-BugDrop-SDK-Version': '0.1.0',
  Authorization: 'Bearer invalid-but-opaque',
};
const reply = (status = 200, extra = {}) =>
  new Response('{"schemaVersion":1,"token":"fixture","expiresAt":"fixture"}', {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
function setup(response = reply()) {
  const fetch = vi.fn(async (_request: Request) => response);
  const env = {
    ENVIRONMENT: 'staging',
    GATEWAY_ENABLED: 'true',
    GATEWAY_ORIGIN: origin,
    STAGING_CAPABILITY_INGRESS: { fetch },
  };
  const request = (url = endpoint, init: RequestInit = {}) =>
    new Request(url, {
      method: 'POST',
      headers,
      body: '{ "origin":"https://app.example.test" }',
      ...init,
    });
  return { fetch, env, request };
}
afterEach(() => vi.useRealTimers());
describe('gateway request boundary', () => {
  it.each([
    '/github/staging/webhook',
    '/submit',
    '/observation/read',
    '/status',
    '/resume',
    '/continue',
    '/projection',
    '/',
    '/unknown',
    '/v1/submission-capabilities/',
    '/v1//submission-capabilities',
    '/V1/submission-capabilities',
    '/v1/%73ubmission-capabilities',
    '/v1%2fsubmission-capabilities',
    '/v1%252fsubmission-capabilities',
    '/v1/%00',
    '/v1/submission-capabilities?secret=canary',
    '/v1/submission-capabilities?',
    '/v1/submission-capabilities#fragment',
    '/v1/submission-capabilities;other',
  ])('rejects %s before binding', async path => {
    const s = setup();
    expect((await gateway.fetch(s.request(origin + path), s.env)).status).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'])(
    'rejects method %s',
    async method => {
      const s = setup();
      expect(
        (await gateway.fetch(s.request(endpoint, { method, body: undefined }), s.env)).status
      ).toBe(404);
      expect(s.fetch).not.toHaveBeenCalled();
    }
  );
  it.each([
    'http://issuance.example.test',
    'https://other.example.test',
    'https://issuance.example.test:444',
    'https://user:pass@issuance.example.test',
  ])('rejects URL identity %s', async host => {
    const s = setup();
    // Node Request rejects credentials before dispatch; exercise the Worker-visible URL gate directly.
    const r = s.request();
    Object.defineProperty(r, 'url', { value: host + '/v1/submission-capabilities' });
    expect((await gateway.fetch(r, s.env)).status).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { GATEWAY_ENABLED: 'false' },
    { ENVIRONMENT: 'production' },
    { GATEWAY_ORIGIN: 'UNAPPROVED' },
    { GATEWAY_ORIGIN: 'https://gateway.localhost' },
    { GATEWAY_ORIGIN: 'https://127.0.0.1' },
    { GATEWAY_ORIGIN: 'https://issuance.example.test:443' },
  ])('fails closed with config %j', async patch => {
    const s = setup();
    expect((await gateway.fetch(s.request(), { ...s.env, ...patch })).status).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { 'Content-Type': 'application/json; charset=utf-8' },
    { 'Content-Encoding': 'gzip' },
    { Accept: '*/*' },
    { 'X-BugDrop-Contract-Version': '2' },
    { 'X-BugDrop-SDK-Version': 'other' },
    { Host: 'other.example.test' },
  ])('rejects headers %j', async patch => {
    const s = setup();
    expect(
      (await gateway.fetch(s.request(endpoint, { headers: { ...headers, ...patch } }), s.env))
        .status
    ).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('preserves exact bytes and application headers but strips privileged headers', async () => {
    const s = setup();
    const r = s.request(endpoint, {
      headers: {
        ...headers,
        Cookie: 'canary',
        'X-Hub-Signature-256': 'canary',
        'X-BugDrop-Control-Signature': 'canary',
        'X-Forwarded-Host': 'attacker',
      },
    });
    const body = await r.clone().text();
    const out = await gateway.fetch(r, s.env);
    expect(out.status).toBe(200);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const forwarded = s.fetch.mock.calls[0][0];
    expect(forwarded.url).toBe(endpoint);
    expect(forwarded.redirect).toBe('manual');
    expect(await forwarded.text()).toBe(body);
    expect(Object.fromEntries(forwarded.headers)).toEqual(Object.fromEntries(new Headers(headers)));
  });
  it('passes missing auth and malformed JSON unchanged to the issuer', async () => {
    const s = setup(reply(403));
    const h = new Headers(headers);
    h.delete('Authorization');
    expect(
      (await gateway.fetch(s.request(endpoint, { headers: h, body: 'not json' }), s.env)).status
    ).toBe(403);
    expect(await s.fetch.mock.calls[0][0].text()).toBe('not json');
  });
  it.each(['65537', '01', '-1', '4,4'])(
    'rejects invalid length %s without binding',
    async length => {
      const s = setup();
      expect(
        (
          await gateway.fetch(
            s.request(endpoint, { headers: { ...headers, 'Content-Length': length }, body: '{}' }),
            s.env
          )
        ).status
      ).toBe(502);
      expect(s.fetch).not.toHaveBeenCalled();
    }
  );
  it('counts actual bytes and checks declared length', async () => {
    for (const init of [
      { body: 'x'.repeat(65537) },
      { body: '{}', headers: { ...headers, 'Content-Length': '1' } },
    ]) {
      const s = setup();
      expect((await gateway.fetch(s.request(endpoint, init), s.env)).status).toBe(502);
      expect(s.fetch).not.toHaveBeenCalled();
    }
  });
});
describe('gateway response boundary', () => {
  it.each([200, 403, 503])('preserves issuer status %s and only allowed headers', async status => {
    const s = setup(reply(status, { 'X-Private': 'canary' }));
    const r = await gateway.fetch(s.request(), s.env);
    expect(r.status).toBe(status);
    expect(r.headers.get('X-Private')).toBeNull();
    expect(await r.text()).toContain('fixture');
    expect([...r.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
  });
  it.each([201, 204, 301, 302, 307, 308, 401, 429, 500])(
    'fails closed on unexpected status %s',
    async status => {
      const s = setup(new Response(null, { status }));
      expect((await gateway.fetch(s.request(), s.env)).status).toBe(502);
      expect(s.fetch).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    { 'Set-Cookie': 'canary' },
    { Location: 'https://attacker.test' },
    { 'Content-Encoding': 'gzip' },
    { 'Content-Type': 'text/html' },
    { 'Cache-Control': 'public' },
  ])('rejects response headers %j', async extra => {
    const s = setup(reply(200, extra));
    const r = await gateway.fetch(s.request(), s.env);
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('canary');
  });
  it('bounds the response before returning any success', async () => {
    const s = setup(
      new Response('x'.repeat(65537), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    );
    expect((await gateway.fetch(s.request(), s.env)).status).toBe(502);
  });
  it('accepts a 64KiB boundary and explicitly rejects larger SDK-parseable JSON', async () => {
    for (const size of [65536, 65537]) {
      const envelope = JSON.stringify({
        schemaVersion: 1,
        token: 'a'.repeat(16384),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const text = envelope + ' '.repeat(size - envelope.length);
      expect(text.length).toBe(size);
      expect(JSON.parse(text).token).toHaveLength(16384);
      const s = setup(
        new Response(text, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      );
      expect((await gateway.fetch(s.request(), s.env)).status).toBe(size === 65536 ? 200 : 502);
    }
  });
  it('bounds a late fetch, cancels its body, and never retries', async () => {
    vi.useFakeTimers();
    const s = setup();
    const cancel = vi.fn();
    s.fetch.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 9000));
      return new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    });
    const pending = gateway.fetch(s.request(), s.env);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe(502);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('times out a stalled body and propagates client abort', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const s = setup(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    );
    const pending = gateway.fetch(s.request(), s.env);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe(502);
    expect(cancel).toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    const other = setup();
    expect(
      (await gateway.fetch(other.request(endpoint, { signal: controller.signal }), other.env))
        .status
    ).toBe(502);
    expect(other.fetch).not.toHaveBeenCalled();
  });
});
