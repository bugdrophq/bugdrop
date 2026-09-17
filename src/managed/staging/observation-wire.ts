import { hmac, json, keys, record, reject, utf8, verifyHmac } from '../local/protocol';

export class ObservationScopeError extends Error {}

export interface ObservationEnv {
  ENVIRONMENT: string;
  STAGING_ENABLED: string;
  STAGING_OBSERVATION_ENABLED: string;
  STAGING_APPLICATION_ID: string;
  STAGING_INSTALLATION_ID: string;
  STAGING_OBSERVATION_HMAC_KEY: string;
}
export function observationScope(env: ObservationEnv) {
  if (
    env.ENVIRONMENT !== 'staging' ||
    env.STAGING_ENABLED !== 'true' ||
    env.STAGING_OBSERVATION_ENABLED !== 'true' ||
    env.STAGING_APPLICATION_ID === 'UNAPPROVED' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(env.STAGING_APPLICATION_ID) ||
    !/^[1-9][0-9]{0,19}$/.test(env.STAGING_INSTALLATION_ID)
  )
    reject();
  return {
    schemaVersion: 2,
    applicationId: env.STAGING_APPLICATION_ID,
    installationId: env.STAGING_INSTALLATION_ID,
  };
}
export function observationMessage(path: string, raw: Uint8Array, response = false) {
  const prefix = utf8(
    `bugdrop:staging:observation-${response ? 'response' : 'request'}:v2\0${path}\0`
  );
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix);
  message.set(raw, prefix.length);
  return message;
}
export async function observationReply(path: string, body: unknown, key: string) {
  const raw = utf8(JSON.stringify(body));
  return new Response(raw, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-BugDrop-Observation-Signature': await hmac(key, observationMessage(path, raw, true)),
    },
  });
}
export async function observationCall(
  service: Fetcher,
  env: ObservationEnv,
  path: string,
  fields: object
) {
  const scope = observationScope(env);
  const secret = env.STAGING_OBSERVATION_HMAC_KEY;
  const requestNonce = crypto.randomUUID();
  const raw = utf8(JSON.stringify({ ...scope, ...fields, requestNonce }));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reply: Response;
  let body: Uint8Array;
  const signature = await hmac(secret, observationMessage(path, raw));
  try {
    ({ reply, body } = await Promise.race([
      (async () => {
        const reply = await service.fetch(`http://observation.bugdrop.localhost${path}`, {
          method: 'POST',
          body: raw,
          signal: controller.signal,
          headers: { 'X-BugDrop-Observation-Signature': signature },
        });
        if (controller.signal.aborted) {
          void reply.body?.cancel().catch(() => {});
          reject();
        }
        reader = reply.body?.getReader();
        const bytes = new Uint8Array(16384);
        let size = 0;
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (size + chunk.value.length > bytes.length) reject();
          bytes.set(chunk.value, size);
          size += chunk.value.length;
        }
        return { reply, body: bytes.slice(0, size) };
      })(),
      new Promise<never>((_, failed) => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          failed(new Error('observation_timeout'));
        }, 2000);
      }),
    ]));
  } finally {
    if (timer) clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
  if (
    reply.status !== 200 ||
    JSON.stringify(observationScope(env)) !== JSON.stringify(scope) ||
    secret !== env.STAGING_OBSERVATION_HMAC_KEY ||
    !(await verifyHmac(
      secret,
      observationMessage(path, body, true),
      reply.headers.get('X-BugDrop-Observation-Signature') ?? ''
    ))
  )
    reject();
  return validateObservationReply(json(body), scope.applicationId, { ...fields, requestNonce });
}
export function exactObservation(value: unknown, fields: string[]) {
  const body = record(value);
  keys(body, fields);
  if (Object.keys(body).length !== fields.length) reject();
  return body;
}
export function observationUuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    reject();
}

function validateObservationReply(value: unknown, applicationId: string, expected: object) {
  const body = exactObservation(value, [
    'schemaVersion',
    'requestNonce',
    'leaseId',
    'expiresAt',
    'sequence',
    'snapshot',
    'exchanges',
  ]);
  observationUuid(body.leaseId);
  observationUuid(body.requestNonce);
  const snapshot = exactObservation(body.snapshot, [
    'runId',
    'scenario',
    'applicationId',
    'count',
    'complete',
    'exclusive',
  ]);
  observationUuid(snapshot.runId);
  if (
    body.schemaVersion !== 2 ||
    typeof body.expiresAt !== 'number' ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= Date.now() ||
    snapshot.applicationId !== applicationId ||
    typeof snapshot.scenario !== 'string' ||
    snapshot.scenario.length > 64 ||
    typeof snapshot.complete !== 'boolean' ||
    typeof snapshot.exclusive !== 'boolean' ||
    !Array.isArray(body.exchanges) ||
    body.exchanges.length > 64 ||
    snapshot.count !== body.exchanges.length
  )
    reject();
  body.exchanges.forEach((value, index) => {
    const entry = exactObservation(value, ['sequence', 'sdkVersion', 'status']);
    if (
      entry.sequence !== index + 1 ||
      (entry.sdkVersion !== null && entry.sdkVersion !== '0.1.0') ||
      (entry.status !== null &&
        (typeof entry.status !== 'number' ||
          !Number.isInteger(entry.status) ||
          entry.status < 200 ||
          entry.status > 599)) ||
      (snapshot.complete && (entry.status === null || entry.sdkVersion === null))
    )
      reject();
  });
  if (
    body.sequence !== null &&
    (typeof body.sequence !== 'number' ||
      !Number.isSafeInteger(body.sequence) ||
      body.sequence < 1 ||
      body.sequence > body.exchanges.length)
  )
    reject();
  const selectors = record(expected);
  if (selectors.requestNonce !== body.requestNonce) reject();
  if (
    ('leaseId' in selectors && selectors.leaseId !== body.leaseId) ||
    ('runId' in selectors && selectors.runId !== snapshot.runId) ||
    ('scenario' in selectors && selectors.scenario !== snapshot.scenario)
  )
    reject();
  return body;
}
