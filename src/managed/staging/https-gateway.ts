/** Issuance-only transport; credential/MAC and confirmation authentication belong to issuer/SDK. */
interface GatewayEnv {
  ENVIRONMENT: string;
  GATEWAY_ENABLED: string;
  GATEWAY_ORIGIN: string;
  STAGING_CAPABILITY_INGRESS: { fetch(request: Request): Promise<Response> };
}
const v2Media = 'application/vnd.bugdrop.submission-capability.v2+json';
const mac = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const stableVersion = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
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
  const v2 = request.url === env.GATEWAY_ORIGIN + '/v2/submission-capabilities';
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
    (!v2 && request.url !== env.GATEWAY_ORIGIN + '/v1/submission-capabilities') ||
    request.method !== 'POST' ||
    request.headers.has('Content-Encoding') ||
    (request.headers.has('Host') && request.headers.get('Host') !== origin.host)
  )
    return false;
  if (v2) {
    if (!visibleHeaders(request.headers)) return false;
    return (
      request.headers.get('Content-Type') === 'application/json' &&
      request.headers.get('Accept') === v2Media &&
      request.headers.get('X-BugDrop-Contract-Version') === '2' &&
      stableVersion.test(request.headers.get('X-BugDrop-SDK-Version') ?? '') &&
      /^Bearer bd_auth_v2\.[A-Za-z0-9_-]{21}[AQgw]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(
        request.headers.get('Authorization') ?? ''
      ) &&
      mac.test(request.headers.get('X-BugDrop-Intent-Signature') ?? '') &&
      !request.headers.has('X-BugDrop-Client-Metadata-Schema') &&
      !request.headers.has('X-BugDrop-Browser-SDK-Version')
    );
  }
  // Compare the Worker-visible URL, not a claim about pre-normalization wire bytes.
  return Object.entries(protocolHeaders).every(
    ([name, value]) => request.headers.get(name) === value
  );
}
function visibleHeaders(headers: Headers): boolean {
  const names = new Set<string>();
  let size = 0;
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (names.has(key)) return false;
    names.add(key);
    size += new TextEncoder().encode(`${key}:${value}\r\n`).length;
    if (names.size > 64 || size > 32_768) return false;
  }
  return true;
}
function forwardedHeaders(request: Request, v2: boolean): Headers {
  const headers = new Headers(protocolHeaders);
  if (v2) {
    for (const name of [...Object.keys(protocolHeaders), 'X-BugDrop-Intent-Signature'])
      headers.set(name, request.headers.get(name)!);
  }
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
  signal: AbortSignal,
  maxBytes = limit
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
      if (size > maxBytes) return stop();
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
// Validate lexical boundaries before JSON materialization, without rewriting MAC-bound bytes.
function v2Json(body: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  const tokens =
    text.match(
      /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}[\]:,]|true|false|null/g
    ) ?? [];
  const stack: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      stack.push(new Set());
      if (stack.length > 4) stop();
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"')) {
      const value: string = JSON.parse(token);
      if (/[\uD800-\uDFFF]/u.test(value)) stop();
      if (tokens[i + 1] === ':') {
        const keys = stack[stack.length - 1];
        if (!keys || keys.has(value)) stop();
        keys.add(value);
      }
    } else if (/^-?[0-9]/.test(token) && !/^(0|[1-9][0-9]*)$/.test(token)) stop();
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) stop();
  return value;
}
function exact(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name))
  );
}
function v2Request(body: Uint8Array, request: Request): void {
  const input = v2Json(body);
  if (
    !exact(input, ['schemaVersion', 'intent']) ||
    input.schemaVersion !== 2 ||
    !exact(input.intent, [
      'attemptId',
      'issuedAt',
      'expiresAt',
      'submissionId',
      'payloadDigest',
      'applicationId',
      'credentialId',
      'keyId',
      'installationGeneration',
      'endpoint',
      'deploymentDigest',
      'catalogDigest',
      'origin',
      'serverSdkVersion',
      'browserSdkVersion',
      'normalizedVersions',
    ]) ||
    input.intent.endpoint !== request.url ||
    input.intent.serverSdkVersion !== request.headers.get('X-BugDrop-SDK-Version') ||
    !exact(input.intent.normalizedVersions, [
      'sdkVersion',
      'browserSdkVersion',
      'widgetVersion',
      'protocolVersion',
    ])
  )
    stop();
  // Value, scope, clock, catalog and MAC authentication remain issuer responsibilities.
}
async function exchange(request: Request, env: GatewayEnv, signal: AbortSignal): Promise<Response> {
  const target = env.STAGING_CAPABILITY_INGRESS;
  const v2 = request.headers.get('X-BugDrop-Contract-Version') === '2';
  const headers = forwardedHeaders(request, v2);
  const requestLimit = v2 ? 32_768 : limit;
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > requestLimit))
    return stop();
  const body = await read(request.body, signal, requestLimit);
  if (declared !== null && Number(declared) !== body.byteLength) return stop();
  if (v2) v2Request(body, request);
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
  const responseLength = v2 ? response.headers.get('Content-Length') : null;
  if (
    !(v2 ? [200, 400, 401, 403, 409, 410, 503] : [200, 403, 503]).includes(response.status) ||
    response.redirected ||
    (v2 && !visibleHeaders(response.headers)) ||
    (responseLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(responseLength) || Number(responseLength) > limit)) ||
    ['Location', 'Set-Cookie', 'Content-Encoding'].some(name => response.headers.has(name)) ||
    !(v2 ? [v2Media] : ['application/json', 'application/json; charset=utf-8']).includes(
      type ?? ''
    ) ||
    response.headers.get('Cache-Control') !== 'no-store'
  ) {
    cancel(response.body);
    return stop();
  }
  const bytes = await read(response.body, signal);
  if (responseLength !== null && Number(responseLength) !== bytes.byteLength) stop();
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
