import { DurableObject } from 'cloudflare:workers';
import type { StagingAuthorityEnv } from './authority-env';
import { json, keys, readBounded, record, reject, verifyHmac, hmac, utf8 } from '../local/protocol';
import { update, type Update } from './projection';
import {
  controlReceipt,
  matches,
  projectionDigest,
  receiptResponse,
  selector,
  statusMessage,
  type ControlReceipt,
} from './control-receipt';

export class StagingAuthorization extends DurableObject<StagingAuthorityEnv> {
  constructor(ctx: DurableObjectState, env: StagingAuthorityEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS authorization (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS control_receipt (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS revocation (id INTEGER PRIMARY KEY CHECK(id=1))'
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (this.env.ENVIRONMENT !== 'staging' || this.env.STAGING_ENABLED !== 'true') reject();
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/snapshot') {
        const stored = this.ctx.storage.sql
          .exec<{ snapshot: string }>('SELECT snapshot FROM authorization WHERE id=1')
          .toArray()[0];
        if (!stored) reject();
        const current: Update = JSON.parse(stored.snapshot);
        const revoked =
          this.ctx.storage.sql.exec('SELECT id FROM revocation WHERE id=1').toArray().length > 0;
        return Response.json({
          ...current.projection,
          installationActive: current.projection.installationActive && !revoked,
        });
      }
      if (
        request.method !== 'POST' ||
        !['/projection', '/projection-status', '/revoke-installation'].includes(path)
      )
        reject();
      const raw = await readBounded(request, 8192);
      if (
        !(await verifyHmac(
          path === '/revoke-installation'
            ? this.env.STAGING_UNINSTALL_HMAC_KEY
            : this.env.STAGING_CONTROL_HMAC_KEY,
          path === '/projection-status' ? statusMessage(raw) : raw,
          request.headers.get('X-BugDrop-Control-Signature') ?? ''
        ))
      )
        reject();
      const body = json(raw);
      const digest = path === '/projection' ? await projectionDigest(raw) : '';
      // No persisted control state is read until authentication and hashing finish.
      const storedReceipt = this.ctx.storage.sql
        .exec<{ body: string }>('SELECT body FROM control_receipt WHERE id=1')
        .toArray()[0];
      const previous: ControlReceipt | undefined = storedReceipt
        ? JSON.parse(storedReceipt.body)
        : undefined;
      if (path === '/projection-status') {
        const query = selector(body, this.env.STAGING_APPLICATION_ID);
        if (!previous || !matches(previous, query)) reject();
        await this.ctx.storage.sync();
        return await receiptResponse(previous, this.env.STAGING_CONTROL_HMAC_KEY);
      }
      let accepted: ControlReceipt | undefined;
      // Read again after asynchronous signature verification before comparing/writing.
      const latestRow = this.ctx.storage.sql
        .exec<{ snapshot: string }>('SELECT snapshot FROM authorization WHERE id=1')
        .toArray()[0];
      const latest: Update | undefined = latestRow ? JSON.parse(latestRow.snapshot) : undefined;
      const latched =
        this.ctx.storage.sql.exec('SELECT id FROM revocation WHERE id=1').toArray().length > 0;
      if (path === '/revoke-installation') {
        const event = record(body);
        keys(event, ['schemaVersion', 'installationId']);
        if (
          event.schemaVersion !== 1 ||
          event.installationId !== this.env.STAGING_INSTALLATION_ID ||
          event.installationId === 'UNAPPROVED'
        )
          reject();
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO revocation VALUES (1)');
      } else {
        // Exact retries acknowledge historical persistence, including after expiry.
        // They never rewrite the projection, observation time, or revocation latch.
        if (latest && record(body).sequence === latest.sequence) {
          if (
            !previous ||
            previous.sequence !== latest.sequence ||
            previous.projectionDigest !== digest
          )
            reject();
          await this.ctx.storage.sync();
          return await receiptResponse(previous, this.env.STAGING_CONTROL_HMAC_KEY);
        }
        const next = update(
          body,
          this.env.STAGING_APPLICATION_ID,
          this.env.STAGING_INSTALLATION_ID,
          Date.now()
        );
        if (
          latest &&
          (next.sequence <= latest.sequence ||
            next.projection.observedAt < latest.projection.observedAt ||
            next.projection.configurationVersion < latest.projection.configurationVersion ||
            next.projection.authorizationVersion < latest.projection.authorizationVersion)
        )
          reject();
        if (
          latest &&
          (next.projection.tenantId !== latest.projection.tenantId ||
            next.projection.keyId !== latest.projection.keyId ||
            next.projection.destinationId !== latest.projection.destinationId)
        )
          reject();
        if (latest) {
          if (
            next.projection.origin !== latest.projection.origin &&
            next.projection.configurationVersion <= latest.projection.configurationVersion
          )
            reject();
          const changed = (
            ['credentialActive', 'applicationActive', 'installationActive', 'tenantActive'] as const
          ).some(field => next.projection[field] !== latest.projection[field]);
          if (
            changed &&
            next.projection.authorizationVersion <= latest.projection.authorizationVersion
          )
            reject();
          // A credential cannot be revived under the same immutable key identity.
          if (!latest.projection.credentialActive && next.projection.credentialActive) reject();
        }
        if (latched && next.projection.installationActive) reject();
        // SQL write is synchronous: two updates cannot interleave between comparison and admission.
        accepted = controlReceipt(next, digest);
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            'INSERT OR REPLACE INTO authorization VALUES (1, ?)',
            JSON.stringify(next)
          );
          this.ctx.storage.sql.exec(
            'INSERT OR REPLACE INTO control_receipt VALUES (1, ?)',
            JSON.stringify(accepted)
          );
        });
      }
      await this.ctx.storage.sync();
      if (accepted) return await receiptResponse(accepted, this.env.STAGING_CONTROL_HMAC_KEY);
      const receipt = JSON.stringify({
        schemaVersion: 1,
        accepted: true,
        applicationId: this.env.STAGING_APPLICATION_ID,
        installationId: this.env.STAGING_INSTALLATION_ID,
        revoked: true,
      });
      return new Response(receipt, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-BugDrop-Uninstall-Receipt-Signature': await hmac(
            this.env.STAGING_UNINSTALL_HMAC_KEY,
            utf8('bugdrop:uninstall:edge-receipt:v1\0' + receipt)
          ),
        },
      });
    } catch {
      return Response.json({ error: 'managed_control_rejected' }, { status: 403 });
    }
  }
}
