// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryGuard } from '../src/widget/managed/recovery';

const endpoint = 'https://managed.example/v1/submissions';
const key = `bugdrop:unresolved:v1:${JSON.stringify(['app_test', endpoint])}`;
beforeEach(() => {
  localStorage.clear();
  let pending = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_key: string, callback: () => unknown) => {
        const result = pending.then(callback);
        pending = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('managed unresolved guard', () => {
  it('claims before send, keeps owner retries, and blocks a new document', async () => {
    const owner = createRecoveryGuard('app_test', endpoint);
    expect(owner.isBlocked()).toBe(false);
    expect(await owner.acquire()).toBe(true);
    expect(await owner.acquire()).toBe(true);
    const cold = createRecoveryGuard('app_test', endpoint);
    expect(cold.isBlocked()).toBe(true);
    expect(await cold.acquire()).toBe(false);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(key)).toMatch(/^unresolved:[a-f0-9-]{36}$/);
    await owner.release();
    expect(createRecoveryGuard('app_test', endpoint).isBlocked()).toBe(false);
  });
  it('allows exactly one concurrent owner across tabs', async () => {
    const first = createRecoveryGuard('app_test', endpoint);
    const second = createRecoveryGuard('app_test', endpoint);
    expect(await Promise.all([first.acquire(), second.acquire()])).toEqual([true, false]);
  });
  it('separates Application and destination without relying on customer identity', async () => {
    await createRecoveryGuard('app_test', endpoint).acquire();
    expect(await createRecoveryGuard('app_other', endpoint).acquire()).toBe(true);
    expect(
      await createRecoveryGuard('app_test', 'https://another.example/v1/submissions').acquire()
    ).toBe(true);
  });
  it('blocks corrupt and empty marker values rather than replacing them', async () => {
    for (const value of ['broken', '']) {
      localStorage.setItem(key, value);
      const guard = createRecoveryGuard('app_test', endpoint);
      expect(guard.isBlocked()).toBe(true);
      expect(await guard.acquire()).toBe(false);
      expect(localStorage.getItem(key)).toBe(value);
    }
  });
  it('fails closed when storage or Web Locks is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    const guard = createRecoveryGuard('app_test', endpoint);
    expect(await guard.acquire()).toBe(false);
    expect(guard.isBlocked()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(createRecoveryGuard('app_test', endpoint).isBlocked()).toBe(true);
    expect(await createRecoveryGuard('app_test', endpoint).acquire()).toBe(false);
  });
  it('cannot clear another owner or continue after marker removal', async () => {
    const owner = createRecoveryGuard('app_test', endpoint);
    await owner.acquire();
    localStorage.removeItem(key);
    expect(await owner.acquire()).toBe(false);
    localStorage.setItem(key, 'another-owner');
    await owner.release();
    expect(owner.isBlocked()).toBe(true);
    expect(localStorage.getItem(key)).toBe('another-owner');
  });
  it('retains a failed lock if clearing storage fails', async () => {
    const owner = createRecoveryGuard('app_test', endpoint);
    await owner.acquire();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Unavailable');
    });
    await owner.release();
    expect(owner.isBlocked()).toBe(true);
    expect(await owner.acquire()).toBe(false);
  });
});
