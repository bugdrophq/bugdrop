import {
  encodeOutcome,
  outcomeCommand,
  outcomeLive,
  outcomeObject,
  outcomeReject,
  type OutcomeCommand,
} from './outcome-command';
import { strictJson } from './protocol';

/** Private authenticated port, supplied by a separately qualified adapter. No network fallback. */
export type OutcomeTransport = (body: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
export type OutcomeDispatch =
  | { state: 'accepted'; result: 'applied' | 'duplicate' }
  | { state: 'pending' | 'quarantined' | 'expired' | 'deleted' };

/** One fixed total budget; aborted/late operations cannot continue into acknowledgement. */
export async function boundedOutcome<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      controller.abort();
      reject(new Error('outcome_unavailable'));
    };
    parent?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, 2000);
  });
  try {
    if (parent?.aborted) stop();
    return await Promise.race([
      aborted,
      (async () => {
        if (controller.signal.aborted) outcomeReject();
        return operation(controller.signal);
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', stop);
    controller.abort();
  }
}
export async function dispatchOutcome(
  input: OutcomeCommand,
  transport?: OutcomeTransport,
  now = () => Date.now(),
  parent?: AbortSignal
): Promise<OutcomeDispatch> {
  let command: OutcomeCommand;
  try {
    command = outcomeCommand(input);
  } catch {
    return { state: 'quarantined' };
  }
  try {
    if (!outcomeLive(command, now())) return { state: 'expired' };
    if (!transport) return { state: 'pending' };
    return await boundedOutcome(async signal => {
      const raw = await transport(encodeOutcome(command), signal);
      if (signal.aborted) outcomeReject();
      if (!outcomeLive(command, now())) return { state: 'expired' };
      const receipt = outcomeObject(strictJson(raw, 256), ['schemaVersion', 'eventHash', 'result']);
      if (receipt.schemaVersion !== 2 || receipt.eventHash !== command.arguments[5])
        outcomeReject();
      if (receipt.result === 'applied' || receipt.result === 'duplicate')
        return { state: 'accepted', result: receipt.result };
      if (receipt.result === 'expired' || receipt.result === 'deleted')
        return { state: receipt.result };
      if (receipt.result === 'rejected') return { state: 'quarantined' };
      outcomeReject();
    }, parent);
  } catch {
    return { state: 'pending' };
  }
}
