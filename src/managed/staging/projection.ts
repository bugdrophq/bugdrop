import type { Authority } from '../local/authority';
import { bytes, keys, origin, record, reject } from '../local/protocol';

type Projection = Omit<Authority['projection'], 'verifier'>;
export interface Update {
  schemaVersion: 1;
  sequence: number;
  projection: Projection;
}
const ids = ['tenantId', 'applicationId', 'destinationId', 'installationId', 'keyId'] as const;
const versions = ['configurationVersion', 'authorizationVersion', 'observedAt'] as const;
const states = [
  'credentialActive',
  'applicationActive',
  'installationActive',
  'tenantActive',
] as const;
export function update(
  value: unknown,
  applicationId: string,
  installationId: string,
  now: number
): Update {
  const input = record(value);
  keys(input, ['schemaVersion', 'sequence', 'projection']);
  if (
    input.schemaVersion !== 1 ||
    typeof input.sequence !== 'number' ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1
  )
    reject();
  const p = record(input.projection);
  keys(p, [...ids, ...versions, ...states, 'origin']);
  for (const field of ids)
    if (typeof p[field] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p[field])) reject();
  for (const field of versions)
    if (typeof p[field] !== 'number' || !Number.isSafeInteger(p[field]) || p[field] < 0) reject();
  for (const field of states) if (typeof p[field] !== 'boolean') reject();
  if (
    applicationId === 'UNAPPROVED' ||
    installationId === 'UNAPPROVED' ||
    p.applicationId !== applicationId ||
    p.installationId !== installationId
  )
    reject();
  if (now < Number(p.observedAt) || now - Number(p.observedAt) > 30_000) reject();
  origin(p.origin);
  bytes(p.keyId, 16);
  // Every field has been validated above; no arbitrary control-plane properties persist.
  return {
    schemaVersion: 1,
    sequence: input.sequence as number,
    projection: {
      tenantId: p.tenantId as string,
      applicationId: p.applicationId as string,
      destinationId: p.destinationId as string,
      installationId: p.installationId as string,
      keyId: p.keyId as string,
      origin: origin(p.origin),
      configurationVersion: p.configurationVersion as number,
      authorizationVersion: p.authorizationVersion as number,
      observedAt: p.observedAt as number,
      credentialActive: p.credentialActive as boolean,
      applicationActive: p.applicationActive as boolean,
      installationActive: p.installationActive as boolean,
      tenantActive: p.tenantActive as boolean,
    },
  };
}
