import { Buffer } from 'node:buffer';
import { bytes, hmac, json, record, reject, utf8, verifyHmac } from '../local/protocol';

export interface UninstallWork {
  eventHash: string;
  installationHash: string;
  occurredAt: number;
  requestId: string;
}
export interface SignedProof {
  raw: Uint8Array;
  signature: string;
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).sort().join('|') === fields.sort().join('|');
}
export async function commitments(key: string, appId: number, installationId: number) {
  if (
    !Number.isSafeInteger(appId) ||
    appId < 1 ||
    !Number.isSafeInteger(installationId) ||
    installationId < 1
  )
    reject();
  const scoped = JSON.stringify([appId, installationId]);
  const hash = async (domain: string) =>
    Buffer.from(bytes(await hmac(key, utf8(`${domain}\0${scoped}`)))).toString('hex');
  return {
    eventHash: await hash('bugdrop:uninstall:deleted:v1'),
    installationHash: await hash('bugdrop:uninstall:installation:v1'),
  };
}
export function work(value: unknown): UninstallWork {
  const item = record(value);
  if (
    !exact(item, ['eventHash', 'installationHash', 'occurredAt', 'requestId']) ||
    typeof item.eventHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(item.eventHash) ||
    typeof item.installationHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(item.installationHash) ||
    typeof item.occurredAt !== 'number' ||
    !Number.isSafeInteger(item.occurredAt) ||
    item.occurredAt <= 0 ||
    typeof item.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.requestId)
  )
    reject();
  return item as unknown as UninstallWork;
}
async function authenticated(proof: SignedProof, key: string, domain: string) {
  if (proof.raw.length > 2048) reject();
  const prefix = utf8(`${domain}\0`);
  const signed = new Uint8Array(prefix.length + proof.raw.length);
  signed.set(prefix);
  signed.set(proof.raw, prefix.length);
  if (!(await verifyHmac(key, signed, proof.signature))) reject();
  return record(json(proof.raw));
}
export async function edgeReceipt(
  proof: SignedProof,
  key: string,
  applicationId: string,
  installationId: string
): Promise<boolean> {
  try {
    const receipt = await authenticated(proof, key, 'bugdrop:uninstall:edge-receipt:v1');
    return (
      exact(receipt, ['schemaVersion', 'accepted', 'applicationId', 'installationId', 'revoked']) &&
      receipt.schemaVersion === 1 &&
      receipt.accepted === true &&
      receipt.revoked === true &&
      receipt.applicationId === applicationId &&
      receipt.installationId === installationId
    );
  } catch {
    return false;
  }
}
export async function sqlReceipt(
  proof: SignedProof,
  key: string,
  expected: UninstallWork,
  installationId: string
): Promise<'applied' | 'pending' | 'quarantined'> {
  try {
    const receipt = await authenticated(proof, key, 'bugdrop:uninstall:sql-receipt:v1');
    const fields = [
      'schemaVersion',
      'eventHash',
      'installationHash',
      'installationId',
      'occurredAt',
      'requestId',
    ];
    if (
      receipt.schemaVersion !== 1 ||
      receipt.installationId !== installationId ||
      Object.entries(expected).some(([name, value]) => receipt[name] !== value)
    )
      return 'pending';
    if (exact(receipt, [...fields, 'sqlApplied']) && receipt.sqlApplied === true) return 'applied';
    if (
      exact(receipt, [...fields, 'state', 'reason']) &&
      receipt.state === 'quarantined' &&
      receipt.reason === 'mapping_missing'
    )
      return 'quarantined';
    return 'pending';
  } catch {
    return 'pending';
  }
}
