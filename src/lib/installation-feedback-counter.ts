import type { Env } from '../types';
import {
  deleteInstallationUsageRecord,
  installationIdentityExists,
  installationUsageEnabled,
  installationUsageWasDeleted,
  writeInstallationUsageRecord,
} from './installation-usage';

const COUNTER_KEY = 'total';
const EVENT_IDS_KEY = 'recentEventIds';
const INSTALLATION_ID_KEY = 'installationId';
const IDENTITY_CHECKS_REMAINING_KEY = 'identityChecksRemaining';
const DELETED_UNTIL_KEY = 'deletedUntil';
const MAX_RECENT_EVENT_IDS = 1024;
const MIRROR_DELAY_MS = 1_500;
const IDENTITY_RETRY_MS = 60_000;
const MAX_IDENTITY_CHECKS = 24 * 60;
const DELETION_GUARD_MS = 7 * 24 * 60 * 60 * 1_000;

export async function handleInstallationIncrement(
  state: DurableObjectState,
  env: Env,
  request: Request
): Promise<Response> {
  const input = await parseIncrement(request);
  if (!input) return Response.json({ error: 'Invalid increment' }, { status: 400 });
  const store = env.INSTALLATION_ANALYTICS;
  if (!installationUsageEnabled(env) || !store) {
    return Response.json({ error: 'Installation usage is unavailable' }, { status: 503 });
  }

  return state.blockConcurrencyWhile(async () => {
    if (await state.storage.get(DELETED_UNTIL_KEY)) {
      return Response.json({ error: 'Installation is inactive' }, { status: 409 });
    }
    if (await installationUsageWasDeleted(store, input.installationId)) {
      await purgeCounter(state, store, input.installationId);
      return Response.json({ error: 'Installation is inactive' }, { status: 409 });
    }

    const total = await state.storage.transaction(async transaction => {
      const current = (await transaction.get<number>(COUNTER_KEY)) ?? 0;
      const recentIds = (await transaction.get<string[]>(EVENT_IDS_KEY)) ?? [];
      if (recentIds.includes(input.eventId)) return current;
      if (!isNonnegativeInteger(current) || current === Number.MAX_SAFE_INTEGER) {
        throw new Error('Installation feedback counter is invalid');
      }
      const next = current + 1;
      await transaction.put(COUNTER_KEY, next);
      await transaction.put(INSTALLATION_ID_KEY, input.installationId);
      await transaction.put(
        EVENT_IDS_KEY,
        [...recentIds, input.eventId].slice(-MAX_RECENT_EVENT_IDS)
      );
      return next;
    });
    if ((await state.storage.get<number>(IDENTITY_CHECKS_REMAINING_KEY)) === undefined) {
      await state.storage.put(IDENTITY_CHECKS_REMAINING_KEY, MAX_IDENTITY_CHECKS);
    }
    if ((await state.storage.getAlarm()) === null) {
      await state.storage.setAlarm(Date.now() + MIRROR_DELAY_MS);
    }
    return Response.json({ total });
  });
}

export async function handleInstallationDeletion(state: DurableObjectState): Promise<Response> {
  return state.blockConcurrencyWhile(async () => {
    const deletedUntil = Date.now() + DELETION_GUARD_MS;
    await state.storage.put(DELETED_UNTIL_KEY, deletedUntil);
    await state.storage.delete([
      COUNTER_KEY,
      EVENT_IDS_KEY,
      INSTALLATION_ID_KEY,
      IDENTITY_CHECKS_REMAINING_KEY,
    ]);
    await state.storage.setAlarm(deletedUntil);
    return new Response(null, { status: 204 });
  });
}

export async function handleInstallationPurge(state: DurableObjectState): Promise<Response> {
  return state.blockConcurrencyWhile(async () => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
    return new Response(null, { status: 204 });
  });
}

export async function handleInstallationAlarm(state: DurableObjectState, env: Env): Promise<void> {
  await state.blockConcurrencyWhile(async () => {
    const deletedUntil = await state.storage.get<number>(DELETED_UNTIL_KEY);
    if (deletedUntil !== undefined) {
      if (deletedUntil > Date.now()) await state.storage.setAlarm(deletedUntil);
      else await state.storage.deleteAll();
      return;
    }

    const installationId = await state.storage.get<number>(INSTALLATION_ID_KEY);
    const total = await state.storage.get<number>(COUNTER_KEY);
    if (!isPositiveInteger(installationId) || !isNonnegativeInteger(total)) return;
    try {
      const store = env.INSTALLATION_ANALYTICS;
      if (!store) throw new Error('Installation analytics binding is unavailable');
      if (await installationUsageWasDeleted(store, installationId)) {
        await purgeCounter(state, store, installationId);
        return;
      }
      if (!(await installationIdentityExists(store, installationId))) {
        const checksRemaining =
          (await state.storage.get<number>(IDENTITY_CHECKS_REMAINING_KEY)) ?? MAX_IDENTITY_CHECKS;
        if (isPositiveInteger(checksRemaining)) {
          await state.storage.put(IDENTITY_CHECKS_REMAINING_KEY, checksRemaining - 1);
          await state.storage.setAlarm(Date.now() + IDENTITY_RETRY_MS);
        } else {
          await purgeCounter(state, store, installationId);
        }
        return;
      }
      await writeInstallationUsageRecord(store, installationId, total);
      await state.storage.delete(IDENTITY_CHECKS_REMAINING_KEY);
    } catch (error) {
      await state.storage.setAlarm(Date.now() + MIRROR_DELAY_MS);
      throw error;
    }
  });
}

async function parseIncrement(
  request: Request
): Promise<{ eventId: string; installationId: number } | null> {
  try {
    const body = (await request.json()) as { eventId?: unknown; installationId?: unknown };
    if (
      typeof body.eventId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.eventId
      ) ||
      !isPositiveInteger(body.installationId)
    ) {
      return null;
    }
    return { eventId: body.eventId, installationId: body.installationId };
  } catch {
    return null;
  }
}

async function purgeCounter(
  state: DurableObjectState,
  store: KVNamespace,
  installationId: number
): Promise<void> {
  await deleteInstallationUsageRecord(store, installationId);
  await state.storage.delete([
    COUNTER_KEY,
    EVENT_IDS_KEY,
    INSTALLATION_ID_KEY,
    IDENTITY_CHECKS_REMAINING_KEY,
  ]);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
