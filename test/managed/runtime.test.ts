import type { ManagedIngressEnv } from '../../src/managed/ingress-env';
import type { ManagedDeliveryEnv } from '../../src/managed/delivery-env';
import { describe, expect, it, vi } from 'vitest';
import ingress, { ManagedAuthorization } from '../../src/managed/ingress';
import delivery, { ManagedReceipts } from '../../src/managed/delivery';
import consumer from '../../src/managed/consumer';

function environment() {
  const touched = vi.fn(() => {
    throw new Error('Stage 0 must not use authority');
  });
  return {
    touched,
    env: {
      MANAGED_STAGE: 'local-scaffold',
      MANAGED_CONFIG: { get: touched },
      MANAGED_AUTHORIZATION: { get: touched },
      MANAGED_DELIVERY: { fetch: touched },
      MANAGED_RECEIPTS: { get: touched },
      MANAGED_OUTCOMES: { send: touched },
    } as unknown as ManagedIngressEnv & ManagedDeliveryEnv,
  };
}

describe('managed scaffold refuses all work', () => {
  it.each([ingress, delivery])('reports presence without claiming readiness', async worker => {
    const { env, touched } = environment();
    const response = await worker.fetch(
      new Request('http://bugdrop-managed.localhost/health'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stage: 'local-scaffold',
      ready: false,
      bindingsPresent: true,
    });
    expect(touched).not.toHaveBeenCalled();
    const missing = await worker.fetch(
      new Request('http://bugdrop-managed.localhost/health'),
      {} as typeof env
    );
    expect(missing.status).toBe(503);
  });

  it.each([
    [ingress, 'MANAGED_CONFIG'],
    [ingress, 'MANAGED_AUTHORIZATION'],
    [ingress, 'MANAGED_DELIVERY'],
    [delivery, 'MANAGED_RECEIPTS'],
    [delivery, 'MANAGED_OUTCOMES'],
    [ingress, 'MANAGED_STAGE'],
    [delivery, 'MANAGED_STAGE'],
  ] as const)('rejects health with missing or malformed %s %s', async (worker, binding) => {
    for (const invalid of [undefined, {}, 'production']) {
      const { env, touched } = environment();
      const invalidEnv = { ...env, [binding]: invalid } as typeof env;
      const response = await worker.fetch(
        new Request('http://bugdrop-managed.localhost/health'),
        invalidEnv
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        stage: 'local-scaffold',
        ready: false,
        bindingsPresent: false,
      });
      expect(touched).not.toHaveBeenCalled();
    }
  });

  it.each([
    '/feedback',
    '/v1/submission-capabilities',
    '/deliver',
    '/health',
    '/api/github/webhook',
  ])('rejects %s with credentials without reading or forwarding body', async path => {
    const { env, touched } = environment();
    for (const worker of [ingress, delivery]) {
      const request = new Request(`http://bugdrop-managed.localhost${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer copied-public-identifier',
          Origin: 'https://example.com',
        },
        body: 'PRIVATE-CANARY',
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'managed_not_ready' });
      expect(request.bodyUsed).toBe(false);
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it('keeps authorization and receipt coordinators closed', async () => {
    for (const coordinator of [new ManagedAuthorization(), new ManagedReceipts()]) {
      expect((await coordinator.fetch()).status).toBe(503);
    }
  });

  it('retries batches without accessing bodies, acknowledging, logging, or fetching', async () => {
    const retryAll = vi.fn();
    const forbidden = vi.fn(() => {
      throw new Error('private canary accessed');
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(forbidden);
    try {
      const batch = {
        retryAll,
        ackAll: forbidden,
        get messages() {
          return forbidden();
        },
      };
      await consumer.queue(batch as unknown as MessageBatch<unknown>);
      expect(retryAll).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(forbidden).not.toHaveBeenCalled();
      expect(consumer).not.toHaveProperty('fetch');
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
