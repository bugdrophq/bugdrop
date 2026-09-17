import { Buffer } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { applySql } from '../../src/managed/uninstall/adapters';
afterEach(() => vi.useRealTimers());
it('bounds and cancels a stalled receipt body even if the private transport ignores abort', async () => {
  vi.useFakeTimers();
  const canceled = vi.fn();
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const transport = {
    fetch: async () => {
      entered();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel: canceled,
        })
      );
    },
  } as unknown as Fetcher;
  const key = Buffer.alloc(32, 4).toString('base64url');
  const pending = applySql(
    {
      STAGING_RECONCILIATION: transport,
      STAGING_CONTROL: transport,
      STAGING_APPLICATION_ID: 'app-test',
      STAGING_RECONCILIATION_HMAC_KEY: key,
      STAGING_UNINSTALL_HMAC_KEY: key,
    },
    {
      eventHash: 'a'.repeat(64),
      installationHash: 'b'.repeat(64),
      occurredAt: 1_789_650_000_000,
      requestId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
    },
    '202'
  );
  await started;
  await vi.advanceTimersByTimeAsync(2001);
  expect(await pending).toBe('pending');
  expect(canceled).toHaveBeenCalledOnce();
});
