/** Issuance-only gateway. Limits are proposed compatibility constraints, not SDK guarantees. */
interface GatewayEnv {
  ENVIRONMENT: string;
  GATEWAY_ENABLED: string;
  GATEWAY_ORIGIN: string;
  STAGING_CAPABILITY_INGRESS: { fetch(request: Request): Promise<Response> };
}
const path = '/v1/submission-capabilities';
const limit = 65_536;
const deadlineMs = 8_000;
const protocolHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
  'X-BugDrop-Contract-Version': '1',
  'X-BugDrop-SDK-Version': '0.1.0',
};
const failure = (status: 404 | 502) =>
  Response.json(
    { error: status === 404 ? 'staging_gateway_rejected' : 'staging_gateway_unavailable' },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
const stop = () => {
  throw new Error('staging_gateway_unavailable');
};
function admitted(request: Request, env: GatewayEnv): boolean {
  if (env.ENVIRONMENT !== 'staging' || env.GATEWAY_ENABLED !== 'true') return false;
  const origin = new URL(env.GATEWAY_ORIGIN);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.GATEWAY_ORIGIN ||
    origin.port ||
    origin.username ||
    origin.password ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(origin.hostname) ||
    origin.hostname.endsWith('.localhost') ||
    origin.hostname === 'localhost' ||
    request.url !== env.GATEWAY_ORIGIN + path ||
    request.method !== 'POST' ||
    request.headers.has('Content-Encoding') ||
    (request.headers.has('Host') && request.headers.get('Host') !== origin.host)
  )
    return false;
  // Compare the Worker-visible URL, not a claim about pre-normalization wire bytes.
  return Object.entries(protocolHeaders).every(
    ([name, value]) => request.headers.get(name) === value
  );
}
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(protocolHeaders);
  const auth = request.headers.get('Authorization');
  if (auth !== null) headers.set('Authorization', auth);
  const size = new TextEncoder().encode(
    [...headers].map(([k, v]) => `${k}:${v}\r\n`).join('')
  ).length;
  if (size > 16_384) stop();
  return headers;
}
function cancel(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => {});
}
async function read(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (signal.aborted) {
    cancel(body);
    return stop();
  }
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) return stop();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) return stop();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
async function exchange(request: Request, env: GatewayEnv, signal: AbortSignal): Promise<Response> {
  const target = env.STAGING_CAPABILITY_INGRESS;
  const headers = forwardedHeaders(request);
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > limit))
    return stop();
  const body = await read(request.body, signal);
  if (declared !== null && Number(declared) !== body.byteLength) return stop();
  if (signal.aborted) return stop();
  const response = await target.fetch(
    new Request(request.url, {
      method: 'POST',
      headers,
      body,
      signal,
      redirect: 'manual',
    })
  );
  if (signal.aborted) {
    cancel(response.body);
    return stop();
  }
  const type = response.headers.get('Content-Type');
  if (
    ![200, 403, 503].includes(response.status) ||
    response.redirected ||
    ['Location', 'Set-Cookie', 'Content-Encoding'].some(name => response.headers.has(name)) ||
    !['application/json', 'application/json; charset=utf-8'].includes(type ?? '') ||
    response.headers.get('Cache-Control') !== 'no-store'
  ) {
    cancel(response.body);
    return stop();
  }
  const bytes = await read(response.body, signal);
  if (signal.aborted) return stop();
  return new Response(bytes, {
    status: response.status,
    headers: { 'Content-Type': type!, 'Cache-Control': 'no-store' },
  });
}
export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    try {
      if (!admitted(request, env)) {
        cancel(request.body);
        return failure(404);
      }
    } catch {
      cancel(request.body);
      return failure(404);
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('staging_gateway_unavailable'));
    });
    const abort = () => {
      controller.abort();
      rejectAbort();
    };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      timeout = setTimeout(abort, deadlineMs);
      if (request.signal.aborted) abort();
      return await Promise.race([aborted, exchange(request, env, controller.signal)]);
    } catch {
      cancel(request.body);
      return failure(502);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  },
};
