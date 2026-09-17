import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import { start } from '../../managed/staging/test-adapter.mjs';
import { derive, bearer, hmac, digest, utf8 } from '../../src/managed/local/protocol';
import { verify } from '../../src/managed/local/capability';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';
let service: Awaited<ReturnType<typeof start>>;
let projection: Record<string, unknown>;
beforeEach(async () => {
  const pepper = randomBytes(32).toString('base64url');
  const derived = await derive(credential.apiKey);
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  service = await start({
    pepper,
    verifier: await hmac(pepper, bearer(derived.authorization).authSecret),
    keyset: {
      activeKid: 'staging-test',
      keys: [
        {
          kid: 'staging-test',
          publicKey: await webcrypto.subtle.exportKey('jwk', key.publicKey),
          privateKey: await webcrypto.subtle.exportKey('jwk', key.privateKey),
          notBefore: Date.now() - 1000,
          verifyUntil: Date.now() + 3600000,
        },
      ],
    },
  });
  projection = {
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
}, 30000);
afterEach(async () => {
  await service?.close();
}, 30000);
const update = (sequence = 1, changes = {}) => ({
  schemaVersion: 1,
  sequence,
  projection: { ...projection, ...changes },
});
const bound = async () => ({
  submissionId: crypto.randomUUID(),
  payloadDigest: await digest(utf8('{"report":"PRIVATE_REPORT_CANARY"}')),
});
async function mint(binding: Awaited<ReturnType<typeof bound>>) {
  return service.publicRequest('/v1/submission-capabilities', {
    method: 'POST',
    headers: {
      Authorization: credential.authorization,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
      'X-BugDrop-Contract-Version': '1',
      'X-BugDrop-SDK-Version': '0.1.0',
    },
    body: JSON.stringify({ schemaVersion: 1, ...binding, origin: projection.origin }),
  });
}
describe.sequential('actual staging Workers with provider-shaped ephemeral secrets', () => {
  it('rejects unsigned/tampered, future, stale, extra-field and cross-context control writes', async () => {
    for (const payload of [
      update(1, { observedAt: Date.now() + 3600000 }),
      update(1, { observedAt: Date.now() - 30001 }),
      update(1, { origin: 'https://example.com.' }),
      update(1, { applicationId: 'other' }),
      update(1, { secret: 'PRIVATE_TOKEN_CANARY' }),
    ])
      expect((await service.control('/projection', payload)).status).toBe(403);
    expect((await service.control('/projection', update(), { tamper: true })).status).toBe(403);
    expect(
      (
        await service.request('/control/projection', {
          method: 'POST',
          body: JSON.stringify(update()),
        })
      ).status
    ).toBe(403);
    expect((await mint(await bound())).status).toBe(403);
  });
  it('serializes concurrent exact retries and never exposes private controls publicly', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.control('/projection', update()))
    );
    expect(results.filter(r => r.status === 200)).toHaveLength(12);
    expect((await service.control('/projection', update())).status).toBe(200);
    for (const path of [
      '/submit',
      '/_local/submit',
      '/projection',
      '/projection-status',
      '/snapshot',
      '/revoke-installation',
    ])
      expect((await service.publicRequest(path, { method: 'POST', body: '{}' })).status).toBe(403);
  });
  it('preserves issuance, exact binding and at-most-once across restart without telemetry content', async () => {
    expect((await service.control('/projection', update())).status).toBe(200);
    const binding = await bound();
    const response = await mint(binding);
    expect(response.status).toBe(200);
    const capability = await response.json();
    const input = {
      token: capability.token,
      origin: projection.origin,
      binding,
      body: Buffer.from('{"report":"PRIVATE_REPORT_CANARY"}').toString('base64url'),
    };
    const submit = () =>
      service
        .request('/submit/submit', { method: 'POST', body: JSON.stringify(input) })
        .then(r => r.json());
    const results = await Promise.all(Array.from({ length: 12 }, submit));
    expect(results.every(r => ['delivered', 'delivering'].includes(r.outcome))).toBe(true);
    await service.restart();
    expect((await submit()).outcome).toBe('delivered');
    expect(service.evidence().attempts).toBe(1);
    input.origin = 'https://example.com.';
    expect((await submit()).outcome).toBe('rejected');
    expect(JSON.stringify(service.evidence())).not.toContain('PRIVATE_REPORT_CANARY');
    expect(service.evidence().network).toEqual([]);
    const issuer = await (await service.request('/issuer/snapshot')).json();
    const reader = await (await service.request('/reader/snapshot')).json();
    expect(reader.signingKeys[0]).not.toHaveProperty('privateKey');
    expect(reader.pepper).toBe('');
    expect(issuer.receiptKey).toBe('');
    await expect(verify(capability.token, { ...issuer, realm: undefined })).rejects.toThrow();
  });
  it('rejects a body that completes after the authorization window expires', async () => {
    expect(
      (await service.control('/projection', update(1, { observedAt: Date.now() - 29000 }))).status
    ).toBe(200);
    const binding = await bound();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(utf8('{'));
        setTimeout(() => {
          controller.enqueue(
            utf8(
              JSON.stringify({ schemaVersion: 1, ...binding, origin: projection.origin }).slice(1)
            )
          );
          controller.close();
        }, 1800);
      },
    });
    const reply = await service.publicRequest('/v1/submission-capabilities', {
      method: 'POST',
      headers: {
        Authorization: credential.authorization,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
        'X-BugDrop-Contract-Version': '1',
        'X-BugDrop-SDK-Version': '0.1.0',
      },
      body,
      duplex: 'half',
    });
    expect((await service.request('/issuer/snapshot')).status).toBe(403);
    expect(reply.status).toBe(403);
  });
  it('keeps delivery disabled before admission and separates publisher from uninstall authority', async () => {
    expect((await service.control('/projection', update())).status).toBe(200);
    expect(
      (
        await service.control(
          '/revoke-installation',
          { schemaVersion: 1, installationId: '42' },
          { useProjectionKey: true }
        )
      ).status
    ).toBe(403);
    const binding = await bound();
    const minted = await mint(binding);
    expect(minted.status).toBe(200);
    const capability = await minted.json();
    await service.disableDelivery();
    const reply = await service.request('/submit/submit', {
      method: 'POST',
      body: JSON.stringify({
        token: capability.token,
        binding,
        origin: projection.origin,
        body: Buffer.from('{"report":"PRIVATE_REPORT_CANARY"}').toString('base64url'),
      }),
    });
    expect((await reply.json()).outcome).toBe('rejected');
    expect(service.evidence().attempts).toBe(0);
  });
  it('allows bounded real-adapter preflight time without a second attempt', async () => {
    expect((await service.control('/projection', update())).status).toBe(200);
    service.setDeliveryDelay(1500);
    const binding = await bound();
    const capability = await (await mint(binding)).json();
    const input = {
      token: capability.token,
      binding,
      origin: projection.origin,
      body: Buffer.from('{"report":"PRIVATE_REPORT_CANARY"}').toString('base64url'),
    };
    const submit = () =>
      service
        .request('/submit/submit', { method: 'POST', body: JSON.stringify(input) })
        .then(r => r.json());
    expect((await submit()).outcome).toBe('delivered');
    expect((await submit()).outcome).toBe('delivered');
    expect(service.evidence().attempts).toBe(1);
  });
  it('rejects impossible V1 key IDs before poisoning an immutable scope', async () => {
    expect((await service.control('/projection', update(1, { keyId: 'key-test' }))).status).toBe(
      403
    );
    expect((await service.control('/projection', update())).status).toBe(200);
    expect((await mint(await bound())).status).toBe(200);
  });
  it('requires version advancement for authority changes and cannot revive a revoked credential', async () => {
    expect((await service.control('/projection', update())).status).toBe(200);
    expect(
      (await service.control('/projection', update(2, { origin: 'https://other.example.com' })))
        .status
    ).toBe(403);
    expect(
      (await service.control('/projection', update(2, { credentialActive: false }))).status
    ).toBe(403);
    expect(
      (
        await service.control(
          '/projection',
          update(2, { credentialActive: false, authorizationVersion: 2 })
        )
      ).status
    ).toBe(200);
    expect(
      (await service.control('/projection', update(3, { authorizationVersion: 3 }))).status
    ).toBe(403);
    expect((await mint(await bound())).status).toBe(403);
  });
  it('does not refresh stale authorization by reading; uninstall stays latched after restart and newer updates', async () => {
    expect(
      (await service.control('/projection', update(1, { observedAt: Date.now() - 29000 }))).status
    ).toBe(200);
    const first = await (await service.request('/issuer/snapshot')).json();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect((await service.request('/issuer/snapshot')).status).toBe(403);
    expect((await mint(await bound())).status).toBe(403);
    expect(first.projection.observedAt).toBeLessThan(Date.now() - 30000);
    expect(
      (await service.control('/projection', update(2, { observedAt: Date.now() }))).status
    ).toBe(200);
    expect(
      (await service.control('/revoke-installation', { schemaVersion: 1, installationId: 'wrong' }))
        .status
    ).toBe(403);
    expect(
      (await service.control('/revoke-installation', { schemaVersion: 1, installationId: '42' }))
        .status
    ).toBe(200);
    await service.restart();
    expect((await mint(await bound())).status).toBe(403);
    expect(
      (await service.control('/projection', update(3, { observedAt: Date.now() }))).status
    ).toBe(403);
  });
});
