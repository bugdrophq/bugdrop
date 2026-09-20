import type { Env } from '../types';
import { installationUsageEnabled } from './installation-usage';
import {
  handleInstallationAlarm,
  handleInstallationDeletion,
  handleInstallationIncrement,
  handleInstallationPurge,
} from './installation-feedback-counter';

const COUNTER_OBJECT_NAME = 'global-feedback-issues-created';
const COUNTER_STORAGE_KEY = 'total';
const RECENT_EVENT_IDS_STORAGE_KEY = 'recentEventIds';
const MAX_RECENT_EVENT_IDS = 1024;
const MAX_INCREMENT_ATTEMPTS = 3;
const PUBLIC_BUCKET_SIZE = 100;
const INSTALLATION_COUNTER_OBJECT_PREFIX = 'installation-feedback:';

type WaitUntilContext = {
  readonly executionCtx: Pick<ExecutionContext, 'waitUntil'>;
};

export class FeedbackCounter {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'POST' && pathname === '/increment') {
      const eventId = await parseEventId(request);
      if (!eventId) return Response.json({ error: 'Invalid event ID' }, { status: 400 });

      const total = await this.state.storage.transaction(async transaction => {
        const current = await transaction.get<number>(COUNTER_STORAGE_KEY);
        const recentEventIds =
          (await transaction.get<string[]>(RECENT_EVENT_IDS_STORAGE_KEY)) ?? [];
        if (recentEventIds.includes(eventId)) {
          return current ?? getFeedbackCountBaseline(this.env);
        }

        const next = (current ?? getFeedbackCountBaseline(this.env)) + 1;
        await transaction.put(COUNTER_STORAGE_KEY, next);
        await transaction.put(
          RECENT_EVENT_IDS_STORAGE_KEY,
          [...recentEventIds, eventId].slice(-MAX_RECENT_EVENT_IDS)
        );
        return next;
      });
      return Response.json({ total });
    }

    if (request.method === 'POST' && pathname === '/installation/increment') {
      return handleInstallationIncrement(this.state, this.env, request);
    }

    if (request.method === 'POST' && pathname === '/installation/delete') {
      return handleInstallationDeletion(this.state);
    }

    if (request.method === 'POST' && pathname === '/installation/purge') {
      return handleInstallationPurge(this.state);
    }

    if (request.method === 'GET' && pathname === '/total') {
      const total =
        (await this.state.storage.get<number>(COUNTER_STORAGE_KEY)) ??
        getFeedbackCountBaseline(this.env);
      return Response.json({ total });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await handleInstallationAlarm(this.state, this.env);
  }
}

export function scheduleSuccessfulFeedbackCount(
  env: Env,
  repo: string,
  context?: WaitUntilContext,
  installationId?: number
): void {
  if (!env.FEEDBACK_COUNTER) return;

  const eventId = crypto.randomUUID();
  const tasks: Promise<void>[] = [];
  if (!isExcludedFromFeedbackCount(env, repo)) tasks.push(incrementFeedbackCount(env, eventId));
  if (
    installationUsageEnabled(env) &&
    Number.isSafeInteger(installationId) &&
    (installationId as number) > 0
  ) {
    tasks.push(incrementInstallationFeedbackCount(env, installationId as number, eventId));
  }
  if (tasks.length === 0) return;
  const task = Promise.allSettled(tasks)
    .then(results => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) throw failure.reason;
    })
    .catch(error => {
      console.error('[BugDrop] Failed to record successful feedback count:', error);
      throw error;
    });

  try {
    if (context) {
      context.executionCtx.waitUntil(task);
    } else {
      void task.catch(() => undefined);
    }
  } catch {
    // Hono unit tests do not provide an ExecutionContext. The task has already
    // started; prevent an unhandled rejection when no runtime can observe it.
    void task.catch(() => undefined);
  }
}

export async function deleteInstallationFeedbackCounter(
  env: Env,
  installationId: number
): Promise<void> {
  if (!env.FEEDBACK_COUNTER) throw new Error('Feedback counter binding is unavailable');
  const response = await getInstallationCounterStub(env, installationId).fetch(
    'https://feedback-counter/installation/delete',
    { method: 'POST' }
  );
  if (!response.ok) {
    throw new Error(`Installation feedback counter deletion failed with ${response.status}`);
  }
}

export async function purgeInstallationFeedbackCounter(
  env: Env,
  installationId: number
): Promise<void> {
  if (!env.FEEDBACK_COUNTER) throw new Error('Feedback counter binding is unavailable');
  const response = await getInstallationCounterStub(env, installationId).fetch(
    'https://feedback-counter/installation/purge',
    { method: 'POST' }
  );
  if (!response.ok) {
    throw new Error(`Installation feedback counter purge failed with ${response.status}`);
  }
}

export async function getPublicFeedbackCount(env: Env): Promise<number | null> {
  if (!env.FEEDBACK_COUNTER) {
    return env.FEEDBACK_COUNT_BASELINE === undefined
      ? null
      : roundFeedbackCount(getFeedbackCountBaseline(env));
  }

  const response = await getCounterStub(env).fetch('https://feedback-counter/total');
  if (!response.ok) throw new Error(`Feedback counter read failed with ${response.status}`);
  const body = (await response.json()) as { total?: unknown };
  if (!Number.isSafeInteger(body.total) || (body.total as number) < 0) {
    throw new Error('Feedback counter returned an invalid total');
  }
  return roundFeedbackCount(body.total as number);
}

export function getFeedbackCountBaseline(env: Env): number {
  const rawBaseline = env.FEEDBACK_COUNT_BASELINE ?? '0';
  if (!/^\d+$/.test(rawBaseline)) return 0;
  const baseline = Number.parseInt(rawBaseline, 10);
  return Number.isSafeInteger(baseline) && baseline >= 0 ? baseline : 0;
}

export function roundFeedbackCount(total: number): number {
  return Math.floor(total / PUBLIC_BUCKET_SIZE) * PUBLIC_BUCKET_SIZE;
}

export function isExcludedFromFeedbackCount(env: Env, repo: string): boolean {
  const [owner] = repo.split('/');
  if (!owner) return true;
  const excludedOwners = new Set(
    (env.FEEDBACK_COUNT_EXCLUDED_OWNERS ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
  return excludedOwners.has(owner.toLowerCase());
}

async function incrementFeedbackCount(env: Env, eventId: string): Promise<void> {
  const stub = getCounterStub(env);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  };
  await sendCounterIncrementWithRetries(
    () => stub.fetch('https://feedback-counter/increment', init),
    'Feedback counter increment'
  );
}

async function incrementInstallationFeedbackCount(
  env: Env,
  installationId: number,
  eventId: string
): Promise<void> {
  const stub = getInstallationCounterStub(env, installationId);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, installationId }),
  };
  await sendCounterIncrementWithRetries(
    () => stub.fetch('https://feedback-counter/installation/increment', init),
    'Installation feedback counter increment'
  );
}

async function sendCounterIncrementWithRetries(
  send: () => Promise<Response>,
  failureLabel: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_INCREMENT_ATTEMPTS; attempt += 1) {
    try {
      const response = await send();
      if (!response.ok) throw new Error(`${failureLabel} failed with ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${failureLabel} failed`);
}

async function parseEventId(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { eventId?: unknown };
    return typeof body.eventId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.eventId
      )
      ? body.eventId
      : null;
  } catch {
    return null;
  }
}

function getCounterStub(env: Env): DurableObjectStub {
  const namespace = env.FEEDBACK_COUNTER;
  if (!namespace) throw new Error('Feedback counter binding is unavailable');
  return namespace.get(namespace.idFromName(COUNTER_OBJECT_NAME));
}

function getInstallationCounterStub(env: Env, installationId: number): DurableObjectStub {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error('Invalid installation ID');
  }
  const namespace = env.FEEDBACK_COUNTER;
  if (!namespace) throw new Error('Feedback counter binding is unavailable');
  return namespace.get(
    namespace.idFromName(`${INSTALLATION_COUNTER_OBJECT_PREFIX}${installationId}`)
  );
}
