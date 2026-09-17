import { DurableObject } from 'cloudflare:workers';
import { stagingConfig } from '../github-staging/config';
import { hmac, json, readBounded, record, reject, utf8, verifyHmac } from '../local/protocol';
import { applyEdge, applySql, type UninstallAdapters } from './adapters';
import { commitments, type UninstallWork } from './contracts';

export interface UninstallEnv extends UninstallAdapters {
  ENVIRONMENT: string;
  STAGING_ENABLED: string;
  STAGING_GITHUB_TARGET_JSON: string;
  STAGING_UNINSTALL_COMMITMENT_KEY: string;
}
interface Pending extends UninstallWork {
  edgeAcknowledged: boolean;
  sqlAcknowledged: boolean;
  sqlQuarantined: boolean;
  attempts: number;
  nextAttemptAt: number;
  completedAt: number | null;
}
const retention = 30 * 86_400_000;
const delays = [1000, 5000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
export class StagingUninstall extends DurableObject<UninstallEnv> {
  private running: Promise<void> | undefined;
  protected now(): number {
    return Date.now();
  }
  constructor(ctx: DurableObjectState, env: UninstallEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS uninstall_work (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)'
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS uninstall_fence (id INTEGER PRIMARY KEY CHECK(id=1))'
    );
  }
  private read(): Pending | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM uninstall_work WHERE id=1')
      .toArray()[0];
    return row ? (JSON.parse(row.value) as Pending) : undefined;
  }
  private save(item: Pending): void {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO uninstall_work VALUES (1, ?)',
      JSON.stringify(item)
    );
  }
  private target() {
    if (this.env.ENVIRONMENT !== 'staging' || this.env.STAGING_ENABLED !== 'true') reject();
    return stagingConfig(json(utf8(this.env.STAGING_GITHUB_TARGET_JSON)));
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const config = this.target();
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || !['/intake', '/status', '/resume'].includes(path)) reject();
      const raw = await readBounded(request, 512);
      const signed = utf8(
        `bugdrop:uninstall:${path.slice(1)}:v1\0${new TextDecoder().decode(raw)}`
      );
      if (
        !(await verifyHmac(
          this.env.STAGING_UNINSTALL_COMMITMENT_KEY,
          signed,
          request.headers.get('X-BugDrop-Uninstall-Signature') ?? ''
        ))
      )
        reject();
      const expected = await commitments(
        this.env.STAGING_UNINSTALL_COMMITMENT_KEY,
        config.appId,
        config.installationId
      );
      const body = record(json(raw));
      if (
        Object.keys(body).sort().join('|') !== 'eventHash|installationHash|schemaVersion' ||
        body.schemaVersion !== 1 ||
        body.eventHash !== expected.eventHash ||
        body.installationHash !== expected.installationHash
      )
        reject();
      // After asynchronous authentication, admission is a single synchronous transaction.
      let item = this.read();
      if (
        path === '/intake' &&
        !item &&
        this.ctx.storage.sql.exec('SELECT id FROM uninstall_fence').toArray().length === 0
      ) {
        item = {
          ...expected,
          requestId: crypto.randomUUID(),
          occurredAt: this.now(),
          edgeAcknowledged: false,
          sqlAcknowledged: false,
          sqlQuarantined: false,
          attempts: 0,
          nextAttemptAt: this.now(),
          completedAt: null,
        };
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('INSERT INTO uninstall_fence VALUES (1)');
          this.save(item!);
        });
      }
      if (path === '/resume' && item && item.completedAt === null) {
        item.attempts = 0;
        item.sqlQuarantined = false;
        item.nextAttemptAt = this.now();
        this.save(item);
      }
      if (path !== '/status') {
        // Re-arm even duplicate intake after a crash between admission and alarm creation.
        if (item && item.completedAt === null && item.nextAttemptAt > 0)
          await this.ctx.storage.setAlarm(Math.max(this.now(), item.nextAttemptAt));
        await this.ctx.storage.sync();
        await this.drain();
      }
      if (path === '/intake') return Response.json({ schemaVersion: 1, accepted: true });
      const current = this.read();
      const state = current
        ? current.completedAt !== null
          ? 'complete'
          : current.sqlQuarantined
            ? 'quarantined'
            : 'pending'
        : this.ctx.storage.sql.exec('SELECT id FROM uninstall_fence').toArray().length
          ? 'retired'
          : 'absent';
      const response = JSON.stringify({ schemaVersion: 1, state, work: current ?? null });
      return new Response(response, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-BugDrop-Uninstall-Receipt-Signature': await hmac(
            this.env.STAGING_UNINSTALL_COMMITMENT_KEY,
            utf8(`bugdrop:uninstall:status:v1\0${response}`)
          ),
        },
      });
    } catch {
      return Response.json({ error: 'uninstall_request_rejected' }, { status: 503 });
    }
  }
  private drain(): Promise<void> {
    if (!this.running)
      this.running = this.attempt().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async attempt(): Promise<void> {
    const config = this.target();
    let item = this.read();
    if (
      !item ||
      item.completedAt !== null ||
      item.attempts >= delays.length ||
      item.nextAttemptAt > this.now()
    )
      return;
    item.attempts++;
    item.nextAttemptAt = this.now() + delays[item.attempts - 1];
    this.save(item);
    await this.ctx.storage.setAlarm(item.nextAttemptAt);
    await this.ctx.storage.sync();
    const original: UninstallWork = {
      eventHash: item.eventHash,
      installationHash: item.installationHash,
      occurredAt: item.occurredAt,
      requestId: item.requestId,
    };
    const [edge, sql] = await Promise.all([
      item.edgeAcknowledged
        ? true
        : applyEdge(this.env, String(config.installationId)).catch(() => false),
      item.sqlAcknowledged
        ? 'applied'
        : item.sqlQuarantined
          ? 'quarantined'
          : applySql(this.env, original, String(config.installationId)).catch(() => 'pending'),
    ]);
    item = this.read()!;
    item.edgeAcknowledged ||= edge;
    item.sqlAcknowledged ||= sql === 'applied';
    item.sqlQuarantined = !item.sqlAcknowledged && sql === 'quarantined';
    if (item.edgeAcknowledged && item.sqlAcknowledged) {
      item.completedAt = this.now();
      item.nextAttemptAt = item.completedAt + retention;
    } else if (item.attempts >= delays.length || (item.edgeAcknowledged && item.sqlQuarantined))
      item.nextAttemptAt = 0;
    this.save(item);
    if (item.nextAttemptAt > 0) await this.ctx.storage.setAlarm(item.nextAttemptAt);
    else await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.sync();
  }
  async alarm(): Promise<void> {
    const item = this.read();
    if (item?.completedAt !== null && item?.completedAt !== undefined) {
      if (item.completedAt + retention <= this.now()) {
        this.ctx.storage.sql.exec('DELETE FROM uninstall_work WHERE id=1');
        await this.ctx.storage.sync();
      } else await this.ctx.storage.setAlarm(item.completedAt + retention);
      return;
    }
    await this.drain();
  }
}
