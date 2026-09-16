import { DurableObject } from 'cloudflare:workers';
import type { LocalDeliveryEnv } from './delivery-env';
import { loadAuthority } from './authority';
import { verifySubmission } from './capability';
import { bytes, hmac, json, readBounded, utf8 } from './protocol';
import { response, type Outcome } from './outcome';
import { submission } from './submission';
import { attemptOnce } from './fake-github';

interface StoredReceipt extends Record<string, SqlStorageValue> {
  commitment: string;
  state: Outcome;
  expiresAt: number;
}
export class LocalManagedReceipt extends DurableObject<LocalDeliveryEnv> {
  private liveAttempt = false;
  constructor(ctx: DurableObjectState, env: LocalDeliveryEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS receipt (id INTEGER PRIMARY KEY CHECK(id=1), commitment TEXT NOT NULL, state TEXT NOT NULL, expiresAt INTEGER NOT NULL)'
    );
    // A persisted delivering state without this instance's active marker is never retried.
    this.ctx.storage.sql.exec("UPDATE receipt SET state='indeterminate' WHERE state='delivering'");
  }
  private read(): StoredReceipt | undefined {
    return this.ctx.storage.sql
      .exec<StoredReceipt>('SELECT commitment,state,expiresAt FROM receipt WHERE id=1')
      .toArray()[0];
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/_local/state')
      return Response.json(this.read() ?? null);
    if (request.method !== 'POST') return response('rejected');
    let enteredDelivery = false;
    try {
      const input = submission(json(await readBounded(request)));
      const authority = await loadAuthority(this.env.LOCAL_AUTHORITY);
      const claims = await verifySubmission(
        input.token,
        input.origin,
        input.binding,
        bytes(input.body),
        authority
      );
      const commitment = await hmac(
        authority.receiptKey,
        utf8(JSON.stringify([claims.applicationId, claims.submissionId, claims.payloadDigest]))
      );
      const existing = this.read();
      if (existing && existing.expiresAt > authority.now) {
        if (existing.commitment !== commitment) return response('rejected');
        if (existing.state === 'delivering' && !this.liveAttempt)
          this.ctx.storage.sql.exec("UPDATE receipt SET state='indeterminate' WHERE id=1");
        return response(this.read()!.state);
      }
      // Synchronous SQL admission has no await: concurrent requests cannot claim a second attempt.
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO receipt (id,commitment,state,expiresAt) VALUES (1,?,?,?)',
        commitment,
        'delivering',
        authority.now + 30 * 86_400_000
      );
      this.liveAttempt = true;
      enteredDelivery = true;
      await this.ctx.storage.sync();
      await this.ctx.storage.setAlarm(authority.now + 30 * 86_400_000);
      // Recheck after durable admission and immediately before the sole external attempt.
      try {
        const fresh = await loadAuthority(this.env.LOCAL_AUTHORITY);
        await verifySubmission(input.token, input.origin, input.binding, bytes(input.body), fresh);
      } catch {
        this.ctx.storage.sql.exec("UPDATE receipt SET state='failed_before_delivery' WHERE id=1");
        return response('failed_before_delivery');
      }
      const outcome = await attemptOnce(this.env.LOCAL_FAKE_GITHUB, bytes(input.body));
      this.ctx.storage.sql.exec('UPDATE receipt SET state=? WHERE id=1', outcome);
      return response(outcome);
    } catch {
      if (enteredDelivery) {
        try {
          this.ctx.storage.sql.exec("UPDATE receipt SET state='indeterminate' WHERE id=1");
        } catch {
          /* Durable delivering remains unretryable on restart. */
        }
      }
      return response(enteredDelivery ? 'indeterminate' : 'rejected');
    } finally {
      if (enteredDelivery) this.liveAttempt = false;
    }
  }
  async alarm(): Promise<void> {
    // Retain the live schema, and do not let a delayed/retried alarm erase a newer receipt.
    this.ctx.storage.sql.exec('DELETE FROM receipt WHERE expiresAt <= ?', Date.now());
    const pending = this.read();
    if (pending) await this.ctx.storage.setAlarm(pending.expiresAt);
  }
}
