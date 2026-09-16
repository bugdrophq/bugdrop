import { type Authority, active } from './authority';
import {
  type Binding,
  binding,
  bytes,
  digest,
  encode,
  json,
  keys,
  origin,
  record,
  reject,
  utf8,
} from './protocol';

interface Claims extends Binding {
  iss: string;
  aud: string;
  tenantId: string;
  applicationId: string;
  destinationId: string;
  installationId: string;
  configurationVersion: number;
  authorizationVersion: number;
  credentialId: string;
  origin: string;
  iat: number;
  exp: number;
  jti: string;
}
const authorityFields = (a: Authority) => ({
  iss: 'bugdrop-managed-local',
  aud: 'bugdrop-managed-local-ingress',
  tenantId: a.projection.tenantId,
  applicationId: a.projection.applicationId,
  destinationId: a.projection.destinationId,
  installationId: a.projection.installationId,
  configurationVersion: a.projection.configurationVersion,
  authorizationVersion: a.projection.authorizationVersion,
  credentialId: a.projection.keyId,
  origin: a.projection.origin,
});
export async function issue(bound: Binding, a: Authority) {
  active(a);
  const key = a.signingKeys.find(key => key.kid === a.signingKid);
  const iat = Math.floor(a.now / 1000);
  const exp = iat + 300;
  if (!key?.privateKey || a.now < key.notBefore || exp * 1000 > key.verifyUntil) return reject();
  const claims: Claims = { ...authorityFields(a), ...bound, iat, exp, jti: crypto.randomUUID() };
  const header = encode(
    utf8(JSON.stringify({ alg: 'ES256', kid: key.kid, typ: 'bugdrop-local-capability-v1' }))
  );
  const payload = encode(utf8(JSON.stringify(claims)));
  const imported = await crypto.subtle.importKey(
    'jwk',
    key.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    imported,
    utf8(`${header}.${payload}`)
  );
  return {
    schemaVersion: 1 as const,
    token: `${header}.${payload}.${encode(signature)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
export async function verify(token: unknown, a: Authority): Promise<Claims> {
  active(a);
  if (typeof token !== 'string' || token.length > 8192) return reject();
  const segments = token.split('.');
  if (segments.length !== 3) return reject();
  const header = record(json(bytes(segments[0])));
  keys(header, ['alg', 'kid', 'typ']);
  if (header.alg !== 'ES256' || header.typ !== 'bugdrop-local-capability-v1') return reject();
  const key = a.signingKeys.find(key => key.kid === header.kid);
  if (!key || a.now < key.notBefore || a.now >= key.verifyUntil) return reject();
  const imported = await crypto.subtle.importKey(
    'jwk',
    key.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      imported,
      bytes(segments[2], 64),
      utf8(`${segments[0]}.${segments[1]}`)
    ))
  )
    return reject();
  const claims = record(json(bytes(segments[1])));
  const required = authorityFields(a);
  keys(claims, [...Object.keys(required), 'submissionId', 'payloadDigest', 'iat', 'exp', 'jti']);
  for (const [key, value] of Object.entries(required)) if (claims[key] !== value) reject();
  binding(claims);
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    claims.iat * 1000 > a.now ||
    claims.exp * 1000 <= a.now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 300 ||
    claims.exp * 1000 > key.verifyUntil ||
    typeof claims.jti !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(claims.jti)
  )
    reject();
  return { ...required, ...binding(claims), iat: claims.iat, exp: claims.exp, jti: claims.jti };
}
export async function verifySubmission(
  token: unknown,
  suppliedOrigin: unknown,
  bound: Binding,
  raw: Uint8Array,
  authority: Authority
): Promise<Claims> {
  const claims = await verify(token, authority);
  if (
    origin(suppliedOrigin) !== claims.origin ||
    bound.submissionId !== claims.submissionId ||
    bound.payloadDigest !== claims.payloadDigest ||
    (await digest(raw)) !== claims.payloadDigest
  )
    reject();
  return claims;
}
// Envelope conformance only; ingress signed-token expiry above deliberately has no clock-skew grace.
export function validEnvelope(value: unknown, now: number): boolean {
  try {
    const r = record(value);
    keys(r, ['schemaVersion', 'token', 'expiresAt']);
    if (
      r.schemaVersion !== 1 ||
      typeof r.token !== 'string' ||
      !r.token ||
      typeof r.expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.expiresAt)
    )
      return false;
    const expiry = Date.parse(r.expiresAt);
    return (
      Number.isFinite(expiry) &&
      new Date(expiry).toISOString() === r.expiresAt &&
      expiry > now - 30_000 &&
      expiry <= now + 330_000
    );
  } catch {
    return false;
  }
}
