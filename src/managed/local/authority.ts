import { origin, reject, verifyHmac, bearer } from './protocol';

interface Projection {
  tenantId: string;
  applicationId: string;
  destinationId: string;
  installationId: string;
  configurationVersion: number;
  authorizationVersion: number;
  origin: string;
  keyId: string;
  verifier: string;
  credentialActive: boolean;
  applicationActive: boolean;
  installationActive: boolean;
  tenantActive: boolean;
  observedAt: number;
}
interface SigningKey {
  kid: string;
  publicKey: JsonWebKey;
  privateKey?: JsonWebKey;
  notBefore: number;
  verifyUntil: number;
}
export interface Authority {
  now: number;
  projection: Projection;
  pepper: string;
  receiptKey: string;
  signingKid: string;
  signingKeys: SigningKey[];
}
export async function loadAuthority(service: Fetcher): Promise<Authority> {
  const response = await service.fetch('http://authority.bugdrop.localhost/snapshot');
  if (!response.ok) return reject();
  // A private, harness-owned service binding supplies this operational config, never request fields.
  const authority = await response.json<Authority>();
  active(authority);
  return authority;
}
export function active({ now, projection: p }: Authority): void {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(p.observedAt) ||
    now < p.observedAt ||
    now - p.observedAt > 30_000 ||
    !p.credentialActive ||
    !p.applicationActive ||
    !p.installationActive ||
    !p.tenantActive
  )
    reject();
  origin(p.origin);
}
export async function authenticate(
  authorization: string | null,
  authority: Authority
): Promise<void> {
  const supplied = bearer(authorization);
  if (
    supplied.keyId !== authority.projection.keyId ||
    !(await verifyHmac(authority.pepper, supplied.authSecret, authority.projection.verifier))
  )
    reject();
}
