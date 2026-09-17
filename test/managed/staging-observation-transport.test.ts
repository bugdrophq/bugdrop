import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { observationCall, observationMessage } from '../../src/managed/staging/observation-wire';
const env = {
  ENVIRONMENT: 'staging',
  STAGING_ENABLED: 'true',
  STAGING_OBSERVATION_ENABLED: 'true',
  STAGING_APPLICATION_ID: 'app-test',
  STAGING_INSTALLATION_ID: '42',
  STAGING_OBSERVATION_HMAC_KEY: randomBytes(32).toString('base64url'),
};
describe('observer whole exchange deadline', () => {
  it('preserves exact signed bytes including BOM rather than decoding', () => {
    const raw = new Uint8Array([239, 187, 191, 123, 125]);
    const signed = observationMessage('/observation/read', raw);
    expect([...signed.slice(-raw.length)]).toEqual([...raw]);
    expect([...signed]).not.toEqual([
      ...observationMessage('/observation/read', new Uint8Array([123, 125])),
    ]);
  });
  it.each(['fetch', 'body'])('bounds held %s without accepting missing evidence', async mode => {
    let canceled = false;
    const transport = {
      fetch: () =>
        mode === 'fetch'
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  cancel() {
                    canceled = true;
                  },
                })
              )
            ),
    } as unknown as Fetcher;
    const began = performance.now();
    await expect(
      observationCall(transport, env, '/observation/begin', { sdkVersion: '0.1.0' })
    ).rejects.toThrow('observation_timeout');
    expect(performance.now() - began).toBeLessThan(3000);
    if (mode === 'body') expect(canceled).toBe(true);
  });
});
