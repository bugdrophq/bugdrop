import { Buffer } from 'node:buffer';
import { encode, json, record, verifyHmac } from './protocol';

/** Local GitHub fixture authority: verify exact webhook bytes before applying deletion. */
export async function authorizedUninstall(
  raw: Uint8Array,
  signature: string,
  event: string,
  installationId: string,
  secret: string
): Promise<boolean> {
  try {
    if (event !== 'installation' || raw.length > 65536 || !/^sha256=[0-9a-f]{64}$/.test(signature))
      return false;
    const supplied = encode(new Uint8Array(Buffer.from(signature.slice(7), 'hex')));
    if (!(await verifyHmac(secret, raw, supplied))) return false;
    const body = record(json(raw));
    const installation = record(body.installation);
    return (
      body.action === 'deleted' &&
      Number.isSafeInteger(installation.id) &&
      String(installation.id) === installationId
    );
  } catch {
    return false;
  }
}
