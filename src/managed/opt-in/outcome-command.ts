import { strictJson, retentionMs, uuid, utf8 } from './protocol';

const states = [
  'authorized',
  'delivering',
  'delivered',
  'failed_before_delivery',
  'indeterminate',
] as const;
const reasons = [
  'none',
  'github_rate_limited',
  'github_unavailable',
  'permission_denied',
  'repository_unavailable',
  'issues_disabled',
  'credential_rejected',
  'attachment_processing_failed',
  'origin_rejected',
  'internal_error',
  'unknown',
] as const;
const version = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export const outcomeHash = /^[0-9a-f]{64}$/;
const outcomeBodyLimit = 2048;
export interface OutcomeCommand {
  schemaVersion: 2;
  command: 'ingest_outcome_v2';
  arguments: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    (typeof states)[number],
    (typeof reasons)[number],
    boolean,
    string,
    string | null,
    string | null,
    string | null,
    1 | 2 | null,
  ];
}
export function outcomeReject(): never {
  throw new Error('outcome_unavailable');
}
export function outcomeObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    outcomeReject();
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string') outcomeReject();
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value)
    outcomeReject();
  return time;
}
/** Validates only typed transport shape; the qualified original producer owns provenance. */
export function outcomeCommand(value: unknown): OutcomeCommand {
  const object = outcomeObject(value, ['schemaVersion', 'command', 'arguments']);
  const a = object.arguments;
  if (
    object.schemaVersion !== 2 ||
    object.command !== 'ingest_outcome_v2' ||
    !Array.isArray(a) ||
    a.length !== 17 ||
    Object.keys(a).length !== 17
  )
    outcomeReject();
  for (const i of [0, 1, 2, 3, 4, 12])
    if (typeof a[i] !== 'string' || !uuid.test(a[i])) outcomeReject();
  for (const i of [5, 6]) if (typeof a[i] !== 'string' || !outcomeHash.test(a[i])) outcomeReject();
  if (
    timestamp(a[8]) < timestamp(a[7]) ||
    !states.includes(a[9]) ||
    !reasons.includes(a[10]) ||
    typeof a[11] !== 'boolean' ||
    ['authorized', 'delivering', 'delivered'].includes(a[9]) !== (a[10] === 'none')
  )
    outcomeReject();
  for (const i of [13, 14, 15])
    if (a[i] !== null && (typeof a[i] !== 'string' || !version.test(a[i]))) outcomeReject();
  if (a[16] !== null && a[16] !== 1 && a[16] !== 2) outcomeReject();
  return {
    schemaVersion: 2,
    command: 'ingest_outcome_v2',
    arguments: [...a] as OutcomeCommand['arguments'],
  };
}
export function decodeOutcome(raw: Uint8Array): OutcomeCommand {
  return outcomeCommand(strictJson(raw, outcomeBodyLimit));
}
export function encodeOutcome(command: OutcomeCommand): Uint8Array {
  const raw = utf8(JSON.stringify(outcomeCommand(command)));
  if (raw.length > outcomeBodyLimit) outcomeReject();
  return raw;
}
/** No clock reconstruction: delivery acceptance owns this independent retention deadline. */
export function outcomeLive(command: OutcomeCommand, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < Date.parse(command.arguments[8])) outcomeReject();
  return now < Date.parse(command.arguments[7]) + retentionMs;
}
