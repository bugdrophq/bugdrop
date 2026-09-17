import { Buffer } from 'node:buffer';
import {
  bytes,
  hmac,
  json,
  keys,
  readBounded,
  record,
  reject,
  utf8,
  verifyHmac,
} from '../local/protocol';
import type { Update } from './projection';

export interface ControlSelector {
  schemaVersion: 1;
  applicationId: string;
  keyId: string;
  sequence: number;
  configurationVersion: number;
  authorizationVersion: number;
  projectionDigest: string;
}
export interface ControlReceipt extends ControlSelector {
  accepted: true;
}
const fields = [
  'schemaVersion',
  'applicationId',
  'keyId',
  'sequence',
  'configurationVersion',
  'authorizationVersion',
  'projectionDigest',
];
export const statusMessage = (raw: Uint8Array): Uint8Array =>
  Buffer.concat([utf8('bugdrop:staging:control-status:v1\n'), raw]);
const receiptMessage = (raw: Uint8Array): Uint8Array =>
  Buffer.concat([utf8('bugdrop:staging:control-receipt:v1\n'), raw]);
export async function projectionDigest(raw: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex');
}
export function selector(value: unknown, applicationId: string): ControlSelector {
  const input = record(value);
  keys(input, fields);
  if (
    input.schemaVersion !== 1 ||
    applicationId === 'UNAPPROVED' ||
    input.applicationId !== applicationId ||
    typeof input.applicationId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.applicationId)
  )
    reject();
  bytes(input.keyId, 16);
  for (const field of ['sequence', 'configurationVersion', 'authorizationVersion'])
    if (
      typeof input[field] !== 'number' ||
      !Number.isSafeInteger(input[field]) ||
      input[field] < (field === 'sequence' ? 1 : 0)
    )
      reject();
  if (typeof input.projectionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.projectionDigest))
    reject();
  return {
    schemaVersion: 1,
    applicationId: input.applicationId as string,
    keyId: input.keyId as string,
    sequence: input.sequence as number,
    configurationVersion: input.configurationVersion as number,
    authorizationVersion: input.authorizationVersion as number,
    projectionDigest: input.projectionDigest as string,
  };
}
export function controlReceipt(next: Update, digest: string): ControlReceipt {
  return {
    schemaVersion: 1,
    accepted: true,
    applicationId: next.projection.applicationId,
    keyId: next.projection.keyId,
    sequence: next.sequence,
    configurationVersion: next.projection.configurationVersion,
    authorizationVersion: next.projection.authorizationVersion,
    projectionDigest: digest,
  };
}
export function matches(receipt: ControlReceipt, expected: ControlSelector): boolean {
  return fields.every(
    field => receipt[field as keyof ControlSelector] === expected[field as keyof ControlSelector]
  );
}
export async function receiptResponse(receipt: ControlReceipt, key: string): Promise<Response> {
  const raw = JSON.stringify(receipt);
  return new Response(raw, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-BugDrop-Control-Receipt-Signature': await hmac(key, receiptMessage(utf8(raw))),
    },
  });
}
/** Private publisher helper: HTTP success alone is never an acknowledgement. */
export async function verifyReceipt(
  response: Response,
  key: string,
  expected: ControlSelector
): Promise<ControlReceipt> {
  if (response.status !== 200) reject();
  const raw = await readBounded(response, 2048);
  if (
    !(await verifyHmac(
      key,
      receiptMessage(raw),
      response.headers.get('X-BugDrop-Control-Receipt-Signature') ?? ''
    ))
  )
    reject();
  const value = record(json(raw));
  if (value.accepted !== true) reject();
  const { accepted: _, ...rest } = value;
  const parsed = { ...selector(rest, expected.applicationId), accepted: true as const };
  if (!matches(parsed, selector(expected, expected.applicationId))) reject();
  return parsed;
}
