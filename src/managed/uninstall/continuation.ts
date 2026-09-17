import { encode, reject } from '../local/protocol';
import { recoverUninstall, hashRecoveryChallenge, type RecoveryEnvironment } from './recovery';
import { originalWork, type Pending, type WorkState } from './state';
import { routingSnapshot, type RoutingEnvironment } from './routing';

interface ContinuationStore {
  read(): WorkState | undefined;
  // Replace must run in one synchronous storage transaction.
  replace(item: WorkState): void;
  sync(): Promise<void>;
  now(): number;
}
export async function continueUninstall(
  store: ContinuationStore,
  env: RecoveryEnvironment & RoutingEnvironment,
  config: () => { appId: number; installationId: number },
  requestId: unknown,
  tombstonedAt: unknown,
  tombstoneId: unknown
): Promise<void> {
  if (
    typeof tombstoneId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tombstoneId) ||
    typeof tombstonedAt !== 'number' ||
    !Number.isSafeInteger(tombstonedAt) ||
    tombstonedAt <= 0 ||
    typeof requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
  )
    reject();
  const recoveryEnv: RecoveryEnvironment = Object.freeze({
    STAGING_UNINSTALL_RECOVERY: env.STAGING_UNINSTALL_RECOVERY,
    STAGING_UNINSTALL_RECOVERY_HMAC_KEY: env.STAGING_UNINSTALL_RECOVERY_HMAC_KEY,
  });
  const route = await routingSnapshot(env, config());
  const matches = () =>
    route.matches(env, config()) &&
    env.STAGING_UNINSTALL_RECOVERY === recoveryEnv.STAGING_UNINSTALL_RECOVERY &&
    env.STAGING_UNINSTALL_RECOVERY_HMAC_KEY === recoveryEnv.STAGING_UNINSTALL_RECOVERY_HMAC_KEY;
  if (!matches()) reject();
  let item = store.read();
  if (!item || item.routingHash !== route.hash) reject();
  if (
    item?.state === 'pending' &&
    item.recoveryRequestId === requestId &&
    item.recoveryTombstonedAt === tombstonedAt &&
    item.recoveryTombstoneId === tombstoneId
  )
    return;
  if (
    !item ||
    item.state !== 'operator_action_required' ||
    item.tombstonedAt !== tombstonedAt ||
    item.tombstoneId !== tombstoneId ||
    item.routingHash !== route.hash ||
    !matches() ||
    item.recoveryRequestId === requestId ||
    !env.STAGING_UNINSTALL_RECOVERY ||
    !env.STAGING_UNINSTALL_RECOVERY_HMAC_KEY ||
    item.recoveryAttempts >= 8 ||
    (item.recoveryAttempt && item.recoveryAttempt.expiresAt > store.now())
  )
    reject();
  const challenge = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeHash = await hashRecoveryChallenge(challenge);
  // Recheck after hashing; a competing continuation cannot overwrite a live attempt.
  item = store.read();
  if (
    !item ||
    item.state !== 'operator_action_required' ||
    item.tombstonedAt !== tombstonedAt ||
    item.tombstoneId !== tombstoneId ||
    item.routingHash !== route.hash ||
    !matches() ||
    item.recoveryAttempts >= 8 ||
    (item.recoveryAttempt && item.recoveryAttempt.expiresAt > store.now())
  )
    reject();
  const attempt = {
    generation: crypto.randomUUID(),
    requestId,
    challengeHash,
    expiresAt: store.now() + 30_000,
  };
  item.recoveryAttempts++;
  item.recoveryAttempt = attempt;
  store.replace(item);
  await store.sync();
  if (!matches()) reject();
  const accepted = await recoverUninstall(
    recoveryEnv,
    {
      ...originalWork(item),
      deployment: 'staging',
      githubAppId: route.githubAppId,
      applicationId: route.adapters.STAGING_APPLICATION_ID,
      providerInstallationId: route.installationId,
      routingHash: route.hash,
      tombstonedAt: item.tombstonedAt,
      tombstoneId: item.tombstoneId,
      challenge,
      challengeExpiresAt: attempt.expiresAt,
      recoveryGeneration: attempt.generation,
      recoveryRequestId: requestId,
    },
    () => store.now()
  );
  if (!accepted) reject();
  const current = store.read();
  if (
    !current ||
    current.state !== 'operator_action_required' ||
    current.tombstonedAt !== tombstonedAt ||
    current.tombstoneId !== tombstoneId ||
    current.routingHash !== route.hash ||
    !matches() ||
    current.recoveryAttempt?.generation !== attempt.generation ||
    current.recoveryAttempt.challengeHash !== challengeHash ||
    attempt.expiresAt <= store.now()
  )
    reject();
  const pending: Pending = {
    ...originalWork(current),
    routingHash: current.routingHash,
    state: 'pending',
    edgeAcknowledged: current.edgeAcknowledged,
    sqlAcknowledged: current.sqlAcknowledged,
    cycleStartedAt: store.now(),
    continuationId: attempt.generation,
    recoveryRequestId: requestId,
    recoveryTombstonedAt: tombstonedAt,
    recoveryTombstoneId: tombstoneId,
    attempts: 0,
    sqlQuarantined: false,
    nextAttemptAt: store.now(),
    completedAt: null,
  };
  // Replacement consumes the challenge and creates its linked cycle in one transaction.
  store.replace(pending);
  await store.sync();
}
