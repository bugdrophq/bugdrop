import { describe, expect, it, vi } from 'vitest';
import { admitHeartbeat } from '../scripts/production-heartbeat-admission.mjs';

const identity = {
  schemaVersion: 1,
  recoveryId: `wd-${'a'.repeat(32)}`,
  runId: '123',
  runAttempt: '1',
};
const environment = {
  BUGDROP_RECOVERY_ID: identity.recoveryId,
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  WATCHDOG_ADMISSION_SECRET: 's'.repeat(32),
  BUGDROP_CONTROLLED_FAILURE: 'false',
};
const response = (body: unknown = { ...identity, admitted: true }) =>
  new Response(JSON.stringify(body), { headers: { 'cache-control': 'no-store' } });

describe('heartbeat admission', () => {
  it('preserves manual and scheduled runs without contacting admission', async () => {
    const fetchImpl = vi.fn();
    expect(await admitHeartbeat({ environment: {}, fetchImpl })).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('binds the request and response to this exact attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    expect(await admitHeartbeat({ environment, fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://bugdrop.dev/api/monitor/watchdog/admit');
    expect(JSON.parse(init.body)).toEqual(identity);
    expect(init.redirect).toBe('error');
  });
  it.each([
    { ...identity, admitted: false },
    { ...identity, admitted: true, runId: '456' },
    { ...identity, admitted: true, runAttempt: '2' },
    { ...identity, admitted: true, extra: true },
  ])('denies a rejected or mismatched response', async body => {
    await expect(
      admitHeartbeat({ environment, fetchImpl: vi.fn().mockResolvedValue(response(body)) })
    ).rejects.toThrow();
  });
  it.each([
    { BUGDROP_RECOVERY_ID: 'bad\nvalue' },
    { WATCHDOG_ADMISSION_SECRET: '' },
    { BUGDROP_CONTROLLED_FAILURE: 'true' },
  ])('rejects invalid recovery configuration before any request', async override => {
    const fetchImpl = vi.fn();
    await expect(
      admitHeartbeat({ environment: { ...environment, ...override }, fetchImpl })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not retry a lost response or redirect', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    await expect(admitHeartbeat({ environment, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
