import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubmission } from '../src/widget/managed/transport';
import type { Binding, Feedback } from '../src/widget/managed/protocol';

const endpoint = 'https://managed.example/v1/submissions';
const receiptId = '10000000-0000-4000-8000-000000000001';
const feedback: Feedback = {
  schemaVersion: 1,
  title: 'Save failed',
  description: 'First\r\n\tSecond 😀',
  category: 'bug',
};
const success = () =>
  new Response(JSON.stringify({ schemaVersion: 1, status: 'delivered', receiptId }), {
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('managed widget transport', () => {
  it('remints after lost response using exactly the original bytes, ID and digest', async () => {
    const source = { ...feedback };
    const bindings: Binding[] = [];
    const provider = vi.fn((binding: Binding) => {
      bindings.push(binding);
      return `token-${bindings.length}`;
    });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('private-token-canary'))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetcher);
    const creating = createSubmission(source, endpoint, provider);
    source.title = 'changed while digest is pending';
    const submission = await creating;
    expect(await submission.submit()).toEqual({ status: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await submission.submit()).toEqual({ status: 'delivered', receiptId });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(bindings[0]).toEqual(bindings[1]);
    expect(bindings[0]).not.toBe(bindings[1]);
    const first = fetcher.mock.calls[0][1] as RequestInit;
    const second = fetcher.mock.calls[1][1] as RequestInit;
    expect(new TextDecoder().decode(first.body as Uint8Array)).toBe(JSON.stringify(feedback));
    expect(second.body).toEqual(first.body);
    expect(second.body).not.toBe(first.body);
    const bytes = first.body as Uint8Array;
    const expectedDigest = Buffer.from(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
    ).toString('base64url');
    expect(bindings[0].payloadDigest).toBe(expectedDigest);
    expect(first.headers).toEqual({
      'Content-Type': 'application/json',
      'X-BugDrop-Submission-Id': bindings[0].submissionId,
      Authorization: 'Bearer token-1',
    });
    expect(second.headers).toEqual({ ...first.headers, Authorization: 'Bearer token-2' });
    expect(first).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(fetcher.mock.calls.every(([url]) => url === endpoint)).toBe(true);
  });

  it('coalesces concurrent submissions and caches delivered without another authorization', async () => {
    const provider = vi.fn(() => 'token');
    const fetcher = vi.fn().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, provider);
    const first = submission.submit();
    expect(submission.submit()).toBe(first);
    const outcome = await first;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(await submission.submit()).toBe(outcome);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('isolates a provider attempting to mutate the binding', async () => {
    const originals: Binding[] = [];
    const provider = vi.fn((binding: Binding) => {
      originals.push({ ...binding });
      expect(() =>
        Object.assign(binding, { submissionId: 'attacker', payloadDigest: 'changed' })
      ).toThrow();
      return 'token';
    });
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, provider);
    await submission.submit();
    await submission.submit();
    expect(originals[0]).toEqual(originals[1]);
    expect(fetcher.mock.calls[0][1].headers['X-BugDrop-Submission-Id']).toBe(
      originals[0].submissionId
    );
  });

  it.each([undefined, '', 'token\nsecret', 'token space', 'x'.repeat(16385)])(
    'rejects invalid callback token %# without a network call',
    async token => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const submission = await createSubmission(feedback, endpoint, () => token as string);
      expect(await submission.submit()).toEqual({ status: 'authorization_failed' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each(['abc+/=', 'x'.repeat(16384)])('accepts bounded Bearer token syntax %#', async token => {
    const fetcher = vi.fn().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, () => token);
    expect(await submission.submit()).toEqual({ status: 'delivered', receiptId });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('never reflects provider errors and permits a later manual authorization attempt', async () => {
    const provider = vi
      .fn()
      .mockRejectedValueOnce(new Error('private-token-canary'))
      .mockResolvedValueOnce('fresh');
    const fetcher = vi.fn().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetcher);
    const submission = await createSubmission(feedback, endpoint, provider);
    expect(await submission.submit()).toEqual({ status: 'authorization_failed' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await submission.submit()).toEqual({ status: 'delivered', receiptId });
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
