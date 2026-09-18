import { decodeOutcome, encodeOutcome } from './outcome-command';
import { boundedOutcome } from './outcome-dispatcher';
import { outcomeSqlTransport, type OutcomeSqlExecutor } from './outcome-sql';
import { controlMac, verifyControlMac, type ControlEnvelope } from './current-control';
import { uuid } from './protocol';
import type { SourcePin } from './current-selection';
import type { OriginalScope } from './protocol';

export interface OutcomePeer {
  qualified: true;
  role: 'bugdrop-outcomes';
  keyId: string;
  pin: SourcePin;
  scope: OriginalScope;
  deploymentDigest: string;
  requestKey: Uint8Array;
  receiptKey: Uint8Array;
}
export type SignedOutcomeReceipt = ControlEnvelope;

function unavailable(): never {
  throw new Error('outcome_unavailable');
}
const base64url = (value: Uint8Array): string =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

/**
 * Private P6 receiver boundary. The peer resolver must authenticate the caller and
 * pin the original source epoch, role and scope; the command cannot select a peer.
 * No receiver route, key store, SQL connection or retry policy is installed here.
 */
export async function executeScopedOutcome(
  request: ControlEnvelope,
  resolvePeer: (keyId: string) => OutcomePeer | undefined,
  execute: OutcomeSqlExecutor,
  signal: AbortSignal,
  now = () => Date.now()
): Promise<SignedOutcomeReceipt> {
  try {
    return await boundedOutcome(async boundedSignal => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.keyId)) unavailable();
      const peer = resolvePeer(request.keyId);
      if (
        !peer ||
        peer.qualified !== true ||
        peer.role !== 'bugdrop-outcomes' ||
        peer.keyId !== request.keyId ||
        peer.pin.realm !== 'staging' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(peer.pin.sourceId) ||
        !uuid.test(peer.pin.sourceEpoch) ||
        peer.deploymentDigest !== peer.scope.deploymentDigest ||
        !/^[0-9a-f]{64}$/.test(peer.deploymentDigest) ||
        peer.requestKey.length !== 32 ||
        peer.receiptKey.length !== 32 ||
        boundedSignal.aborted
      )
        unavailable();
      let distinct = 0;
      for (let i = 0; i < 32; i++) distinct |= peer.requestKey[i] ^ peer.receiptKey[i];
      if (!distinct) unavailable();
      await verifyControlMac('outcome.execute', 'request', peer.requestKey, request);
      if (boundedSignal.aborted) unavailable();
      const command = decodeOutcome(request.raw);
      const canonical = encodeOutcome(command);
      if (
        canonical.length !== request.raw.length ||
        canonical.some((byte, index) => byte !== request.raw[index])
      )
        unavailable();
      const args = command.arguments;
      const scope = peer.scope;
      if (
        args[0] !== scope.tenantId ||
        args[1] !== scope.applicationId ||
        args[2] !== scope.installationGeneration ||
        args[3] !== scope.destinationId ||
        args[4] !== scope.credentialId ||
        args[9] !== 'authorized' ||
        args[10] !== 'none' ||
        args[15] !== null ||
        args[16] !== 2
      )
        unavailable();
      const raw = await outcomeSqlTransport(execute, now)(request.raw, boundedSignal);
      if (boundedSignal.aborted) unavailable();
      // outcomeSqlTransport emits applied/duplicate only for an executor result whose
      // committed:true envelope is returned after confirmed COMMIT. Unknown rejects.
      const receipt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      const value = JSON.parse(receipt) as {
        schemaVersion?: unknown;
        eventHash?: unknown;
        result?: unknown;
      };
      if (
        value.schemaVersion !== 2 ||
        value.eventHash !== args[5] ||
        !['applied', 'duplicate', 'expired', 'deleted', 'rejected'].includes(value.result as string)
      )
        unavailable();
      const mac = base64url(await controlMac('outcome.execute', 'receipt', peer.receiptKey, raw));
      if (boundedSignal.aborted) unavailable();
      return {
        raw,
        keyId: request.keyId,
        mac,
      };
    }, signal);
  } catch {
    return unavailable();
  }
}
