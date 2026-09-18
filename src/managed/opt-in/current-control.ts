import { utf8 } from './protocol';

export type Operation =
  'publication.accept' | 'alias.export' | 'server-config.export' | 'outcome.execute';
export type Direction = 'request' | 'receipt';
export interface ControlEnvelope {
  raw: Uint8Array;
  keyId: string;
  mac: string;
}
export const fields = {
  // prettier-ignore
  scope: ['tenantId', 'applicationId', 'destinationId', 'credentialId',
    'installationGeneration', 'providerInstallationId', 'githubAppId',
    'publicApplicationId', 'keyId', 'endpoint', 'origin', 'deploymentDigest'],
  // prettier-ignore
  publication: ['schemaVersion', 'realm', 'sourceId', 'sourceEpoch',
    'publicationId', 'sequence', 'lifecycleVersion', 'observedAt', 'protocolMode',
    'active', 'scope', 'credentialVerifierRef', 'catalogDigest', 'catalog',
    'capabilityKid', 'confirmationKid', 'keys', 'v1PublicKeys'],
  catalog: ['schemaVersion', 'normalizationVersion', 'server', 'browser', 'widget'],
  key: ['kid', 'purpose', 'publicKey', 'notBefore', 'verifyUntil'],
  jwk: ['kty', 'crv', 'x', 'y'],
  // prettier-ignore
  receipt: ['schemaVersion', 'accepted', 'sourceEpoch', 'applicationId', 'keyId',
    'publicationId', 'sequence', 'lifecycleVersion', 'publicationDigest'],
  // prettier-ignore
  alias: ['schemaVersion', 'realm', 'sourceEpoch', 'publicationId', 'sequence',
    'publicationDigest', 'publicApplicationId', 'applicationId',
    'installationGeneration', 'credentialId', 'keyId', 'endpoint',
    'deploymentDigest', 'observedAt'],
  server: [
    'schemaVersion',
    'realm',
    'sourceEpoch',
    'publicationId',
    'sequence',
    'publicationDigest',
    'observedAt',
    'options',
  ],
  options: [
    'endpoint',
    'origin',
    'applicationId',
    'credentialId',
    'keyId',
    'installationGeneration',
    'deploymentDigest',
    'catalogDigest',
    'catalog',
    'confirmationKeys',
  ],
} satisfies Record<string, string[]>;
const domains: Record<Operation, string> = {
  'publication.accept': 'bugdrop:authority-publication:v2',
  'alias.export': 'bugdrop:authority-alias:v2',
  'server-config.export': 'bugdrop:authority-server-config:v2',
  'outcome.execute': 'bugdrop:authority-outcome:v2',
};
export function unavailable(): never {
  throw new Error('current_authority_unavailable');
}
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function ordered(value: unknown, names: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value), names)
  )
    unavailable();
  return value as Record<string, unknown>;
}

/** Exact UTF-8 JSON.stringify bytes, including duplicate-key and numeric spelling rejection. */
export function parseCanonical(raw: Uint8Array, names: string[]): Record<string, unknown> {
  if (raw.length > 65_536) unavailable();
  const value = ordered(
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)),
    names
  );
  const safeStrings = (part: unknown, depth: number): void => {
    if (depth > 8) unavailable();
    if (typeof part === 'string') {
      if (/[\uD800-\uDFFF]/u.test(part)) unavailable();
    } else if (Array.isArray(part)) {
      for (const item of part) safeStrings(item, depth + 1);
    } else if (part && typeof part === 'object') {
      for (const [key, item] of Object.entries(part)) {
        safeStrings(key, depth + 1);
        safeStrings(item, depth + 1);
      }
    }
  };
  safeStrings(value, 0);
  const canonical = utf8(JSON.stringify(value));
  if (raw.length !== canonical.length || raw.some((byte, index) => byte !== canonical[index]))
    unavailable();
  return value;
}
function encodedMac(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) unavailable();
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), c =>
    c.charCodeAt(0)
  );
  if (decoded.length !== 32) unavailable();
  return decoded;
}
export async function controlMac(
  operation: Operation,
  direction: Direction,
  key: Uint8Array,
  raw: Uint8Array
): Promise<Uint8Array> {
  if (key.length !== 32) unavailable();
  const prefix = utf8(
    `${domains[operation]}${direction === 'receipt' ? '-receipt' : ''}\0${operation}${direction === 'receipt' ? '.receipt' : ''}\0`
  );
  const input = new Uint8Array(prefix.length + raw.length);
  input.set(prefix);
  input.set(raw, prefix.length);
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, input));
}
export async function verifyControlMac(
  operation: Operation,
  direction: Direction,
  key: Uint8Array,
  envelope: ControlEnvelope
): Promise<void> {
  const max = operation === 'outcome.execute' ? (direction === 'receipt' ? 256 : 2048) : 65_536;
  if (
    !envelope ||
    !same(Object.keys(envelope).sort(), ['keyId', 'mac', 'raw']) ||
    !(envelope.raw instanceof Uint8Array) ||
    envelope.raw.length > max
  )
    unavailable();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(envelope.keyId)) unavailable();
  const expected = await controlMac(operation, direction, key, envelope.raw);
  const actual = encodedMac(envelope.mac);
  let different = 0;
  for (let i = 0; i < 32; i++) different |= expected[i] ^ actual[i];
  if (different) unavailable();
}
export async function digest(raw: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function expectedExports(
  p: Record<string, unknown>,
  publicationDigest: string
): {
  alias: object;
  server: object;
} {
  const scope = ordered(p.scope, fields.scope);
  const selected = (p.keys as Record<string, unknown>[]).filter(k => k.kid === p.confirmationKid);
  if (selected.length !== 1) unavailable();
  return {
    alias: {
      schemaVersion: 2,
      realm: p.realm,
      sourceEpoch: p.sourceEpoch,
      publicationId: p.publicationId,
      sequence: p.sequence,
      publicationDigest,
      publicApplicationId: scope.publicApplicationId,
      applicationId: scope.applicationId,
      installationGeneration: scope.installationGeneration,
      credentialId: scope.credentialId,
      keyId: scope.keyId,
      endpoint: scope.endpoint,
      deploymentDigest: scope.deploymentDigest,
      observedAt: p.observedAt,
    },
    server: {
      schemaVersion: 2,
      realm: p.realm,
      sourceEpoch: p.sourceEpoch,
      publicationId: p.publicationId,
      sequence: p.sequence,
      publicationDigest,
      observedAt: p.observedAt,
      options: {
        endpoint: scope.endpoint,
        origin: scope.origin,
        applicationId: scope.publicApplicationId,
        credentialId: scope.credentialId,
        keyId: scope.keyId,
        installationGeneration: scope.installationGeneration,
        deploymentDigest: scope.deploymentDigest,
        catalogDigest: p.catalogDigest,
        catalog: p.catalog,
        confirmationKeys: [{ kid: p.confirmationKid, publicKey: selected[0].publicKey }],
      },
    },
  };
}
