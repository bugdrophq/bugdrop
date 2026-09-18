import type { PendingWork } from './pending-work';
import {
  outcomeCommand,
  outcomeHash,
  outcomeLive,
  outcomeObject,
  outcomeReject,
} from './outcome-command';
import {
  boundedOutcome,
  dispatchOutcome,
  type OutcomeTransport,
  type OutcomeDispatch,
} from './outcome-dispatcher';

/** The existing P5 private interface is the sole source and owner of event/ack custody. */
export type OutcomePending = Pick<PendingWork, 'read' | 'acknowledge'>;
export type OutcomeConsumption =
  Exclude<OutcomeDispatch, { state: 'accepted' }> | { state: 'acknowledged' };

export async function consumeOutcome(
  event: string,
  pending: OutcomePending,
  transport?: OutcomeTransport,
  now = () => Date.now(),
  parent?: AbortSignal
): Promise<OutcomeConsumption> {
  if (!outcomeHash.test(event)) return { state: 'quarantined' };
  try {
    return await boundedOutcome(async signal => {
      const original = await pending.read(event);
      if (signal.aborted) outcomeReject();
      let command;
      try {
        outcomeObject(original, ['state', 'command']);
        command = outcomeCommand(original.command);
        const a = command.arguments;
        if (
          !['pending', 'acknowledged'].includes(original.state) ||
          a[5] !== event ||
          a[9] !== 'authorized' ||
          a[10] !== 'none' ||
          a[15] !== null ||
          a[16] !== 2
        )
          outcomeReject();
      } catch {
        return { state: 'quarantined' };
      }
      if (!outcomeLive(command, now())) return { state: 'expired' };
      if (original.state === 'acknowledged') return { state: 'acknowledged' };
      const sent = await dispatchOutcome(command, transport, now, signal);
      if (signal.aborted) outcomeReject();
      if (sent.state !== 'accepted') return sent;
      // Re-read after SQL before asserting acceptance of the exact original immutable tuple.
      const current = await pending.read(event);
      if (signal.aborted) outcomeReject();
      outcomeObject(current, ['state', 'command']);
      if (
        !['pending', 'acknowledged'].includes(current.state) ||
        JSON.stringify(outcomeCommand(current.command)) !== JSON.stringify(command)
      )
        return { state: 'quarantined' };
      if (!outcomeLive(command, now())) return { state: 'expired' };
      await pending.acknowledge(event, { eventHash: event, accepted: true });
      if (signal.aborted) outcomeReject();
      return { state: 'acknowledged' };
    }, parent);
  } catch {
    return { state: 'pending' };
  }
}
