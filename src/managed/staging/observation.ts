import { json, readBounded, reject, verifyHmac } from '../local/protocol';
import {
  exactObservation,
  observationMessage,
  observationReply,
  observationScope,
  observationUuid,
  type ObservationEnv,
} from './observation-wire';

interface Lease {
  applicationId: string;
  installationId: string;
  runId: string;
  scenario: string;
  leaseId: string;
  expiresAt: number;
  valid: boolean;
  closed: boolean;
  exchanges: { sequence: number; sdkVersion: '0.1.0' | null; status: number | null }[];
}
const scenarios = new Set([
  'delivered',
  'origin',
  'tampered',
  'binding',
  'revoked',
  'stale',
  'indeterminate',
  'duplicate-concurrent',
  'timeout-after-dispatch',
  'restart-after-dispatch',
  'stale-authorization',
  'substitute-tenantId',
  'substitute-applicationId',
  'substitute-destinationId',
  'origin-aliases',
  'revoke-credential',
  'revoke-application',
  'revoke-tenant',
  'retention-deletion',
  'uninstall',
]);
function requestFields(path: string) {
  return path.endsWith('/start')
    ? ['runId', 'scenario']
    : path.endsWith('/begin')
      ? ['sdkVersion']
      : path.endsWith('/finish')
        ? [...selectors, 'sequence', 'status']
        : selectors;
}
const common = ['schemaVersion', 'applicationId', 'installationId'];
const selectors = ['runId', 'scenario', 'leaseId'];
export class Observation {
  private poisoned = false;
  constructor(
    private storage: DurableObjectStorage,
    private now = () => Date.now()
  ) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS staging_observation (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)'
    );
    const old = this.read();
    // A restarted observer cannot certify that an interrupted ingress attempt was counted.
    if (old && !old.closed) {
      old.valid = false;
      this.save(old);
    }
  }
  private read(): Lease | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>('SELECT value FROM staging_observation WHERE id=1')
      .toArray()[0];
    return row ? (JSON.parse(row.value) as Lease) : undefined;
  }
  private save(item: Lease) {
    this.storage.sql.exec(
      'INSERT OR REPLACE INTO staging_observation VALUES (1, ?)',
      JSON.stringify(item)
    );
  }
  async expire() {
    const item = this.read();
    if (item && item.expiresAt <= this.now()) {
      this.storage.sql.exec('DELETE FROM staging_observation WHERE id=1');
      await this.storage.sync();
    }
  }
  async fetch(request: Request, env: ObservationEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      const scope = observationScope(env);
      const key = env.STAGING_OBSERVATION_HMAC_KEY;
      if (
        request.method !== 'POST' ||
        ![
          '/observation/start',
          '/observation/read',
          '/observation/close',
          '/observation/begin',
          '/observation/finish',
        ].includes(path)
      )
        reject();
      const raw = await readBounded(request, 1024);
      if (
        !(await verifyHmac(
          key,
          observationMessage(path, raw),
          request.headers.get('X-BugDrop-Observation-Signature') ?? ''
        ))
      )
        reject();
      const body = exactObservation(json(raw), [...common, 'requestNonce', ...requestFields(path)]);
      observationUuid(body.requestNonce);
      if (
        common.some(name => body[name] !== scope[name as keyof typeof scope]) ||
        JSON.stringify(observationScope(env)) !== JSON.stringify(scope) ||
        key !== env.STAGING_OBSERVATION_HMAC_KEY
      )
        reject();
      await this.expire();
      if (
        JSON.stringify(observationScope(env)) !== JSON.stringify(scope) ||
        key !== env.STAGING_OBSERVATION_HMAC_KEY
      )
        reject();
      let item = this.read();
      let sequence: number | null = null;
      if (path.endsWith('/start')) {
        observationUuid(body.runId);
        if (
          typeof body.scenario !== 'string' ||
          !scenarios.has(body.scenario) ||
          this.poisoned ||
          (item &&
            (!item.closed ||
              item.exchanges.some(entry => entry.status === null) ||
              (item.runId === body.runId && item.scenario === body.scenario)))
        )
          reject();
        item = {
          ...scope,
          runId: body.runId,
          scenario: body.scenario,
          leaseId: crypto.randomUUID(),
          expiresAt: this.now() + 900_000,
          valid: true,
          closed: false,
          exchanges: [],
        };
        await this.persist(item);
      } else {
        if (
          !item ||
          item.closed ||
          item.applicationId !== scope.applicationId ||
          item.installationId !== scope.installationId
        )
          reject();
        if (
          !path.endsWith('/begin') &&
          selectors.some(name => body[name] !== item![name as keyof Lease])
        )
          reject();
        if (path.endsWith('/begin')) {
          if (body.sdkVersion !== null && body.sdkVersion !== '0.1.0') reject();
          if (item.exchanges.length >= 64) {
            item.valid = false;
            await this.persist(item);
            reject();
          }
          if (item.exchanges.some(e => e.status === null)) item.valid = false;
          item.exchanges.push({
            sequence: item.exchanges.length + 1,
            sdkVersion: body.sdkVersion,
            status: null,
          });
          sequence = item.exchanges.length;
          await this.persist(item);
        } else if (path.endsWith('/finish')) {
          const entry = item.exchanges.find(e => e.sequence === body.sequence);
          if (
            !entry ||
            entry.status !== null ||
            typeof body.status !== 'number' ||
            !Number.isInteger(body.status) ||
            body.status < 200 ||
            body.status > 599
          )
            reject();
          entry.status = body.status;
          await this.persist(item);
        } else if (path.endsWith('/close')) {
          item.closed = true;
          await this.persist(item);
        }
      }
      await this.storage.sync();
      const current = this.read();
      if (!current || current.leaseId !== item.leaseId) reject();
      item = current;
      if (
        JSON.stringify(observationScope(env)) !== JSON.stringify(scope) ||
        key !== env.STAGING_OBSERVATION_HMAC_KEY ||
        item.expiresAt <= this.now()
      )
        reject();
      // This covers durable admissions only; the collector must reconcile SDK outcomes.
      const snapshot = {
        runId: item.runId,
        scenario: item.scenario,
        applicationId: item.applicationId,
        count: item.exchanges.length,
        complete:
          !this.poisoned &&
          item.valid &&
          !item.closed &&
          item.exchanges.every(e => e.status !== null && e.sdkVersion !== null),
        exclusive: !this.poisoned && item.valid && !item.closed,
      };
      return await observationReply(
        path,
        {
          schemaVersion: 2,
          requestNonce: body.requestNonce,
          leaseId: item.leaseId,
          expiresAt: item.expiresAt,
          sequence,
          snapshot,
          exchanges: item.exchanges,
        },
        key
      );
    } catch {
      return Response.json({ error: 'staging_observation_rejected' }, { status: 403 });
    }
  }
  private async persist(item: Lease) {
    try {
      this.storage.transactionSync(() => this.save(item));
      await this.storage.setAlarm(item.expiresAt);
      await this.storage.sync();
    } catch (error) {
      this.poisoned = true;
      try {
        item.valid = false;
        this.save(item);
      } catch {
        /* The in-memory poison and restart invalidation remain fail closed. */
      }
      throw error;
    }
  }
}
