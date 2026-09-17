import { hmac, json, readBounded, record, reject, utf8, verifyHmac } from '../local/protocol';
import { sqlReceipt, work, type UninstallWork } from './contracts';

export interface ReconciliationCommand extends UninstallWork {
  schemaVersion: 1;
  installationId: string;
}
/** The injected implementation calls the data owner's transactional SQL contract. */
export type ApplyVerifiedUninstall = (command: ReconciliationCommand) => Promise<unknown> | unknown;
export async function reconcileVerifiedUninstall(
  request: Request,
  scope: { installationId: string; key: string },
  apply: ApplyVerifiedUninstall
): Promise<Response> {
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/apply-verified-uninstall')
      reject();
    const raw = await readBounded(request, 2048);
    const message = utf8(`bugdrop:uninstall:sql-request:v1\0${new TextDecoder().decode(raw)}`);
    if (
      !(await verifyHmac(
        scope.key,
        message,
        request.headers.get('X-BugDrop-Control-Signature') ?? ''
      ))
    )
      reject();
    const input = record(json(raw));
    if (
      Object.keys(input).sort().join('|') !==
        'eventHash|installationHash|installationId|occurredAt|requestId|schemaVersion' ||
      input.schemaVersion !== 1 ||
      input.installationId !== scope.installationId ||
      !/^[1-9][0-9]{0,15}$/.test(scope.installationId) ||
      BigInt(scope.installationId) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      reject();
    const item = work({
      eventHash: input.eventHash,
      installationHash: input.installationHash,
      occurredAt: input.occurredAt,
      requestId: input.requestId,
    });
    const command: ReconciliationCommand = {
      schemaVersion: 1,
      installationId: scope.installationId,
      ...item,
    };
    const applied = record(await apply(command));
    const missing =
      Object.keys(applied).sort().join('|') === 'reason|state' &&
      applied.state === 'quarantined' &&
      applied.reason === 'mapping_missing';
    const result = missing ? { ...command, ...applied } : applied;
    const body = JSON.stringify(result);
    const signature = await hmac(scope.key, utf8(`bugdrop:uninstall:sql-receipt:v1\0${body}`));
    // Validate every returned field; never erase a private field to manufacture clean evidence.
    if (
      (await sqlReceipt({ raw: utf8(body), signature }, scope.key, item, scope.installationId)) ===
      'pending'
    )
      reject();
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-BugDrop-Uninstall-Receipt-Signature': signature,
      },
    });
  } catch {
    return Response.json({ error: 'uninstall_reconciliation_pending' }, { status: 503 });
  }
}
