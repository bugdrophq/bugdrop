import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubmission } from '../src/widget/managed/transport';
const feedback = { schemaVersion: 1 as const, title: 'Title', description: 'Text' };
const endpoint = 'https://managed.example/v1/submissions';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded managed transport', () => {
  it('times out a never-settling provider and cannot send after a late token arrives', async () => {
    let resolve: (value: string) => void = () => {};
    const token = new Promise<string>(finish => {
      resolve = finish;
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, () => token);
    vi.useFakeTimers();
    const pending = submission.submit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ status: 'authorization_failed' });
    resolve('late-private-token');
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('times out fetch even if an implementation ignores abort, without retry', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, () => 'token');
    vi.useFakeTimers();
    const pending = submission.submit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ status: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
      true
    );
  });
  it('shares the 10-second deadline across provider, fetch and a stalled body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const submission = await createSubmission(
      feedback,
      endpoint,
      () =>
        new Promise(resolve => {
          setTimeout(() => resolve('token'), 9000);
        })
    );
    vi.useFakeTimers();
    const pending = submission.submit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toEqual({ status: 'indeterminate' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2049' },
    }),
  ])('treats malformed or unbounded response %# as indeterminate', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const submission = await createSubmission(feedback, endpoint, () => 'token');
    expect(await submission.submit()).toEqual({ status: 'indeterminate' });
  });
  it('bounds streaming bytes without trusting Content-Length and cancels excess body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1025));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Type': 'application/json' } })
        )
    );
    const submission = await createSubmission(feedback, endpoint, () => 'token');
    expect(await submission.submit()).toEqual({ status: 'indeterminate' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
