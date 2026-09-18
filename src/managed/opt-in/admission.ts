import { AdmissionStore, type AdmissionRow } from './admission-store';
import { scheduleAlarm } from './pending-work';
import { authenticateToken, current, identity, recheck, registered } from './verifier';
import {
  intentDigest,
  bytes,
  capabilityDigest,
  checkTime,
  confirmationBytes,
  encode,
  fail,
  parseIntent,
  Rejection,
  utf8,
  validateCatalog,
  type AuthoritySnapshot,
  type Capability,
  type Confirmation,
  type CurrentAuthority,
  type Failure,
  type Intent,
} from './protocol';
export interface AdmissionInput {
  raw: Uint8Array;
  authorization: string;
  mac: string;
  serverVersion: string;
}
export type AdmissionResult =
  | { ok: true; schemaVersion: 2; capability: Capability; confirmation: Confirmation }
  | { ok: false; error: Failure };
export type Signer = (key: CryptoKey, message: Uint8Array) => Promise<ArrayBuffer>;
const sign: Signer = (key, message) =>
  crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message);
/** In-process only. Missing independently qualified publication/provisioning is deliberately closed. */
export class Admission {
  constructor(
    private store: AdmissionStore,
    private source: CurrentAuthority = () => undefined,
    private now = () => Date.now(),
    private signer: Signer = sign
  ) {}
  async issue(input: AdmissionInput, signal?: AbortSignal): Promise<AdmissionResult> {
    let sealed = false;
    let row: AdmissionRow | undefined;
    const until = this.now() + 8000;
    const stop = () => {
      sealed = true;
      if (row) {
        try {
          this.store.fail(row.handle);
        } catch {
          /* Uncertain storage remains a spent permit, never a retry. */
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish: () => void = () => {};
    const stopped = new Promise<AdmissionResult>(resolve => {
      finish = () => {
        stop();
        resolve({ ok: false, error: 'temporarily_unavailable' });
      };
    });
    const guard = () => {
      this.store.assertUnrevoked();
      if (row && this.now() < row.reservedAt) fail('attempt_expired');
      if (sealed || signal?.aborted || this.now() >= until) fail();
    };
    const run = async (): Promise<AdmissionResult> => {
      try {
        guard();
        const a = current(this.source, this.now());
        const originalIdentity = identity(a);
        const i = parseIntent(input.raw, input.serverVersion);
        checkTime(i, this.now());
        const digest = await authenticate(i, input.authorization, input.mac, a);
        guard();
        recheck(this.source, originalIdentity, this.now(), i);
        await validateCatalog(i, a);
        guard();
        recheck(this.source, originalIdentity, this.now(), i);
        const capabilityKey = registered(a, a.capabilityKid, 'capability-v2', this.now());
        const confirmationKey = registered(a, a.confirmationKid, 'confirmation-v2', this.now());
        if (!capabilityKey.signingKey || !confirmationKey.signingKey) fail();
        const check = () => {
          guard();
          const fresh = recheck(this.source, originalIdentity, this.now(), i);
          registered(fresh, fresh.capabilityKid, 'capability-v2', this.now());
          registered(fresh, fresh.confirmationKid, 'confirmation-v2', this.now());
        };
        row = this.store.reserve(
          {
            handle: crypto.randomUUID(),
            intent: i,
            intentDigest: digest,
            scope: a.scope,
            authorityIdentity: originalIdentity,
          },
          { catalog: a.catalog, keys: [capabilityKey, confirmationKey] },
          check
        );
        await scheduleAlarm(this.store.storage);
        check();
        await this.store.storage.sync();
        check();
        const iat = Math.floor(this.now() / 1000),
          exp = iat + 300;
        if (exp * 1000 > capabilityKey.verifyUntil) fail('scope_rejected');
        const header = encode(
          utf8(
            JSON.stringify({
              alg: 'ES256',
              kid: capabilityKey.kid,
              typ: 'bugdrop-managed-capability-v2',
            })
          )
        );
        const payload = encode(
          utf8(
            JSON.stringify({
              protocolVersion: 2,
              iss: 'bugdrop-managed-staging-v2',
              aud: 'bugdrop-managed-staging-ingress-v2',
              publicApplicationId: a.scope.publicApplicationId,
              jti: row.handle,
              iat,
              exp,
            })
          )
        );
        check();
        const signed = await this.signer(capabilityKey.signingKey, utf8(header + '.' + payload));
        // Late completion may improve S only under this original live owner; it cannot reopen A.
        this.store.known(row.handle);
        check();
        const capability: Capability = {
          schemaVersion: 1,
          token: header + '.' + payload + '.' + encode(signed),
          expiresAt: new Date(exp * 1000).toISOString(),
        };
        await authenticateToken(capability, a, this.now());
        check();
        const commitment = await capabilityDigest(capability);
        check();
        const unsigned: Omit<Confirmation, 'signature'> = {
          schemaVersion: 2,
          kid: confirmationKey.kid,
          intentDigest: digest,
          capabilityDigest: commitment,
          reservedAt: row.reservedAt,
          retentionDeadline: row.retentionDeadline,
          admittedAt: this.now(),
          expiresAt: i.expiresAt,
        };
        const confirmation: Confirmation = {
          ...unsigned,
          signature: encode(
            await this.signer(confirmationKey.signingKey, confirmationBytes(unsigned))
          ),
        };
        check();
        await this.verifyConfirmation(confirmation, a);
        check();
        this.store.admit(row.handle, confirmation, exp * 1000, check);
        await this.store.storage.sync();
        check();
        if (this.store.read(row.handle)?.state !== 'admitted') fail();
        return { ok: true, schemaVersion: 2, capability, confirmation };
      } catch (error) {
        stop();
        return {
          ok: false,
          error: error instanceof Rejection ? error.category : 'temporarily_unavailable',
        };
      }
    };
    try {
      timer = setTimeout(finish, 8000);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
      return await Promise.race([stopped, run()]);
    } finally {
      sealed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
    }
  }
  private async verifyConfirmation(c: Confirmation, a: AuthoritySnapshot): Promise<void> {
    const k = registered(a, c.kid, 'confirmation-v2', this.now());
    const key = await crypto.subtle.importKey(
      'jwk',
      k.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        bytes(c.signature, 64),
        confirmationBytes(c)
      ))
    )
      fail();
  }
}

function authenticationBytes(value: string): Uint8Array {
  try {
    return bytes(value, 32);
  } catch {
    return fail('authentication_failed');
  }
}
async function authenticate(
  i: Intent,
  authorization: string,
  mac: string,
  a: AuthoritySnapshot
): Promise<string> {
  const match = /^Bearer bd_auth_v2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match || match[1] !== a.scope.keyId || i.keyId !== match[1]) fail('authentication_failed');
  const secret = authenticationBytes(match[2]);
  if (!(await a.authenticate(secret))) fail('authentication_failed');
  const digest = await intentDigest(i);
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      authenticationBytes(mac),
      utf8('bugdrop:intent-request:v2\0POST\0' + i.endpoint + '\0' + digest)
    ))
  )
    fail('authentication_failed');
  return digest;
}
