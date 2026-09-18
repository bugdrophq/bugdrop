import { expect, it, vi } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import gateway from '../../src/managed/staging/https-gateway';
import { start } from '../../managed/staging/test-adapter.mjs';
import { derive, bearer, hmac, digest, utf8 } from '../../src/managed/local/protocol';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';

it('preserves real enabled issuer auth/origin and one durable observation per forwarded request', async () => {
  const pepper = randomBytes(32).toString('base64url');
  const derived = await derive(credential.apiKey);
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const service = await start({
    pepper,
    verifier: await hmac(pepper, bearer(derived.authorization).authSecret),
    enableObservation: true,
    keyset: {
      activeKid: 'gateway-test',
      keys: [
        {
          kid: 'gateway-test',
          publicKey: await webcrypto.subtle.exportKey('jwk', key.publicKey),
          privateKey: await webcrypto.subtle.exportKey('jwk', key.privateKey),
          notBefore: Date.now() - 1000,
          verifyUntil: Date.now() + 3600000,
        },
      ],
    },
  });
  try {
    const projection = {
      tenantId: 'tenant-test',
      applicationId: 'app-test',
      destinationId: 'destination-test',
      installationId: '42',
      keyId: derived.keyId,
      configurationVersion: 1,
      authorizationVersion: 1,
      origin: 'https://example.com',
      credentialActive: true,
      applicationActive: true,
      installationActive: true,
      tenantActive: true,
      observedAt: Date.now(),
    };
    expect(
      (await service.control('/projection', { schemaVersion: 1, sequence: 1, projection })).status
    ).toBe(200);
    const opened = await service.observation('/observation/start', {
      runId: crypto.randomUUID(),
      scenario: 'origin-aliases',
    });
    expect(opened.valid).toBe(true);
    expect(opened.status).toBe(200);
    const scope = {
      runId: opened.body.snapshot.runId,
      scenario: 'origin-aliases',
      leaseId: opened.body.leaseId,
    };
    const fetch = vi.fn(async (request: Request) =>
      service.publicRequest(new URL(request.url).pathname, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
        signal: request.signal,
        redirect: request.redirect,
      })
    );
    const env = {
      ENVIRONMENT: 'staging',
      GATEWAY_ENABLED: 'true',
      GATEWAY_ORIGIN: 'https://issuance.example.test',
      STAGING_CAPABILITY_INGRESS: { fetch },
    };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
      'X-BugDrop-Contract-Version': '1',
      'X-BugDrop-SDK-Version': '0.1.0',
      Authorization: derived.authorization,
    };
    const body = {
      schemaVersion: 1,
      submissionId: crypto.randomUUID(),
      payloadDigest: await digest(utf8('private report')),
      origin: projection.origin,
    };
    for (const [index, patch] of [
      {},
      { origin: 'https://wrong.example.test' },
      { auth: 'Bearer invalid' },
    ].entries()) {
      const { auth, ...bodyPatch } = patch;
      const request = new Request(env.GATEWAY_ORIGIN + '/v1/submission-capabilities', {
        method: 'POST',
        headers: { ...headers, Authorization: auth ?? headers.Authorization },
        body: JSON.stringify({ ...body, ...bodyPatch }),
      });
      const response = await gateway.fetch(request, env);
      expect(response.status).toBe(index === 0 ? 200 : 403);
      if (index === 0) {
        const issued = await response.json();
        expect(issued.schemaVersion).toBe(1);
        expect(issued.token.length).toBeLessThan(8192);
      }
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    const observed = await service.observation('/observation/read', scope);
    expect(observed.valid).toBe(true);
    expect(observed.body.snapshot.count).toBe(3);
    expect(observed.body.exchanges.map((entry: { status: number }) => entry.status)).toEqual([
      200, 403, 403,
    ]);
    expect(
      observed.body.exchanges.every((entry: { sdkVersion: string }) => entry.sdkVersion === '0.1.0')
    ).toBe(true);
    expect(service.evidence().attempts).toBe(0);
    expect(service.evidence().network).toEqual([]);
    const closed = await service.observation('/observation/close', scope);
    expect(closed.status).toBe(200);
  } finally {
    await service.close();
  }
}, 30000);
