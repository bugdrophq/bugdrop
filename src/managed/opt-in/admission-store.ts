import {
  fail,
  retentionMs,
  type Catalog,
  type Confirmation,
  type Intent,
  type OriginalScope,
  type RegisteredKey,
} from './protocol';
export interface AdmissionRow {
  handle: string;
  epoch: string;
  state: 'signing' | 'admitted' | 'failed-unconfirmed';
  intent: Intent;
  intentDigest: string;
  scope: OriginalScope;
  authorityIdentity: string;
  reservedAt: number;
  retentionDeadline: number;
  signatureKnown: boolean;
  confirmation?: Confirmation;
  capabilityDigest?: string;
  capabilityExpiresAt?: number;
  pending: {
    state: 'awaiting-delivery' | 'pending' | 'acknowledged';
    event?: string;
    command?: unknown;
  };
}
/** One instance per existing authority activation. Constructor recovery never resumes signing. */
export class AdmissionStore {
  readonly epoch = crypto.randomUUID();
  constructor(
    readonly storage: DurableObjectStorage,
    private now = () => Date.now(),
    private capacity = 1024
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) fail();
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS opt_in_admission (
      handle TEXT PRIMARY KEY, credential TEXT NOT NULL, attempt TEXT NOT NULL,
      application TEXT NOT NULL, generation TEXT NOT NULL, submission TEXT NOT NULL,
      deadline INTEGER NOT NULL, body TEXT NOT NULL,
      UNIQUE(credential,attempt), UNIQUE(application,generation,submission))`);
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS opt_in_history (kind TEXT NOT NULL, identity TEXT NOT NULL, deadline INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,identity))'
    );
    storage.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS opt_in_event ON opt_in_admission(json_extract(body,'$.pending.event')) WHERE json_extract(body,'$.pending.event') IS NOT NULL"
    );
    storage.transactionSync(() => {
      for (const { body } of storage.sql
        .exec<{ body: string }>('SELECT body FROM opt_in_admission')
        .toArray()) {
        const row: AdmissionRow = JSON.parse(body);
        if (row.state !== 'admitted') {
          row.state = 'failed-unconfirmed';
          row.epoch = 'retired';
          this.write(row);
        }
      }
      this.purge();
    });
  }
  private write(row: AdmissionRow): void {
    this.storage.sql.exec(
      'UPDATE opt_in_admission SET body=? WHERE handle=?',
      JSON.stringify(row),
      row.handle
    );
  }
  private raw(handle: string): AdmissionRow | undefined {
    const row = this.storage.sql
      .exec<{ body: string }>('SELECT body FROM opt_in_admission WHERE handle=?', handle)
      .toArray()[0];
    return row ? JSON.parse(row.body) : undefined;
  }
  assertUnrevoked(): void {
    if (this.storage.sql.exec('SELECT id FROM revocation WHERE id=1').toArray().length)
      fail('scope_rejected');
  }
  read(handle: string): AdmissionRow | undefined {
    const row = this.raw(handle);
    return row && row.retentionDeadline > this.now() ? row : undefined;
  }
  reserve(
    input: Omit<
      AdmissionRow,
      'epoch' | 'state' | 'reservedAt' | 'retentionDeadline' | 'signatureKnown' | 'pending'
    >,
    history: { catalog: Catalog; keys: RegisteredKey[] },
    check: () => void
  ): AdmissionRow {
    return this.storage.transactionSync(() => {
      check();
      this.purge();
      const now = this.now();
      const existing = this.storage.sql
        .exec<{ body: string }>(
          'SELECT body FROM opt_in_admission WHERE credential=? AND attempt=?',
          input.scope.credentialId,
          input.intent.attemptId
        )
        .toArray()[0];
      if (existing) {
        const old: AdmissionRow = JSON.parse(existing.body);
        fail(
          old.intentDigest === input.intentDigest &&
            old.authorityIdentity === input.authorityIdentity
            ? 'attempt_already_seen'
            : 'binding_conflict'
        );
      }
      if (
        this.storage.sql
          .exec(
            'SELECT handle FROM opt_in_admission WHERE application=? AND generation=? AND submission=?',
            input.scope.applicationId,
            input.scope.installationGeneration,
            input.intent.submissionId
          )
          .toArray().length
      )
        fail('binding_conflict');
      const usage = this.storage.sql
        .exec<{ count: number; size: number }>(
          'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS size FROM opt_in_admission'
        )
        .one();
      if (
        usage.count >= this.capacity ||
        usage.size + JSON.stringify(input).length * 4 > 8 * 1024 * 1024 ||
        this.raw(input.handle)
      )
        fail();
      const row: AdmissionRow = {
        ...structuredClone(input),
        epoch: this.epoch,
        state: 'signing',
        reservedAt: now,
        retentionDeadline: now + retentionMs,
        signatureKnown: false,
        pending: { state: 'awaiting-delivery' },
      };
      for (const [kind, id, value] of [
        ['catalog', input.intent.catalogDigest, history.catalog],
        ...history.keys.map(k => [
          'key',
          k.kid,
          {
            kid: k.kid,
            purpose: k.purpose,
            publicKey: k.publicKey,
            notBefore: k.notBefore,
            verifyUntil: k.verifyUntil,
          },
        ]),
      ] as [string, string, unknown][]) {
        const body = JSON.stringify(value);
        const old = this.storage.sql
          .exec<{ body: string }>(
            'SELECT body FROM opt_in_history WHERE kind=? AND identity=?',
            kind,
            id
          )
          .toArray()[0];
        if (old && old.body !== body) fail('binding_conflict');
        if (
          !old &&
          this.storage.sql
            .exec<{ n: number }>('SELECT COUNT(*) AS n FROM opt_in_history WHERE kind=?', kind)
            .one().n >= 128
        )
          fail();
        this.storage.sql.exec(
          'INSERT INTO opt_in_history VALUES(?,?,?,?) ON CONFLICT(kind,identity) DO UPDATE SET deadline=MAX(deadline,excluded.deadline)',
          kind,
          id,
          row.retentionDeadline + 300000,
          body
        );
      }
      this.storage.sql.exec(
        'INSERT INTO opt_in_admission VALUES(?,?,?,?,?,?,?,?)',
        row.handle,
        row.scope.credentialId,
        row.intent.attemptId,
        row.scope.applicationId,
        row.scope.installationGeneration,
        row.intent.submissionId,
        row.retentionDeadline,
        JSON.stringify(row)
      );
      return row;
    });
  }
  known(handle: string): void {
    this.storage.transactionSync(() => {
      const row = this.read(handle);
      // A callback from an old activation can never alter the recovered owner epoch.
      if (!row || row.epoch !== this.epoch || row.state === 'admitted') return;
      row.signatureKnown = true;
      this.write(row);
    });
  }
  fail(handle: string): void {
    this.storage.transactionSync(() => {
      const row = this.read(handle);
      if (row?.epoch === this.epoch && row.state === 'signing') {
        row.state = 'failed-unconfirmed';
        this.write(row);
      }
    });
  }
  admit(
    handle: string,
    confirmation: Confirmation,
    capabilityExpiresAt: number,
    check: () => void
  ): void {
    this.storage.transactionSync(() => {
      check();
      const row = this.read(handle);
      if (!row || row.epoch !== this.epoch || row.state !== 'signing' || !row.signatureKnown)
        fail();
      if (
        confirmation.reservedAt !== row.reservedAt ||
        confirmation.retentionDeadline !== row.retentionDeadline ||
        confirmation.intentDigest !== row.intentDigest ||
        confirmation.expiresAt !== row.intent.expiresAt ||
        confirmation.admittedAt < row.reservedAt ||
        confirmation.admittedAt >= row.intent.expiresAt
      )
        fail();
      row.state = 'admitted';
      row.confirmation = structuredClone(confirmation);
      row.capabilityDigest = confirmation.capabilityDigest;
      row.capabilityExpiresAt = capabilityExpiresAt;
      // A and the content-free marker become durable in the same transaction.
      row.pending = { state: 'awaiting-delivery' };
      this.write(row);
    });
  }
  transition(handle: string, change: (row: AdmissionRow) => void): void {
    this.storage.transactionSync(() => {
      const row = this.read(handle);
      if (!row || row.state !== 'admitted') fail();
      change(row);
      this.write(row);
    });
  }
  evidence(handle: string): { R: 1; S: 1 | 'UNKNOWN'; U: 0 | 1; A: 0 | 1 } | undefined {
    const row = this.read(handle);
    return row
      ? {
          R: 1,
          S: row.signatureKnown ? 1 : 'UNKNOWN',
          U: row.signatureKnown ? 0 : 1,
          A: row.state === 'admitted' ? 1 : 0,
        }
      : undefined;
  }
  purge(): void {
    this.storage.sql.exec('DELETE FROM opt_in_admission WHERE deadline<=?', this.now());
    this.storage.sql.exec('DELETE FROM opt_in_history WHERE deadline<=?', this.now());
  }
}
