import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  observationCall,
  observationMessage,
  observationReply,
} from '../../src/managed/staging/observation-wire';
const env = {
  ENVIRONMENT: 'staging',
  STAGING_ENABLED: 'true',
  STAGING_OBSERVATION_ENABLED: 'true',
  STAGING_APPLICATION_ID: 'app-test',
  STAGING_INSTALLATION_ID: '42',
  STAGING_OBSERVATION_HMAC_KEY: randomBytes(32).toString('base64url'),
};
describe('observer whole exchange deadline', () => {
  it('rejects an old signed read even within the same lease and accepts a fresh nonce', async () => {
    const selectors = {
      runId: crypto.randomUUID(),
      scenario: 'origin-aliases',
      leaseId: crypto.randomUUID(),
    };
    let old: Response | undefined;
    let replay = false;
    let count = 0;
    const transport = {
      fetch: async (_url: string, init: RequestInit) => {
        const request = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
        if (replay) return old!.clone();
        const response = await observationReply(
          '/observation/read',
          {
            schemaVersion: 2,
            requestNonce: request.requestNonce,
            leaseId: selectors.leaseId,
            expiresAt: Date.now() + 900000,
            sequence: null,
            snapshot: {
              runId: selectors.runId,
              scenario: selectors.scenario,
              applicationId: 'app-test',
              count,
              complete: true,
              exclusive: true,
            },
            exchanges: count ? [{ sequence: 1, sdkVersion: '0.1.0', status: 403 }] : [],
          },
          env.STAGING_OBSERVATION_HMAC_KEY
        );
        old = response.clone();
        return response;
      },
    } as unknown as Fetcher;
    expect(
      (await observationCall(transport, env, '/observation/read', selectors)).snapshot
    ).toMatchObject({ count: 0 });
    count = 1;
    replay = true;
    await expect(observationCall(transport, env, '/observation/read', selectors)).rejects.toThrow();
    replay = false;
    expect(
      (await observationCall(transport, env, '/observation/read', selectors)).snapshot
    ).toMatchObject({ count: 1 });
  });
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
