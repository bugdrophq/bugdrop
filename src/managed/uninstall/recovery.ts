import { bytes, digest, hmac, json, record, utf8, verifyHmac } from '../local/protocol';
import { work, type UninstallWork } from './contracts';

export interface RecoveryEnvironment {
  STAGING_UNINSTALL_RECOVERY?: Fetcher;
  STAGING_UNINSTALL_RECOVERY_HMAC_KEY?: string;
}
export interface RecoveryExpectation extends UninstallWork {
  tombstonedAt: number;
  tombstoneId: string;
  recoveryGeneration: string;
  recoveryRequestId: string;
  deployment: string;
  githubAppId: number;
  applicationId: string;
  providerInstallationId: string;
  challenge: string;
  challengeExpiresAt: number;
}
export async function hashRecoveryChallenge(challenge: string): Promise<string> {
  bytes(challenge, 32);
  return digest(utf8(`bugdrop:uninstall:recovery-challenge:v1\0${challenge}`));
}
const exact = (item: Record<string, unknown>, names: string[]) =>
  Object.keys(item).sort().join('|') === [...names].sort().join('|');
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// This is a consumer of a future trusted service, not a provider verifier or SQL lookup.
// Only the private binding may supply evidence. No caller JSON or raw proof is returned.
export async function recoverUninstall(
  env: RecoveryEnvironment,
  expected: RecoveryExpectation,
  clock: () => number = Date.now
): Promise<boolean> {
  if (!env.STAGING_UNINSTALL_RECOVERY || !env.STAGING_UNINSTALL_RECOVERY_HMAC_KEY) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    work({
      eventHash: expected.eventHash,
      installationHash: expected.installationHash,
      occurredAt: expected.occurredAt,
      requestId: expected.requestId,
    });
    bytes(expected.challenge, 32);
    const now = clock();
    if (
      !uuid(expected.tombstoneId) ||
      !uuid(expected.recoveryGeneration) ||
      !uuid(expected.recoveryRequestId) ||
      !Number.isSafeInteger(expected.tombstonedAt) ||
      expected.tombstonedAt <= 0 ||
      expected.tombstonedAt > now ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(expected.challengeExpiresAt) ||
      expected.challengeExpiresAt <= now ||
      !Number.isSafeInteger(expected.githubAppId) ||
      expected.githubAppId < 1 ||
      !/^[1-9][0-9]*$/.test(expected.providerInstallationId) ||
      !Number.isSafeInteger(Number(expected.providerInstallationId)) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(expected.applicationId) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(expected.deployment)
    )
      return false;
    const key = env.STAGING_UNINSTALL_RECOVERY_HMAC_KEY;
    const raw = JSON.stringify({ schemaVersion: 1, ...expected });
    const request = new Request('http://uninstall.bugdrop.localhost/verify-uninstall-recovery', {
      method: 'POST',
      signal: controller.signal,
      body: raw,
      headers: {
        'Content-Type': 'application/json',
        'X-BugDrop-Recovery-Signature': await hmac(
          key,
          utf8(`bugdrop:uninstall:recovery-request:v1\0${raw}`)
        ),
      },
    });
    return await Promise.race([
      (async () => {
        const response = await env.STAGING_UNINSTALL_RECOVERY!.fetch(request);
        if (response.status !== 200 || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return false;
        }
        reader = response.body?.getReader();
        const body = new Uint8Array(2048);
        let size = 0;
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          if (size + part.value.length > body.length) return false;
          body.set(part.value, size);
          size += part.value.length;
        }
        const proofBytes = body.slice(0, size);
        const prefix = utf8('bugdrop:uninstall:recovery-receipt:v1\0');
        const signed = new Uint8Array(prefix.length + size);
        signed.set(prefix);
        signed.set(proofBytes, prefix.length);
        if (
          !(await verifyHmac(
            key,
            signed,
            response.headers.get('X-BugDrop-Recovery-Signature') ?? ''
          ))
        )
          return false;
        const proof = record(json(proofBytes));
        const receivedAt = clock();
        if (
          !exact(proof, [
            'schemaVersion',
            ...Object.keys(expected),
            'verifiedAt',
            'providerRemoved',
            'mappingConfirmed',
            'internalMapping',
          ]) ||
          proof.schemaVersion !== 1 ||
          Object.entries(expected).some(([name, value]) => proof[name] !== value) ||
          proof.providerRemoved !== true ||
          proof.mappingConfirmed !== true ||
          typeof proof.verifiedAt !== 'number' ||
          !Number.isSafeInteger(proof.verifiedAt) ||
          !Number.isSafeInteger(receivedAt) ||
          receivedAt >= expected.challengeExpiresAt ||
          proof.verifiedAt > receivedAt ||
          receivedAt - proof.verifiedAt > 30_000
        )
          return false;
        const mapping = record(proof.internalMapping);
        return (
          exact(mapping, ['applicationId', 'installationId']) &&
          uuid(mapping.applicationId) &&
          mapping.applicationId === expected.applicationId &&
          uuid(mapping.installationId)
        );
      })(),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          resolve(false);
        }, 2000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}
