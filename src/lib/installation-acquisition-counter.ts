import type { Env } from '../types';
import { acquisitionDayExpiresAt, isCanonicalDate } from './installation-acquisition';

const DAY_KEY = 'acquisitionDay';
const TOTAL_KEY = 'acquisitionTotal';
const START_KEY = 'acquisitionStart';
const RECEIPT_PREFIX = 'acquisitionReceipt:';
const MIRROR_DELAY_MS = 2_000;

interface Increment {
  day: string;
  receipt: string;
  coverageStartedAt: string;
}

export async function handleAcquisitionIncrement(
  state: DurableObjectState,
  env: Env,
  request: Request
): Promise<Response> {
  const input = await parseIncrement(request);
  if (!input) return Response.json({ error: 'Invalid acquisition increment' }, { status: 400 });
  if (!env.INSTALLATION_ANALYTICS) return new Response(null, { status: 503 });

  return state.blockConcurrencyWhile(async () => {
    // Recheck inside the serialized operation, including a request delayed across expiry.
    if (Date.now() >= acquisitionDayExpiresAt(input.day)) {
      return Response.json({ error: 'Acquisition window closed' }, { status: 409 });
    }
    const day = await state.storage.get<string>(DAY_KEY);
    const start = await state.storage.get<string>(START_KEY);
    if ((day && day !== input.day) || (start && start !== input.coverageStartedAt)) {
      return new Response(null, { status: 409 });
    }
    await state.storage.transaction(async transaction => {
      const nextAlarm = Date.now() + MIRROR_DELAY_MS;
      const alarm = await transaction.getAlarm();
      if (alarm === null || alarm > nextAlarm) await transaction.setAlarm(nextAlarm);
      const receiptKey = `${RECEIPT_PREFIX}${input.receipt}`;
      if (await transaction.get(receiptKey)) return;
      const current = (await transaction.get<number>(TOTAL_KEY)) ?? 0;
      if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid acquisition total');
      }
      await transaction.put(DAY_KEY, input.day);
      await transaction.put(START_KEY, input.coverageStartedAt);
      await transaction.put(TOTAL_KEY, current + 1);
      await transaction.put(receiptKey, true);
    });
    return new Response(null, { status: 204 });
  });
}

// Returns false for the existing feedback counters, which keep their own alarm behavior.
export async function handleAcquisitionAlarm(
  state: DurableObjectState,
  env: Env
): Promise<boolean> {
  return state.blockConcurrencyWhile(async () => {
    const day = await state.storage.get<string>(DAY_KEY);
    if (!day) return false;
    const expiresAt = acquisitionDayExpiresAt(day);
    const cleanupDue = Date.now() >= expiresAt;
    try {
      if (cleanupDue) {
        // The closed acceptance window prevents replay after opaque receipts are erased.
        let receipts = await state.storage.list({ prefix: RECEIPT_PREFIX, limit: 128 });
        while (receipts.size > 0) {
          await state.storage.delete([...receipts.keys()]);
          receipts = await state.storage.list({ prefix: RECEIPT_PREFIX, limit: 128 });
        }
      }
      if (!env.INSTALLATION_ANALYTICS) throw new Error('Installation analytics is unavailable');
      await env.INSTALLATION_ANALYTICS.put(
        `acquisition:daily:${day}`,
        JSON.stringify({
          schemaVersion: 1,
          date: day,
          installations: await state.storage.get<number>(TOTAL_KEY),
          coverageStartedAt: await state.storage.get<string>(START_KEY),
          updatedAt: new Date().toISOString(),
        })
      );
      // Publication may cross expiry after the cleanup check. Still schedule cleanup.
      if (!cleanupDue) await state.storage.setAlarm(Math.max(expiresAt, Date.now() + 1));
    } catch (error) {
      await state.storage.setAlarm(Date.now() + 60_000);
      throw error;
    }
    return true;
  });
}

async function parseIncrement(request: Request): Promise<Increment | null> {
  try {
    const body = (await request.json()) as Partial<Increment>;
    if (
      !body ||
      typeof body.day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.day) ||
      !isCanonicalDate(`${body.day}T00:00:00.000Z`) ||
      typeof body.receipt !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.receipt) ||
      !isCanonicalDate(body.coverageStartedAt) ||
      body.day < body.coverageStartedAt.slice(0, 10) ||
      body.day > new Date().toISOString().slice(0, 10)
    )
      return null;
    return body as Increment;
  } catch {
    return null;
  }
}
