import { WorkerEntrypoint } from 'cloudflare:workers';
import type { StagingAuthorityEnv } from './authority-env';
import { active, type Authority } from '../local/authority';
import { bytes, keys, readBounded, json, record, reject } from '../local/protocol';
export { StagingAuthorization } from './authorization';

const denied = () => Response.json({ error: 'managed_request_rejected' }, { status: 403 });
function coordinator(env: StagingAuthorityEnv) {
  if (
    env.ENVIRONMENT !== 'staging' ||
    env.STAGING_ENABLED !== 'true' ||
    env.STAGING_APPLICATION_ID === 'UNAPPROVED'
  )
    reject();
  return env.STAGING_AUTHORIZATIONS.get(
    env.STAGING_AUTHORIZATIONS.idFromName(env.STAGING_APPLICATION_ID)
  );
}
async function snapshot(env: StagingAuthorityEnv, signer: boolean): Promise<Response> {
  try {
    const reply = await coordinator(env).fetch('http://authority.bugdrop.localhost/snapshot');
    if (!reply.ok) reject();
    const projection = await reply.json<Authority['projection']>();
    const configured = record(json(new TextEncoder().encode(env.STAGING_SIGNING_KEYSET)));
    keys(configured, ['activeKid', 'keys']);
    if (
      typeof configured.activeKid !== 'string' ||
      !Array.isArray(configured.keys) ||
      configured.keys.length < 1 ||
      configured.keys.length > 4
    )
      reject();
    const signingKeys: Authority['signingKeys'] = [];
    for (const value of configured.keys) {
      const k = record(value);
      keys(k, ['kid', 'publicKey', 'privateKey', 'notBefore', 'verifyUntil']);
      if (
        typeof k.kid !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(k.kid) ||
        typeof k.notBefore !== 'number' ||
        typeof k.verifyUntil !== 'number' ||
        !Number.isSafeInteger(k.notBefore) ||
        !Number.isSafeInteger(k.verifyUntil) ||
        k.notBefore >= k.verifyUntil
      )
        reject();
      const publicKey = record(k.publicKey);
      keys(publicKey, ['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);
      if (
        publicKey.kty !== 'EC' ||
        publicKey.crv !== 'P-256' ||
        typeof publicKey.x !== 'string' ||
        typeof publicKey.y !== 'string'
      )
        reject();
      const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y };
      await crypto.subtle.importKey(
        'jwk',
        publicJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const privateKey = signer && k.privateKey ? record(k.privateKey) : undefined;
      let privateJwk: JsonWebKey | undefined;
      if (privateKey) {
        if (
          privateKey.kty !== 'EC' ||
          privateKey.crv !== 'P-256' ||
          privateKey.x !== publicJwk.x ||
          privateKey.y !== publicJwk.y ||
          typeof privateKey.d !== 'string'
        )
          reject();
        privateJwk = { ...publicJwk, d: privateKey.d };
        await crypto.subtle.importKey(
          'jwk',
          privateJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign']
        );
      }
      signingKeys.push({
        kid: k.kid,
        notBefore: k.notBefore,
        verifyUntil: k.verifyUntil,
        publicKey: publicJwk,
        ...(privateJwk ? { privateKey: privateJwk } : {}),
      });
    }
    bytes(env.STAGING_AUTH_VERIFIER, 32);
    bytes(env.STAGING_AUTH_PEPPER, 32);
    bytes(env.STAGING_RECEIPT_HMAC_KEY, 32);
    const authority: Authority = {
      now: Date.now(),
      realm: 'staging',
      projection: { ...projection, verifier: env.STAGING_AUTH_VERIFIER },
      pepper: signer ? env.STAGING_AUTH_PEPPER : '',
      receiptKey: signer ? '' : env.STAGING_RECEIPT_HMAC_KEY,
      signingKid: configured.activeKid,
      signingKeys,
    };
    active(authority);
    return Response.json(authority, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return denied();
  }
}
export class IssuerAuthority extends WorkerEntrypoint<StagingAuthorityEnv> {
  async fetch(request: Request) {
    return request.method === 'GET' && new URL(request.url).pathname === '/snapshot'
      ? snapshot(this.env, true)
      : denied();
  }
}
export class DeliveryAuthority extends WorkerEntrypoint<StagingAuthorityEnv> {
  async fetch(request: Request) {
    return request.method === 'GET' && new URL(request.url).pathname === '/snapshot'
      ? snapshot(this.env, false)
      : denied();
  }
}
export class StagingControl extends WorkerEntrypoint<StagingAuthorityEnv> {
  async fetch(request: Request) {
    try {
      if (
        request.method !== 'POST' ||
        !['/projection', '/projection-status', '/revoke-installation'].includes(
          new URL(request.url).pathname
        )
      )
        return denied();
      // Size check at the binding edge, followed by exact-byte authentication in the DO.
      const body = await readBounded(request, 8192);
      return await coordinator(this.env).fetch(new Request(request, { body }));
    } catch {
      return denied();
    }
  }
}
export default { fetch: denied };
