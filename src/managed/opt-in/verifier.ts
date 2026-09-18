import { digest } from '../local/protocol';
import { AdmissionStore } from './admission-store';
import {
  bytes,
  checkTime,
  https,
  type Intent,
  capabilityDigest,
  exact,
  fail,
  strictJson,
  utf8,
  uuid,
  type AuthoritySnapshot,
  type Capability,
  type CurrentAuthority,
} from './protocol';
interface V2Claims {
  protocolVersion: 2;
  iss: 'bugdrop-managed-staging-v2';
  aud: 'bugdrop-managed-staging-ingress-v2';
  publicApplicationId: string;
  jti: string;
  iat: number;
  exp: number;
}
/** Authenticate the fixed staging mode and public alias before any handle lookup. No V1 fallback. */
export async function authenticateToken(
  capability: Capability,
  a: AuthoritySnapshot,
  now: number
): Promise<V2Claims> {
  exact(capability, ['schemaVersion', 'token', 'expiresAt']);
  if (
    capability.schemaVersion !== 1 ||
    typeof capability.token !== 'string' ||
    utf8(capability.token).length > 8192
  )
    fail('scope_rejected');
  const parts = capability.token.split('.');
  if (parts.length !== 3) fail('scope_rejected');
  const header = exact(strictJson(bytes(parts[0]), 8192), ['alg', 'kid', 'typ']);
  if (
    header.alg !== 'ES256' ||
    header.typ !== 'bugdrop-managed-capability-v2' ||
    typeof header.kid !== 'string'
  )
    fail('scope_rejected');
  const k = registered(a, header.kid, 'capability-v2', now);
  const key = await crypto.subtle.importKey(
    'jwk',
    k.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(parts[2], 64),
      utf8(parts[0] + '.' + parts[1])
    ))
  )
    fail('scope_rejected');
  const c = exact(strictJson(bytes(parts[1]), 8192), [
    'protocolVersion',
    'iss',
    'aud',
    'publicApplicationId',
    'jti',
    'iat',
    'exp',
  ]);
  if (
    c.protocolVersion !== 2 ||
    c.iss !== 'bugdrop-managed-staging-v2' ||
    c.aud !== 'bugdrop-managed-staging-ingress-v2' ||
    c.publicApplicationId !== a.scope.publicApplicationId ||
    typeof c.jti !== 'string' ||
    !uuid.test(c.jti) ||
    typeof c.iat !== 'number' ||
    !Number.isSafeInteger(c.iat) ||
    c.iat < 0 ||
    typeof c.exp !== 'number' ||
    !Number.isSafeInteger(c.exp) ||
    c.exp - c.iat !== 300 ||
    c.iat * 1000 > now ||
    c.exp * 1000 <= now ||
    c.exp * 1000 > k.verifyUntil ||
    capability.expiresAt !== new Date(c.exp * 1000).toISOString()
  )
    fail('scope_rejected');
  return c as unknown as V2Claims;
}
interface SubmissionBinding {
  submissionId: string;
  payloadDigest: string;
  origin: string;
}
export async function verifySubmission(
  capability: Capability,
  binding: SubmissionBinding,
  raw: Uint8Array,
  store: AdmissionStore,
  source: CurrentAuthority,
  now = () => Date.now()
) {
  store.assertUnrevoked();
  const original = current(source, now());
  const originalIdentity = identity(original);
  const claims = await authenticateToken(capability, original, now());
  recheck(source, originalIdentity, now());
  const commitment = await capabilityDigest(capability);
  recheck(source, originalIdentity, now());
  const payloadDigest = await digest(raw);
  recheck(source, originalIdentity, now());
  await store.storage.sync();
  const a = recheck(source, originalIdentity, now());
  store.assertUnrevoked();
  const row = store.read(claims.jti);
  if (
    !row ||
    row.state !== 'admitted' ||
    row.authorityIdentity !== originalIdentity ||
    row.capabilityDigest !== commitment ||
    row.capabilityExpiresAt !== claims.exp * 1000 ||
    row.intent.submissionId !== binding.submissionId ||
    row.intent.payloadDigest !== binding.payloadDigest ||
    payloadDigest !== binding.payloadDigest ||
    row.scope.origin !== binding.origin ||
    row.scope.publicApplicationId !== claims.publicApplicationId ||
    scopeIdentity(row.scope) !== scopeIdentity(a.scope) ||
    claims.iat * 1000 > now() ||
    claims.exp * 1000 <= now()
  )
    fail('scope_rejected');
  // Private original metadata only; every later external attempt must call this gate afresh.
  return {
    handle: row.handle,
    scope: structuredClone(row.scope),
    normalizedVersions: structuredClone(row.intent.normalizedVersions),
  };
}

const material = (j: JsonWebKey) => JSON.stringify([j.kty, j.crv, j.x, j.y]);
export function registered(
  a: AuthoritySnapshot,
  kid: string,
  purpose: RegisteredKey['purpose'],
  now: number
): RegisteredKey {
  const found = a.keys.filter(k => k.kid === kid);
  if (found.length !== 1) fail('scope_rejected');
  const k = found[0];
  if (
    k.purpose !== purpose ||
    !Number.isSafeInteger(k.notBefore) ||
    !Number.isSafeInteger(k.verifyUntil) ||
    now < k.notBefore ||
    now >= k.verifyUntil ||
    k.publicKey.kty !== 'EC' ||
    k.publicKey.crv !== 'P-256' ||
    k.publicKey.d !== undefined ||
    !(purpose === 'capability-v2' ? /^cap-v2-[A-Za-z0-9_-]{1,57}$/ : /^[A-Za-z0-9_-]{1,64}$/).test(
      k.kid
    ) ||
    a.v1PublicKeys.some(j => material(j) === material(k.publicKey)) ||
    a.keys.some(
      other =>
        other !== k && (other.kid === k.kid || material(other.publicKey) === material(k.publicKey))
    )
  )
    fail('scope_rejected');
  bytes(k.publicKey.x, 32);
  bytes(k.publicKey.y, 32);
  return k;
}
export function current(source: CurrentAuthority, now: number): AuthoritySnapshot {
  const a = source();
  if (
    !a ||
    a.protocolMode !== 2 ||
    !a.active ||
    !a.publicationId ||
    !Number.isSafeInteger(a.lifecycleVersion) ||
    a.lifecycleVersion < 0 ||
    !Number.isSafeInteger(a.observedAt) ||
    now < a.observedAt ||
    now - a.observedAt > 30000 ||
    a.keys.length > 128
  )
    fail();
  for (const k of [
    'tenantId',
    'applicationId',
    'destinationId',
    'credentialId',
    'installationGeneration',
  ] as const)
    if (!uuid.test(a.scope[k])) fail();
  if (
    !/^app_[A-Za-z0-9_-]{1,196}$/.test(a.scope.publicApplicationId) ||
    !/^[1-9][0-9]*$/.test(a.scope.providerInstallationId) ||
    !/^[1-9][0-9]*$/.test(a.scope.githubAppId) ||
    !https(a.scope.endpoint, true) ||
    !https(a.scope.origin) ||
    !/^[0-9a-f]{64}$/.test(a.scope.deploymentDigest)
  )
    fail();
  bytes(a.scope.keyId, 16);
  return a;
}
export function scopeIdentity(scope: OriginalScope): string {
  return JSON.stringify(
    Object.keys(scope)
      .sort()
      .map(k => [k, scope[k as keyof OriginalScope]])
  );
}
/** Excludes freshness clock and secret/key handles; retained original identity never follows rotations. */
export function identity(a: AuthoritySnapshot): string {
  return JSON.stringify([
    a.publicationId,
    a.lifecycleVersion,
    scopeIdentity(a.scope),
    a.catalogDigest,
    a.capabilityKid,
    a.confirmationKid,
    a.keys.map(k => [k.kid, k.purpose, material(k.publicKey), k.notBefore, k.verifyUntil]).sort(),
  ]);
}
export function recheck(
  source: CurrentAuthority,
  original: string,
  now: number,
  i?: Intent
): AuthoritySnapshot {
  const a = current(source, now);
  if (identity(a) !== original) fail('scope_rejected');
  if (i) checkTime(i, now);
  return a;
}

export interface OriginalScope {
  tenantId: string;
  applicationId: string;
  destinationId: string;
  credentialId: string;
  installationGeneration: string;
  providerInstallationId: string;
  githubAppId: string;
  publicApplicationId: string;
  keyId: string;
  endpoint: string;
  origin: string;
  deploymentDigest: string;
}
export interface RegisteredKey {
  kid: string;
  purpose: 'capability-v2' | 'confirmation-v2';
  publicKey: JsonWebKey;
  signingKey?: CryptoKey;
  notBefore: number;
  verifyUntil: number;
}
export interface Catalog {
  schemaVersion: 1;
  normalizationVersion: 1;
  server: string[];
  browser: string[];
  widget: string[];
}
