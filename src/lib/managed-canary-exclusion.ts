import type { Env } from '../types';

/** Deny the opted-in hosted canary on the public API, including provider-resolved aliases. */
export function managedCanaryBlocked(env: Env, owner: string, installation?: unknown): boolean {
  const enabled = env.MANAGED_CANARY_EXCLUSION_ENABLED;
  if (enabled === undefined || enabled === '0') return false;
  if (enabled !== '1' || env.GITHUB_APP_ID !== '2508027') return true;
  if (owner.toLowerCase() === 'jermwattml-svg') return true;
  if (installation === undefined) return false;
  if (!installation || typeof installation !== 'object') return true;
  const account = (installation as { account?: unknown }).account;
  if (!account || typeof account !== 'object') return true;
  const id = (account as { id?: unknown }).id;
  return typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id === 335115387;
}
