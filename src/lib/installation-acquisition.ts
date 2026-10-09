import type { Env } from '../types';
import type { NewInstallationRecord } from './installation-analytics';

const DAY_MS = 86_400_000;
const RECEIPT_WINDOW_DAYS = 30;
const OBJECT_PREFIX = 'installation-acquisition:';

export function acquisitionDayExpiresAt(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) + (RECEIPT_WINDOW_DAYS + 1) * DAY_MS;
}

// Called only for signature-verified installation.created payloads, never reconciliation.
export async function countInstallationCreated(
  env: Env,
  installation: NewInstallationRecord
): Promise<void> {
  if (!env.INSTALLATION_ACQUISITION_STARTED_AT) return;
  const start = env.INSTALLATION_ACQUISITION_STARTED_AT;
  const secret = env.INSTALLATION_ACQUISITION_HMAC_SECRET;
  if (
    !isCanonicalDate(start) ||
    !secret ||
    secret.length < 32 ||
    !env.FEEDBACK_COUNTER ||
    !env.INSTALLATION_ANALYTICS
  ) {
    throw new Error('Installation acquisition is not configured');
  }
  const createdAt = installation.installedAt;
  if (!isCanonicalDate(createdAt)) throw new Error('Invalid installation creation time');
  const day = createdAt.slice(0, 10);
  const now = Date.now();
  if (createdAt < start || now >= acquisitionDayExpiresAt(day)) return;
  if (Date.parse(createdAt) > now) throw new Error('Installation creation time is in the future');

  const excluded = (env.INSTALLATION_ACQUISITION_EXCLUDED_OWNERS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase());
  if (excluded.includes(installation.account.login.toLowerCase())) return;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      `installation-created:v1:${env.GITHUB_APP_ID}:${installation.installationId}`
    )
  );
  const receipt = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const namespace = env.FEEDBACK_COUNTER;
  const stub = namespace.get(namespace.idFromName(`${OBJECT_PREFIX}${day}`));
  const response = await stub.fetch('https://feedback-counter/acquisition/increment', {
    method: 'POST',
    body: JSON.stringify({ day, receipt, coverageStartedAt: start }),
  });
  if (!response.ok) throw new Error('Installation acquisition counter failed');
}

export function isCanonicalDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
