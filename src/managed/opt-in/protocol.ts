import type { OriginalScope, RegisteredKey, Catalog } from './verifier';
export type { OriginalScope, RegisteredKey, Catalog } from './verifier';
import { binding, bytes, encode, utf8 } from '../local/protocol';
export { bytes, encode, utf8 };
export const retentionMs = 720 * 60 * 60 * 1000;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const version = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export type Failure =
  | 'invalid_request'
  | 'authentication_failed'
  | 'scope_rejected'
  | 'binding_conflict'
  | 'attempt_already_seen'
  | 'catalog_mismatch'
  | 'attempt_expired'
  | 'temporarily_unavailable';
export class Rejection extends Error {
  constructor(public readonly category: Failure) {
    super(category);
  }
}
export function fail(category: Failure = 'temporarily_unavailable'): never {
  throw new Rejection(category);
}
export interface Versions {
  sdkVersion: string | null;
  browserSdkVersion: string | null;
  widgetVersion: null;
  protocolVersion: 2;
}
export interface Intent {
  attemptId: string;
  issuedAt: number;
  expiresAt: number;
  submissionId: string;
  payloadDigest: string;
  applicationId: string;
  credentialId: string;
  keyId: string;
  installationGeneration: string;
  endpoint: string;
  deploymentDigest: string;
  catalogDigest: string;
  origin: string;
  serverSdkVersion: string;
  browserSdkVersion: string;
  normalizedVersions: Versions;
}
/** Private in-process dependency. Only an authenticated, separately qualified publisher may supply this.
 * No V1 projection, client field, environment fallback, or provider lookup constructs it. */
export interface AuthoritySnapshot {
  publicationId: string;
  lifecycleVersion: number;
  observedAt: number;
  active: boolean;
  protocolMode: 2;
  scope: OriginalScope;
  catalog: Catalog;
  catalogDigest: string;
  capabilityKid: string;
  confirmationKid: string;
  keys: RegisteredKey[];
  v1PublicKeys: JsonWebKey[];
  // The provisioning owner must verify the V2 domain-separated peppered verifier in constant time.
  authenticate: (secret: Uint8Array) => Promise<boolean>;
}
export type CurrentAuthority = () => AuthoritySnapshot | undefined;
export interface Capability {
  schemaVersion: 1;
  token: string;
  expiresAt: string;
}
export interface Confirmation {
  schemaVersion: 2;
  kid: string;
  intentDigest: string;
  capabilityDigest: string;
  reservedAt: number;
  retentionDeadline: number;
  admittedAt: number;
  expiresAt: number;
  signature: string;
}
const intentFields = [
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
] as const;
const versionFields = [
  'sdkVersion',
  'browserSdkVersion',
  'widgetVersion',
  'protocolVersion',
] as const;
export function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    !names.every(k => Object.hasOwn(value, k))
  )
    fail('invalid_request');
  return value as Record<string, unknown>;
}
/** Reject lexical ambiguity before materialization; final JSON.parse enforces the complete grammar. */
export function strictJson(raw: Uint8Array, maximum = 32768): unknown {
  if (raw.length > maximum) fail('invalid_request');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  const tokens =
    text.match(
      /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}[\]:,]|true|false|null/g
    ) ?? [];
  const stack: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{' || t === '[') {
      stack.push(new Set());
      if (stack.length > 4) fail('invalid_request');
    } else if (t === '}' || t === ']') stack.pop();
    else if (t.startsWith('"')) {
      const s: string = JSON.parse(t);
      if (/[\uD800-\uDFFF]/u.test(s)) fail('invalid_request');
      if (tokens[i + 1] === ':') {
        const keys = stack[stack.length - 1];
        if (!keys || keys.has(s)) fail('invalid_request');
        keys.add(s);
      }
    } else if (/^-?[0-9]/.test(t) && !/^(0|[1-9][0-9]*)$/.test(t)) fail('invalid_request');
  }
  return JSON.parse(text);
}
export async function hex(domain: string, value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(domain + value)))]
    .map(n => n.toString(16).padStart(2, '0'))
    .join('');
}
export const intentDigest = (i: Intent) =>
  hex(
    'bugdrop:metadata-intent:v2\0',
    JSON.stringify(
      intentFields.map(k =>
        k === 'normalizedVersions' ? versionFields.map(v => i.normalizedVersions[v]) : i[k]
      )
    )
  );
export const capabilityDigest = (c: Capability) =>
  hex('bugdrop:capability-envelope:v2\0', JSON.stringify([1, c.token, c.expiresAt]));
export const confirmationBytes = (c: Omit<Confirmation, 'signature'>) =>
  utf8(
    'bugdrop:metadata-confirmation:v2\0' +
      JSON.stringify([
        2,
        c.kid,
        c.intentDigest,
        c.capabilityDigest,
        c.reservedAt,
        c.retentionDeadline,
        c.admittedAt,
        c.expiresAt,
      ])
  );
export function https(value: string, endpoint = false): boolean {
  const u = new URL(value);
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    !u.hostname.endsWith('.') &&
    !u.hostname.endsWith('.localhost') &&
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
    value === u.origin + (endpoint ? '/v2/submission-capabilities' : '')
  );
}
export function parseIntent(raw: Uint8Array, serverVersion: string): Intent {
  try {
    const outer = exact(strictJson(raw), ['schemaVersion', 'intent']);
    const i = exact(outer.intent, intentFields);
    const n = exact(i.normalizedVersions, versionFields);
    if (
      outer.schemaVersion !== 2 ||
      intentFields
        .filter(k => !['issuedAt', 'expiresAt', 'normalizedVersions'].includes(k))
        .some(k => typeof i[k] !== 'string') ||
      !['attemptId', 'credentialId', 'installationGeneration'].every(k =>
        uuid.test(String(i[k]))
      ) ||
      !/^app_[A-Za-z0-9_-]{1,196}$/.test(String(i.applicationId)) ||
      !['deploymentDigest', 'catalogDigest'].every(k => /^[0-9a-f]{64}$/.test(String(i[k]))) ||
      !version.test(String(i.serverSdkVersion)) ||
      !version.test(String(i.browserSdkVersion)) ||
      i.serverSdkVersion !== serverVersion ||
      !Number.isSafeInteger(i.issuedAt) ||
      !Number.isSafeInteger(i.expiresAt) ||
      Number(i.issuedAt) < 0 ||
      i.expiresAt !== Number(i.issuedAt) + 60000 ||
      !https(String(i.endpoint), true) ||
      !https(String(i.origin)) ||
      n.widgetVersion !== null ||
      n.protocolVersion !== 2 ||
      ['sdkVersion', 'browserSdkVersion'].some(
        k => n[k] !== null && (typeof n[k] !== 'string' || !version.test(n[k] as string))
      )
    )
      fail('invalid_request');
    bytes(i.keyId, 16);
    binding(i);
    return i as unknown as Intent;
  } catch {
    return fail('invalid_request');
  }
}
export function checkTime(i: Intent, now: number): void {
  if (!Number.isSafeInteger(now) || now < i.issuedAt - 5000 || now >= i.expiresAt)
    fail('attempt_expired');
}
export async function validateCatalog(i: Intent, a: AuthoritySnapshot): Promise<void> {
  const c = a.catalog;
  exact(c, ['schemaVersion', 'normalizationVersion', 'server', 'browser', 'widget']);
  if (
    c.schemaVersion !== 1 ||
    c.normalizationVersion !== 1 ||
    !Array.isArray(c.widget) ||
    c.widget.length !== 0 ||
    [c.server, c.browser].some(
      list =>
        !Array.isArray(list) ||
        list.length > 128 ||
        list.some(
          (s, j) => typeof s !== 'string' || !version.test(s) || (j > 0 && list[j - 1] >= s)
        )
    )
  )
    fail('catalog_mismatch');
  const digest = await hex(
    'bugdrop:version-catalog:v1\0',
    JSON.stringify([1, 1, c.server, c.browser, c.widget])
  );
  if (digest !== a.catalogDigest || i.catalogDigest !== digest) fail('catalog_mismatch');
  if (
    i.normalizedVersions.sdkVersion !==
      (c.server.includes(i.serverSdkVersion) ? i.serverSdkVersion : null) ||
    i.normalizedVersions.browserSdkVersion !==
      (c.browser.includes(i.browserSdkVersion) ? i.browserSdkVersion : null)
  )
    fail('binding_conflict');
  const s = a.scope;
  if (
    i.applicationId !== s.publicApplicationId ||
    i.credentialId !== s.credentialId ||
    i.installationGeneration !== s.installationGeneration ||
    i.keyId !== s.keyId ||
    i.endpoint !== s.endpoint ||
    i.origin !== s.origin ||
    i.deploymentDigest !== s.deploymentDigest
  )
    fail('scope_rejected');
}
