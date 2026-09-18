import {
  decodeOutcome,
  outcomeLive,
  outcomeObject,
  outcomeReject,
  type OutcomeCommand,
} from './outcome-command';
import { boundedOutcome, type OutcomeTransport } from './outcome-dispatcher';
import { utf8 } from './protocol';

const statement = `SELECT private.ingest_outcome_v2(
  $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
  $6::private.receipt_hash,$7::private.receipt_hash,$8::timestamptz,$9::timestamptz,
  $10::private.delivery_state,$11::private.outcome_reason,$12::boolean,$13::uuid,
  $14::text,$15::text,$16::text,$17::smallint) AS result`;
/** Must execute as bugdrop_outcomes and resolve {committed:true,rows:[{result}]} only
 * after confirmed COMMIT. Query completion before COMMIT is not this contract.
 * Unknown commit must reject; cancellation is best-effort and never implies rollback. */
export type OutcomeSqlExecutor = (
  statement: string,
  parameters: OutcomeCommand['arguments'],
  signal: AbortSignal
) => Promise<unknown>;

/** In-process adapter only: no route, binding, login, connection or retry is provisioned here. */
export function outcomeSqlTransport(
  execute: OutcomeSqlExecutor,
  now = () => Date.now()
): OutcomeTransport {
  return async (body, parent) => {
    try {
      return await boundedOutcome(async signal => {
        const command = decodeOutcome(body),
          eventHash = command.arguments[5];
        const reply = (result: string) =>
          utf8(JSON.stringify({ schemaVersion: 2, eventHash, result }));
        if (!outcomeLive(command, now())) return reply('expired');
        let value: unknown;
        try {
          value = await execute(statement, [...command.arguments], signal);
        } catch (error) {
          if (signal.aborted) outcomeReject();
          // Only typed SQL constraint failures quarantine; private messages never cross the port.
          const code =
            error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (code === '23514' || code === '23503') return reply('rejected');
          outcomeReject();
        }
        if (signal.aborted) outcomeReject();
        if (!outcomeLive(command, now())) return reply('expired');
        const committed = outcomeObject(value, ['committed', 'rows']);
        if (
          committed.committed !== true ||
          !Array.isArray(committed.rows) ||
          committed.rows.length !== 1
        )
          outcomeReject();
        const row = outcomeObject(committed.rows[0], ['result']);
        if (!['applied', 'duplicate', 'expired', 'deleted'].includes(row.result as string))
          outcomeReject();
        return reply(row.result as string);
      }, parent);
    } catch {
      return outcomeReject();
    }
  };
}
