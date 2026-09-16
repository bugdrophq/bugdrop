import { json, readBounded } from './protocol';

/** Only a private fake binding exists in this tranche; no GitHub URL or credential is available. */
export async function attemptOnce(
  adapter: Fetcher,
  body: Uint8Array
): Promise<'delivered' | 'indeterminate'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = (async () => {
      const returned = await adapter.fetch('http://fake-github.bugdrop.localhost/attempt', {
        method: 'POST',
        body,
      });
      if (!returned.ok) return 'indeterminate' as const;
      const value = json(
        await readBounded(
          new Request('http://fake-github.bugdrop.localhost/result', {
            method: 'POST',
            body: returned.body,
          }),
          1024
        )
      );
      return typeof value === 'object' &&
        value !== null &&
        'outcome' in value &&
        value.outcome === 'delivered'
        ? ('delivered' as const)
        : ('indeterminate' as const);
    })();
    // Cover both response headers and body. A later completion cannot change the persisted outcome.
    return await Promise.race([
      attempt,
      new Promise<'indeterminate'>(resolve => {
        timer = setTimeout(() => resolve('indeterminate'), 1000);
      }),
    ]);
  } catch {
    return 'indeterminate';
  } finally {
    clearTimeout(timer);
  }
}
