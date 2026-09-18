import { afterEach, describe, expect, it, vi } from 'vitest';
import gateway from '../../src/managed/staging/https-gateway';
// Synthetic frozen SDK e263209 fixture. Source SHA256:
// 68d8c9dbd0bc4c99ec32607ebebe8463cfb92716af54c711b594ce677e23c7e7
// Gateway transports these bytes; it does not authenticate the MAC or confirmation.
const fixture = {
  request: {
    schemaVersion: 2,
    intent: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      issuedAt: 1800000000000,
      expiresAt: 1800000060000,
      submissionId: 'fixture-submission',
      payloadDigest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      applicationId: 'app_fixture',
      credentialId: '22222222-2222-4222-8222-222222222222',
      keyId: 'ICEiIyQlJicoKSorLC0uLw',
      installationGeneration: '33333333-3333-4333-8333-333333333333',
      endpoint: 'https://issuance.example.test/v2/submission-capabilities',
      deploymentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      catalogDigest: 'd3ac8a92c537d29b53f4d4fe6a8a73a5358997cda02ab25b76f61fa4304e6995',
      origin: 'https://customer.example.test',
      serverSdkVersion: '0.1.0',
      browserSdkVersion: '0.2.0',
      normalizedVersions: {
        sdkVersion: '0.1.0',
        browserSdkVersion: '0.2.0',
        widgetVersion: null,
        protocolVersion: 2,
      },
    },
  },
  response: {
    schemaVersion: 2,
    capability: {
      schemaVersion: 1,
      token:
        'eyJhbGciOiJFUzI1NiIsImtpZCI6ImNhcC12Mi1maXh0dXJlIiwidHlwIjoiYnVnZHJvcC1tYW5hZ2VkLWNhcGFiaWxpdHktdjIifQ.eyJwcm90b2NvbFZlcnNpb24iOjIsImlzcyI6ImJ1Z2Ryb3AtbWFuYWdlZC1zdGFnaW5nLXYyIiwiYXVkIjoiYnVnZHJvcC1tYW5hZ2VkLXN0YWdpbmctaW5ncmVzcy12MiIsInB1YmxpY0FwcGxpY2F0aW9uSWQiOiJhcHBfZml4dHVyZSIsImp0aSI6Ijg4ODg4ODg4LTg4ODgtNDg4OC04ODg4LTg4ODg4ODg4ODg4OCIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMzAwfQ.1EdercTG-1vM0nRoVneDcfoFbu0xId_oKZjMfYInCZna6GwuRlEW_a72O4baekU-yneOUPoA7w67lAvCiftTaw',
      expiresAt: '2027-01-15T08:05:00.000Z',
    },
    confirmation: {
      schemaVersion: 2,
      kid: 'fixture-confirmation',
      intentDigest: 'c3e655f1b1171a2ed53c49bf7417eb9bed4ed9bebfa8848273e4c3d29515a3c3',
      capabilityDigest: 'a35e2871234d980498d80ff91d454ec513b603a48448e55eda189aa16f3301c7',
      reservedAt: 1800000000000,
      retentionDeadline: 1802592000000,
      admittedAt: 1800000001000,
      expiresAt: 1800000060000,
      signature:
        'Y8iloxQP-ixoCp6V4yLxjpuMDh9TfcolJLLkl-hUYGUjlbkkt7FhpXt7R2IX3c2r8gZ4ACLbRpzDV7hl4Rk7pA',
    },
  },
  authorization:
    'Bearer bd_auth_v2.ICEiIyQlJicoKSorLC0uLw.zZHyKjQ-My1Nmh-tdSR33HBJdkvYVaojdWtsWJEpJOA',
  signature: 'XTeYYCdWY7TrPy9kwUNzVdRP_qXpGSsCLT5Rn4rUW_Y',
};
const origin = 'https://issuance.example.test';
const endpoint = origin + '/v2/submission-capabilities';
const media = 'application/vnd.bugdrop.submission-capability.v2+json';
const headers = {
  'Content-Type': 'application/json',
  Accept: media,
  'X-BugDrop-Contract-Version': '2',
  'X-BugDrop-SDK-Version': '0.1.0',
  Authorization: fixture.authorization,
  'X-BugDrop-Intent-Signature': fixture.signature,
};
function setup() {
  const fetch = vi.fn(
    async (_r: Request) =>
      new Response(JSON.stringify(fixture.response), {
        headers: { 'Content-Type': media, 'Cache-Control': 'no-store' },
      })
  );
  const env = {
    ENVIRONMENT: 'staging',
    GATEWAY_ENABLED: 'true',
    GATEWAY_ORIGIN: origin,
    STAGING_CAPABILITY_INGRESS: { fetch },
  };
  const request = (init: RequestInit = {}, url = endpoint) =>
    new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(fixture.request),
      ...init,
    });
  return { fetch, env, request };
}
afterEach(() => vi.useRealTimers());
describe('frozen opt-in V2 gateway transport', () => {
  it('forwards exact body and MAC and returns the untouched issuer confirmation', async () => {
    const s = setup();
    const raw = JSON.stringify(fixture.request, null, 2);
    const response = await gateway.fetch(
      s.request({
        body: raw,
        headers: {
          ...headers,
          Cookie: 'PRIVATE',
          'X-BugDrop-Control-Signature': 'PRIVATE',
          'X-Forwarded-Host': 'PRIVATE',
        },
      }),
      s.env
    );
    expect(response.status).toBe(200);
    expect(s.fetch).toHaveBeenCalledOnce();
    const forwarded = s.fetch.mock.calls[0][0];
    expect(forwarded.url).toBe(endpoint);
    expect(forwarded.redirect).toBe('manual');
    expect(Object.fromEntries(forwarded.headers)).toEqual(Object.fromEntries(new Headers(headers)));
    expect(await forwarded.text()).toBe(raw);
    expect(await response.text()).toBe(JSON.stringify(fixture.response));
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'no-store',
      'content-type': media,
    });
  });
  it.each(Object.keys(headers))(
    'rejects missing required header %s before dispatch',
    async name => {
      const s = setup();
      const h = new Headers(headers);
      h.delete(name);
      expect((await gateway.fetch(s.request({ headers: h }), s.env)).status).toBe(404);
      expect(s.fetch).not.toHaveBeenCalled();
    }
  );
  it.each([
    { Accept: 'application/vnd.bugdrop.submission-capability.v1+json' },
    { 'X-BugDrop-Contract-Version': '1' },
    { 'X-BugDrop-SDK-Version': '01.2.3' },
    { Authorization: fixture.authorization.replace('bd_auth_v2', 'bd_auth_v1') },
    { 'X-BugDrop-Intent-Signature': fixture.signature + '=' },
    { 'X-BugDrop-Client-Metadata-Schema': '2' },
    { 'X-BugDrop-Browser-SDK-Version': '0.2.0' },
  ])('rejects invalid or mixed protocol headers %j', async patch => {
    const s = setup();
    expect(
      (await gateway.fetch(s.request({ headers: { ...headers, ...patch } }), s.env)).status
    ).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each(Object.keys(headers))('rejects visible coalesced duplicate %s', async name => {
    const s = setup();
    const h = new Headers(headers);
    h.append(name, h.get(name)!);
    expect((await gateway.fetch(s.request({ headers: h }), s.env)).status).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each(['/', '?x=1', '#x'])('rejects V2 path suffix %s', async suffix => {
    const s = setup();
    expect((await gateway.fetch(s.request({}, endpoint + suffix), s.env)).status).toBe(404);
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each([32768, 32769])('bounds actual request bytes at %s', async size => {
    const s = setup();
    const raw = JSON.stringify(fixture.request);
    const response = await gateway.fetch(
      s.request({ body: raw + ' '.repeat(size - raw.length) }),
      s.env
    );
    expect(response.status).toBe(size === 32768 ? 200 : 502);
    expect(s.fetch).toHaveBeenCalledTimes(size === 32768 ? 1 : 0);
  });
  it.each([
    '{}',
    '{"schemaVersion":1,"intent":{}}',
    JSON.stringify(fixture.request).replace(
      '"schemaVersion":2',
      '"schemaVersion":2,"schemaVersion":2'
    ),
    JSON.stringify(fixture.request).replace('"intent":{', '"intent":{"attemptId":"other",'),
    JSON.stringify(fixture.request).replace(
      '"protocolVersion":2',
      '"protocolVersion":2,"protocolVersion":2'
    ),
    JSON.stringify(fixture.request).replace('1800000000000', '1.8e12'),
    JSON.stringify(fixture.request).replace('1800000000000', '-0'),
    JSON.stringify({ ...fixture.request, extra: {} }),
    JSON.stringify({
      ...fixture.request,
      intent: { ...fixture.request.intent, serverSdkVersion: '0.2.0' },
    }),
    JSON.stringify({
      ...fixture.request,
      intent: { ...fixture.request.intent, endpoint: origin + '/v1/submission-capabilities' },
    }),
  ])('rejects malformed/mixed V2 body %# before dispatch', async body => {
    const s = setup();
    expect((await gateway.fetch(s.request({ body }), s.env)).status).toBe(502);
    expect(s.fetch).not.toHaveBeenCalled();
  });
});

it.each([64, 65])('bounds Worker-visible incoming header count at %s', async count => {
  const s = setup();
  const h = new Headers(headers);
  for (let i = [...h].length; i < count; i++) h.set(`X-Filler-${i}`, 'a');
  expect((await gateway.fetch(s.request({ headers: h }), s.env)).status).toBe(
    count === 64 ? 200 : 404
  );
  expect(s.fetch).toHaveBeenCalledTimes(count === 64 ? 1 : 0);
});
it.each([32768, 32769])('bounds serialized UTF-8 incoming header bytes at %s', async size => {
  const s = setup();
  const h = new Headers(headers);
  h.set('X-Padding', '');
  const bytes = new TextEncoder().encode([...h].map(([k, v]) => `${k}:${v}\r\n`).join('')).length;
  h.set('X-Padding', 'a'.repeat(size - bytes));
  expect((await gateway.fetch(s.request({ headers: h }), s.env)).status).toBe(
    size === 32768 ? 200 : 404
  );
  expect(s.fetch).toHaveBeenCalledTimes(size === 32768 ? 1 : 0);
});
it.each(['32769', '01', '4,4', '1'])('rejects invalid V2 declared length %s', async length => {
  const s = setup();
  expect(
    (await gateway.fetch(s.request({ headers: { ...headers, 'Content-Length': length } }), s.env))
      .status
  ).toBe(502);
  expect(s.fetch).not.toHaveBeenCalled();
});
it('preserves valid length bytes but does not forward the caller length', async () => {
  const s = setup();
  const raw = JSON.stringify(fixture.request);
  expect(
    (
      await gateway.fetch(
        s.request({ headers: { ...headers, 'Content-Length': String(raw.length) } }),
        s.env
      )
    ).status
  ).toBe(200);
  expect(s.fetch.mock.calls[0][0].headers.has('Content-Length')).toBe(false);
});
it.each([
  '\uFEFF' + JSON.stringify(fixture.request),
  JSON.stringify(fixture.request) + 'x',
  JSON.stringify(fixture.request).replace(
    '"schemaVersion":2',
    '"schemaVersion":2,"schema\\u0056ersion":2'
  ),
  JSON.stringify(fixture.request).replace('fixture-submission', '\\ud800'),
  JSON.stringify(fixture.request).replace('"widgetVersion":null', '"widgetVersion":[[[null]]]'),
  new Uint8Array([0xff, 0xfe]),
])('rejects raw JSON ambiguity, UTF-8, surrogate or nesting violation %#', async body => {
  const s = setup();
  expect((await gateway.fetch(s.request({ body }), s.env)).status).toBe(502);
  expect(s.fetch).not.toHaveBeenCalled();
});
it('accepts escaped strings and astral Unicode without changing the signed bytes', async () => {
  const s = setup();
  const body = structuredClone(fixture.request);
  body.intent.submissionId = '😀 "quoted":{},[] \\ test';
  const raw = JSON.stringify(body);
  expect((await gateway.fetch(s.request({ body: raw }), s.env)).status).toBe(200);
  expect(await s.fetch.mock.calls[0][0].text()).toBe(raw);
});
it('passes a syntactically valid changed MAC unchanged for issuer authentication', async () => {
  const s = setup();
  const modified = 'A' + fixture.signature.slice(1);
  s.fetch.mockImplementation(async r => {
    expect(r.headers.get('X-BugDrop-Intent-Signature')).toBe(modified);
    return new Response('{"schemaVersion":2,"error":"authentication_failed"}', {
      status: 401,
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store' },
    });
  });
  expect(
    (
      await gateway.fetch(
        s.request({ headers: { ...headers, 'X-BugDrop-Intent-Signature': modified } }),
        s.env
      )
    ).status
  ).toBe(401);
  expect(s.fetch).toHaveBeenCalledOnce();
});
it('never forwards the intent MAC on V1 or rewrites a V2 request into V1', async () => {
  const s = setup();
  expect(
    (await gateway.fetch(s.request({}, origin + '/v1/submission-capabilities'), s.env)).status
  ).toBe(404);
  expect(s.fetch).not.toHaveBeenCalled();
  s.fetch.mockImplementation(async r => {
    expect(r.headers.has('X-BugDrop-Intent-Signature')).toBe(false);
    expect(r.headers.get('Authorization')).toBe(fixture.authorization);
    // The current V1 issuer rejects this V2 prefix; the gateway does not replace it.
    return new Response('{"error":"managed_request_rejected"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  });
  const r = s.request(
    {
      headers: {
        ...headers,
        Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
        'X-BugDrop-Contract-Version': '1',
      },
    },
    origin + '/v1/submission-capabilities'
  );
  expect((await gateway.fetch(r, s.env)).status).toBe(403);
  expect(s.fetch).toHaveBeenCalledOnce();
});
it.each([200, 400, 401, 403, 409, 410, 503])(
  'preserves V2 issuer response status %s with no extra headers',
  async status => {
    const s = setup();
    const body =
      status === 200
        ? JSON.stringify(fixture.response)
        : JSON.stringify({
            schemaVersion: 2,
            error: {
              400: 'invalid_request',
              401: 'authentication_failed',
              403: 'scope_rejected',
              409: 'binding_conflict',
              410: 'attempt_expired',
              503: 'temporarily_unavailable',
            }[status],
          });
    s.fetch.mockResolvedValue(
      new Response(body, {
        status,
        headers: {
          'Content-Type': media,
          'Cache-Control': 'no-store',
          'X-Private': 'PRIVATE',
          Date: 'Fri, 18 Sep 2026 12:00:00 GMT',
          Server: 'synthetic',
        },
      })
    );
    const r = await gateway.fetch(s.request(), s.env);
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
    expect([...r.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
  }
);
it.each([
  { 'Content-Type': 'application/json' },
  { 'Content-Type': media + ', ' + media },
  { 'Cache-Control': 'no-store, no-store' },
  { 'Set-Cookie': 'PRIVATE' },
  { Location: 'https://example.test' },
  { 'Content-Encoding': 'gzip' },
])('rejects incompatible V2 issuer headers %j and cancels body', async patch => {
  const s = setup();
  const cancel = vi.fn();
  s.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store', ...patch },
    })
  );
  expect((await gateway.fetch(s.request(), s.env)).status).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
  expect(s.fetch).toHaveBeenCalledOnce();
});
it.each([65536, 65537])('bounds V2 response at %s bytes without partial success', async size => {
  const s = setup();
  const raw = JSON.stringify(fixture.response);
  s.fetch.mockResolvedValue(
    new Response(raw + ' '.repeat(size - raw.length), {
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store' },
    })
  );
  expect((await gateway.fetch(s.request(), s.env)).status).toBe(size === 65536 ? 200 : 502);
});
it('does not manufacture or authenticate confirmation for an invalid issuer body', async () => {
  const s = setup();
  s.fetch.mockResolvedValue(
    new Response('{"schemaVersion":2}', {
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store' },
    })
  );
  const r = await gateway.fetch(s.request(), s.env);
  expect(await r.text()).toBe('{"schemaVersion":2}'); // SDK must reject; HTTP200 is not mint evidence.
});
it('cancels a stalled V2 body at8s without dispatching or retrying', async () => {
  vi.useFakeTimers();
  const s = setup();
  const cancel = vi.fn();
  const pending = gateway.fetch(
    s.request({ body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit),
    s.env
  );
  await vi.advanceTimersByTimeAsync(8000);
  expect((await pending).status).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
  expect(s.fetch).not.toHaveBeenCalled();
});
it('rejects duplicate entries still visible to an adapter, including case aliases', async () => {
  const s = setup();
  const r = s.request();
  const h = r.headers;
  Object.defineProperty(r, 'headers', {
    value: {
      get: h.get.bind(h),
      has: h.has.bind(h),
      *[Symbol.iterator]() {
        yield* h;
        yield ['AUTHORIZATION', fixture.authorization];
      },
    },
  });
  expect((await gateway.fetch(r, s.env)).status).toBe(404);
  expect(s.fetch).not.toHaveBeenCalled();
});
it.each(['01', '99999', '1', '42,42'])('rejects V2 response length %s', async length => {
  const s = setup();
  s.fetch.mockResolvedValue(
    new Response(JSON.stringify(fixture.response), {
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store', 'Content-Length': length },
    })
  );
  expect((await gateway.fetch(s.request(), s.env)).status).toBe(502);
});
it('bounds V2 response headers before reading the body', async () => {
  for (const mode of ['count', 'bytes']) {
    const s = setup();
    const h = new Headers({ 'Content-Type': media, 'Cache-Control': 'no-store' });
    if (mode === 'count') for (let i = 0; i < 63; i++) h.set(`X-${i}`, 'a');
    else h.set('X-Large', 'a'.repeat(32769));
    const cancel = vi.fn();
    s.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: h }));
    expect((await gateway.fetch(s.request(), s.env)).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  }
});
it('uses the same8s budget for upload and delayed issuer response, canceling late success', async () => {
  vi.useFakeTimers();
  const s = setup();
  const cancel = vi.fn();
  s.fetch.mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 5000));
    return new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': media, 'Cache-Control': 'no-store' },
    });
  });
  const body = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(fixture.request)));
        controller.close();
      }, 4000);
    },
  });
  const p = gateway.fetch(s.request({ body, duplex: 'half' } as RequestInit), s.env);
  await vi.advanceTimersByTimeAsync(7999);
  expect(s.fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect((await p).status).toBe(502);
  await vi.advanceTimersByTimeAsync(1000);
  expect(cancel).toHaveBeenCalledOnce();
  expect(s.fetch).toHaveBeenCalledOnce();
});
it('never reflects or logs V2 bearer, MAC, body or binding exception canaries', async () => {
  const s = setup();
  const spies = ['error', 'warn', 'log'].map(name =>
    vi.spyOn(console, name as 'error' | 'warn' | 'log')
  );
  try {
    s.fetch.mockImplementation(async () => {
      throw Error(
        'PRIVATE_CANARY' +
          fixture.authorization +
          fixture.signature +
          JSON.stringify(fixture.request)
      );
    });
    const r = await gateway.fetch(s.request(), s.env);
    expect(await r.text()).toBe('{"error":"staging_gateway_unavailable"}');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    spies.forEach(spy => spy.mockRestore());
  }
});
