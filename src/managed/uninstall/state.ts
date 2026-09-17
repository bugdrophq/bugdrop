import type { UninstallWork } from './contracts';
export const retention = 30 * 86_400_000;
export const delays = [1000, 5000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
interface Acknowledgements extends UninstallWork {
  edgeAcknowledged: boolean;
  sqlAcknowledged: boolean;
  continuationId?: string;
  recoveryRequestId?: string;
}
export interface Pending extends Acknowledgements {
  state: 'pending';
  recoveryTombstonedAt?: number;
  recoveryTombstoneId?: string;
  cycleStartedAt: number;
  sqlQuarantined: boolean;
  attempts: number;
  nextAttemptAt: number;
  completedAt: number | null;
}
export interface Tombstone extends Acknowledgements {
  state: 'operator_action_required';
  tombstoneId: string;
  tombstonedAt: number;
  failureCode: 'retention_deadline';
  recoveryAttempts: number;
  recoveryAttempt?: {
    generation: string;
    requestId: string;
    challengeHash: string;
    expiresAt: number;
  };
}
export type WorkState = Pending | Tombstone;
export function originalWork(item: UninstallWork): UninstallWork {
  return {
    eventHash: item.eventHash,
    installationHash: item.installationHash,
    requestId: item.requestId,
    occurredAt: item.occurredAt,
  };
}
export function tombstone(item: Pending): Tombstone {
  return {
    ...originalWork(item),
    state: 'operator_action_required',
    tombstoneId: crypto.randomUUID(),
    edgeAcknowledged: item.edgeAcknowledged,
    sqlAcknowledged: item.sqlAcknowledged,
    ...(item.continuationId ? { continuationId: item.continuationId } : {}),
    ...(item.recoveryRequestId ? { recoveryRequestId: item.recoveryRequestId } : {}),
    tombstonedAt: item.cycleStartedAt + retention,
    failureCode: 'retention_deadline',
    recoveryAttempts: 0,
  };
}
