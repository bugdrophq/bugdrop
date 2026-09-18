import { scopeIdentity } from './verifier';
/** Recompute synchronously before enqueueing the one shared alarm update; no stale awaited deadline. */
export async function scheduleAlarm(storage: DurableObjectStorage): Promise<void> {
  const deadlines: number[] = [];
  const tables = new Set(
    storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .toArray()
      .map(r => r.name)
  );
  for (const table of ['opt_in_admission', 'opt_in_history']) {
    if (tables.has(table)) {
      const result = storage.sql
        .exec<{ deadline: number | null }>(`SELECT MIN(deadline) AS deadline FROM ${table}`)
        .one();
      if (result.deadline !== null) deadlines.push(result.deadline);
    }
  }
  if (tables.has('staging_observation')) {
    const row = storage.sql
      .exec<{ value: string }>('SELECT value FROM staging_observation WHERE id=1')
      .toArray()[0];
    if (row) deadlines.push(JSON.parse(row.value).expiresAt);
  }
  if (deadlines.length) await storage.setAlarm(Math.min(...deadlines));
  else await storage.deleteAlarm();
}

import { AdmissionStore } from './admission-store';
import { exact, fail, retentionMs, uuid, type OriginalScope, type Versions } from './protocol';
/** Authenticated original delivery acceptance, supplied by a separately qualified private producer.
 * It is not inferred from issuance, a client request, dispatch time or a current provider lookup. */
export interface OriginalDelivery {
  scope: OriginalScope;
  authorityIdentity: string;
  submissionId: string;
  payloadDigest: string;
  eventHash: string;
  submissionHash: string;
  acceptedAt: string;
  occurredAt: string;
  state: 'authorized';
  reason: 'none';
  isTest: boolean;
  correlationId: string;
}
export interface PendingCommand {
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
    'authorized',
    'none',
    boolean,
    string,
    Versions['sdkVersion'],
    Versions['browserSdkVersion'],
    null,
    2,
  ];
}
function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value)
    fail('binding_conflict');
  return time;
}
/** Exactly one immutable metadata-transfer event; subsequent outcome events belong to delivery/P6. */
export class PendingWork {
  constructor(
    private store: AdmissionStore,
    private now = () => Date.now()
  ) {}
  async join(
    handle: string,
    originalDelivery: () => Promise<OriginalDelivery | undefined>
  ): Promise<PendingCommand> {
    const original = this.store.read(handle);
    if (!original || original.state !== 'admitted') fail();
    const delivery = await originalDelivery();
    if (!delivery) fail();
    exact(delivery, [
      'scope',
      'authorityIdentity',
      'submissionId',
      'payloadDigest',
      'eventHash',
      'submissionHash',
      'acceptedAt',
      'occurredAt',
      'state',
      'reason',
      'isTest',
      'correlationId',
    ]);
    const accepted = timestamp(delivery.acceptedAt),
      occurred = timestamp(delivery.occurredAt);
    if (
      !/^[0-9a-f]{64}$/.test(delivery.eventHash) ||
      !/^[0-9a-f]{64}$/.test(delivery.submissionHash) ||
      !uuid.test(delivery.correlationId) ||
      delivery.state !== 'authorized' ||
      delivery.reason !== 'none' ||
      typeof delivery.isTest !== 'boolean' ||
      accepted < original.confirmation!.admittedAt ||
      !original.capabilityExpiresAt ||
      accepted >= original.capabilityExpiresAt ||
      occurred < accepted ||
      occurred > this.now() ||
      accepted + retentionMs <= this.now() ||
      scopeIdentity(delivery.scope) !== scopeIdentity(original.scope) ||
      delivery.authorityIdentity !== original.authorityIdentity ||
      delivery.submissionId !== original.intent.submissionId ||
      delivery.payloadDigest !== original.intent.payloadDigest
    )
      fail('binding_conflict');
    const s = original.scope,
      v = original.intent.normalizedVersions;
    const command: PendingCommand = {
      schemaVersion: 2,
      command: 'ingest_outcome_v2',
      arguments: [
        s.tenantId,
        s.applicationId,
        s.installationGeneration,
        s.destinationId,
        s.credentialId,
        delivery.eventHash,
        delivery.submissionHash,
        delivery.acceptedAt,
        delivery.occurredAt,
        delivery.state,
        delivery.reason,
        delivery.isTest,
        delivery.correlationId,
        v.sdkVersion,
        v.browserSdkVersion,
        null,
        2,
      ],
    };
    this.store.transition(handle, row => {
      if (row.pending.event !== undefined) {
        if (
          row.pending.event !== delivery.eventHash ||
          JSON.stringify(row.pending.command) !== JSON.stringify(command)
        )
          fail('binding_conflict');
        return;
      }
      row.pending = { state: 'pending', event: delivery.eventHash, command };
    });
    await this.store.storage.sync();
    const final = this.store.read(handle);
    if (!final || final.pending.event !== delivery.eventHash) fail();
    return structuredClone(command);
  }
  private byEvent(event: string) {
    if (!/^[0-9a-f]{64}$/.test(event)) fail('binding_conflict');
    const found = this.store.storage.sql
      .exec<{ handle: string }>(
        "SELECT handle FROM opt_in_admission WHERE json_extract(body,'$.pending.event')=?",
        event
      )
      .toArray();
    if (found.length !== 1) fail();
    const row = this.store.read(found[0].handle);
    if (!row || row.state !== 'admitted') fail();
    return row;
  }
  async read(
    event: string
  ): Promise<{ state: 'pending' | 'acknowledged'; command: PendingCommand }> {
    await this.store.storage.sync();
    const row = this.byEvent(event);
    if (row.pending.state === 'awaiting-delivery' || !row.pending.command) fail();
    return {
      state: row.pending.state,
      command: structuredClone(row.pending.command) as PendingCommand,
    };
  }
  /** Caller must have confirmed durable destination acceptance of this exact event and tuple.
   * Ambiguous SQL completion must not invoke this method. Ack never deletes replay evidence. */
  async acknowledge(event: string, receipt: { eventHash: string; accepted: true }): Promise<void> {
    exact(receipt, ['eventHash', 'accepted']);
    if (receipt.eventHash !== event || receipt.accepted !== true) fail('binding_conflict');
    const row = this.byEvent(event);
    this.store.transition(row.handle, current => {
      current.pending.state = 'acknowledged';
    });
    await this.store.storage.sync();
    if (this.byEvent(event).pending.state !== 'acknowledged') fail();
  }
}
