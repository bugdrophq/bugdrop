import { DurableObject } from 'cloudflare:workers';
import type { StagingAuthorityEnv } from './authority-env';
import { json, keys, readBounded, record, reject, verifyHmac } from '../local/protocol';
import { update, type Update } from './projection';

export class StagingAuthorization extends DurableObject<StagingAuthorityEnv> {
  constructor(ctx: DurableObjectState, env: StagingAuthorityEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS authorization (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)'
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS revocation (id INTEGER PRIMARY KEY CHECK(id=1))'
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (this.env.ENVIRONMENT !== 'staging' || this.env.STAGING_ENABLED !== 'true') reject();
      const path = new URL(request.url).pathname;
      const stored = this.ctx.storage.sql
        .exec<{ snapshot: string }>('SELECT snapshot FROM authorization WHERE id=1')
        .toArray()[0];
      const current: Update | undefined = stored ? JSON.parse(stored.snapshot) : undefined;
      const revoked =
        this.ctx.storage.sql.exec('SELECT id FROM revocation WHERE id=1').toArray().length > 0;
      if (request.method === 'GET' && path === '/snapshot') {
        if (!current) reject();
        return Response.json({
          ...current.projection,
          installationActive: current.projection.installationActive && !revoked,
        });
      }
      if (request.method !== 'POST' || !['/projection', '/revoke-installation'].includes(path))
        reject();
      const raw = await readBounded(request, 8192);
      if (
        !(await verifyHmac(
          path === '/revoke-installation'
            ? this.env.STAGING_UNINSTALL_HMAC_KEY
            : this.env.STAGING_CONTROL_HMAC_KEY,
          raw,
          request.headers.get('X-BugDrop-Control-Signature') ?? ''
        ))
      )
        reject();
      const body = json(raw);
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
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO authorization VALUES (1, ?)',
          JSON.stringify(next)
        );
      }
      await this.ctx.storage.sync();
      return Response.json({ schemaVersion: 1, accepted: true });
    } catch {
      return Response.json({ error: 'managed_control_rejected' }, { status: 403 });
    }
  }
}
