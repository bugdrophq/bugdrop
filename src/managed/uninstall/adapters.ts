import { hmac, utf8 } from '../local/protocol';
import { edgeReceipt, sqlReceipt, type SignedProof, type UninstallWork } from './contracts';

export interface UninstallAdapters {
  STAGING_CONTROL: Fetcher;
  STAGING_RECONCILIATION: Fetcher;
  STAGING_UNINSTALL_HMAC_KEY: string;
  STAGING_RECONCILIATION_HMAC_KEY: string;
  STAGING_APPLICATION_ID: string;
}
async function exchange(
  service: Fetcher,
  path: string,
  body: unknown,
  key: string,
  domain: string,
  responseHeader: string
): Promise<SignedProof | null> {
  const raw = utf8(JSON.stringify(body));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const request = new Request(`http://uninstall.bugdrop.localhost${path}`, {
    method: 'POST',
    body: raw,
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'X-BugDrop-Control-Signature': await hmac(
        key,
        domain ? utf8(`${domain}\0${new TextDecoder().decode(raw)}`) : raw
      ),
    },
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await service.fetch(request);
        if (response.status !== 200 || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        reader = response.body?.getReader();
        const bytes = new Uint8Array(2048);
        let size = 0;
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (size + chunk.value.length > bytes.length) return null;
          bytes.set(chunk.value, size);
          size += chunk.value.length;
        }
        return { raw: bytes.slice(0, size), signature: response.headers.get(responseHeader) ?? '' };
      })(),
      new Promise<null>(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          resolve(null);
        }, 2000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    // Cancellation also covers oversized bodies and transports that ignore AbortSignal.
    void reader?.cancel().catch(() => {});
  }
}
export async function applyEdge(env: UninstallAdapters, installationId: string): Promise<boolean> {
  const proof = await exchange(
    env.STAGING_CONTROL,
    '/revoke-installation',
    { schemaVersion: 1, installationId },
    env.STAGING_UNINSTALL_HMAC_KEY,
    '',
    'X-BugDrop-Uninstall-Receipt-Signature'
  );
  return (
    proof !== null &&
    edgeReceipt(proof, env.STAGING_UNINSTALL_HMAC_KEY, env.STAGING_APPLICATION_ID, installationId)
  );
}
export async function applySql(
  env: UninstallAdapters,
  item: UninstallWork,
  installationId: string
): Promise<'applied' | 'pending' | 'quarantined'> {
  // A private adapter implements the data owner's authoritative SQL contract.
  // This binding is not a PostgREST endpoint or an alternative SQL RPC.
  const proof = await exchange(
    env.STAGING_RECONCILIATION,
    '/apply-verified-uninstall',
    { schemaVersion: 1, installationId, ...item },
    env.STAGING_RECONCILIATION_HMAC_KEY,
    'bugdrop:uninstall:sql-request:v1',
    'X-BugDrop-Uninstall-Receipt-Signature'
  );
  return proof
    ? sqlReceipt(proof, env.STAGING_RECONCILIATION_HMAC_KEY, item, installationId)
    : 'pending';
}
