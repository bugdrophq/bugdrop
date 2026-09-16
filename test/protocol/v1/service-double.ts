// Test-only compatibility model. Not a capability issuer or a token verifier.
import { createHash } from 'node:crypto';

export interface Binding {
  submissionId: string;
  payloadDigest: string;
}

function reject(): never {
  // Do not copy payloads, credentials, or unexpected identity fields into errors.
  throw new TypeError('Invalid managed protocol v1 request');
}

export function canonicalBytes(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return reject();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) return reject();
  return bytes;
}

export function parseBearer(value: string | null): { keyId: string; authSecret: Buffer } {
  const match = /^Bearer bd_auth_v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value ?? '');
  if (!match || match[0] !== value) return reject();
  canonicalBytes(match[1], 16);
  return { keyId: match[1], authSecret: canonicalBytes(match[2], 32) };
}

export function exactOrigin(value: unknown): string {
  if (typeof value !== 'string') return reject();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject();
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.origin !== value ||
    url.hostname.endsWith('.') ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    return reject();
  return value;
}

export function parseBinding(value: Record<string, unknown>): Binding {
  const { submissionId, payloadDigest } = value;
  if (typeof submissionId !== 'string') return reject();
  const bytes = Buffer.from(submissionId, 'utf8');
  if (bytes.length < 1 || bytes.length > 200 || bytes.toString('utf8') !== submissionId)
    return reject();
  canonicalBytes(payloadDigest, 32);
  return { submissionId, payloadDigest: payloadDigest as string };
}

export function parseExchange(headers: Headers, value: unknown, configuredOrigin: string) {
  parseBearer(headers.get('Authorization'));
  if (
    headers.get('X-BugDrop-Contract-Version') !== '1' ||
    headers.get('Accept') !== 'application/vnd.bugdrop.submission-capability.v1+json' ||
    headers.get('Content-Type') !== 'application/json'
  )
    return reject();
  const sdkVersion = headers.get('X-BugDrop-SDK-Version');
  // Capture the explicitly supplied package version; never infer it from contract version.
  if (
    !sdkVersion ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(sdkVersion)
  )
    return reject();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject();
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      key =>
        !['schemaVersion', 'submissionId', 'payloadDigest', 'origin', 'environment'].includes(key)
    )
  )
    return reject();
  if (body.schemaVersion !== 1) return reject();
  const binding = parseBinding(body);
  const origin = exactOrigin(configuredOrigin);
  if (body.origin !== undefined && exactOrigin(body.origin) !== origin) return reject();
  if (
    body.environment !== undefined &&
    (typeof body.environment !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(body.environment))
  )
    return reject();
  return { ...binding, sdkVersion, origin };
}

export function verifyBinding(bound: Binding, submissionId: string, rawBody: Uint8Array): void {
  parseBinding({ ...bound });
  if (
    bound.submissionId !== submissionId ||
    createHash('sha256').update(rawBody).digest('base64url') !== bound.payloadDigest
  )
    return reject();
}

export async function signedOnlyDouble(
  verify: () => Promise<Binding>,
  submissionId: string,
  rawBody: Uint8Array,
  deliverManaged: (verifiedBody: Uint8Array) => Promise<void>
): Promise<'accepted' | 'rejected'> {
  // verify stands in for managed authentication; this harness never accepts opaque tokens itself.
  try {
    verifyBinding(await verify(), submissionId, rawBody);
    await deliverManaged(rawBody);
    return 'accepted';
  } catch {
    return 'rejected';
  }
}
