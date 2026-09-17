import { Buffer } from 'node:buffer';

export function reject(): never {
  throw new Error('managed_request_rejected');
}

export function bytes(value: unknown, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return reject();
  const decoded = Buffer.from(value, 'base64url');
  if (
    (length !== undefined && decoded.length !== length) ||
    decoded.toString('base64url') !== value
  )
    return reject();
  return new Uint8Array(decoded);
}
export const encode = (value: Uint8Array | ArrayBuffer): string =>
  Buffer.from(new Uint8Array(value)).toString('base64url');
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export async function digest(value: Uint8Array): Promise<string> {
  return encode(await crypto.subtle.digest('SHA-256', value));
}
export async function hmac(key: string, value: Uint8Array): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    bytes(key, 32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return encode(await crypto.subtle.sign('HMAC', imported, value));
}
export async function verifyHmac(
  key: string,
  value: Uint8Array,
  expected: string
): Promise<boolean> {
  const imported = await crypto.subtle.importKey(
    'raw',
    bytes(key, 32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', imported, bytes(expected, 32), value);
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject();
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) reject();
}
export function origin(value: unknown): string {
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
    reject();
  return value;
}
export interface Binding {
  submissionId: string;
  payloadDigest: string;
}
export function binding(value: Record<string, unknown>): Binding {
  const id = value.submissionId;
  if (
    typeof id !== 'string' ||
    utf8(id).length < 1 ||
    utf8(id).length > 200 ||
    new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(utf8(id)) !== id
  )
    return reject();
  bytes(value.payloadDigest, 32);
  return { submissionId: id, payloadDigest: value.payloadDigest as string };
}
export function bearer(value: string | null): { keyId: string; authSecret: Uint8Array } {
  const match = /^Bearer bd_auth_v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value ?? '');
  if (!match || match[0] !== value) return reject();
  bytes(match[1], 16);
  return { keyId: match[1], authSecret: bytes(match[2], 32) };
}
export async function derive(apiKey: string): Promise<{ keyId: string; authorization: string }> {
  const match = /^bd_api_v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(apiKey);
  if (!match || match[0] !== apiKey) return reject();
  bytes(match[1], 16);
  bytes(match[2], 32);
  const secret = await hmac(match[2], utf8(`bugdrop:auth:v1\0${match[1]}`));
  return { keyId: match[1], authorization: `Bearer bd_auth_v1.${match[1]}.${secret}` };
}
export function exchange(headers: Headers, value: unknown, configuredOrigin: string): Binding {
  if (
    headers.get('Content-Type') !== 'application/json' ||
    headers.get('Accept') !== 'application/vnd.bugdrop.submission-capability.v1+json' ||
    headers.get('X-BugDrop-Contract-Version') !== '1'
  )
    reject();
  // Only the merged SDK version is emitted as evidence; arbitrary strings are never retained.
  if (headers.get('X-BugDrop-SDK-Version') !== '0.1.0') reject();
  const body = record(value);
  keys(body, ['schemaVersion', 'submissionId', 'payloadDigest', 'origin', 'environment']);
  if (body.schemaVersion !== 1) reject();
  const exact = origin(configuredOrigin);
  if (body.origin !== undefined && origin(body.origin) !== exact) reject();
  if (
    body.environment !== undefined &&
    (typeof body.environment !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(body.environment))
  )
    reject();
  return binding(body);
}
export async function readBounded(
  request: Pick<Request, 'body'>,
  max = 64 * 1024
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) {
        await reader.cancel();
        return reject();
      }
      parts.push(chunk.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}
export function json(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return reject();
  }
}
