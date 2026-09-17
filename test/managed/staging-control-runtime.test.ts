import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import { start } from '../../managed/staging/test-adapter.mjs';
import { derive, bearer, hmac, digest, utf8 } from '../../src/managed/local/protocol';
import { projectionDigest } from '../../src/managed/staging/control-receipt';
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
    enableControlFaults: true,
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
const expected = async (value: ReturnType<typeof update>, raw = JSON.stringify(value)) => ({
  schemaVersion: 1,
  applicationId: value.projection.applicationId,
  keyId: value.projection.keyId,
  sequence: value.sequence,
  configurationVersion: value.projection.configurationVersion,
  authorizationVersion: value.projection.authorizationVersion,
  projectionDigest: await projectionDigest(utf8(raw)),
});
describe.sequential('durable private control acknowledgements in actual Workerd', () => {
  it('returns one durable signed receipt for concurrent exact retries and restart/status recovery', async () => {
    const value = update();
    const match = await expected(value);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => service.control('/projection', value))
    );
    const receipts = await Promise.all(responses.map(response => service.receipt(response)));
    expect(receipts.every(receipt => receipt.status === 200 && receipt.valid)).toBe(true);
    expect(new Set(receipts.map(receipt => receipt.raw)).size).toBe(1);
    expect(receipts[0].body).toEqual({ ...match, accepted: true });
    await service.restart();
    expect((await service.receipt(await service.control('/projection-status', match))).raw).toBe(
      receipts[0].raw
    );
    expect((await service.receipt(await service.control('/projection', value))).raw).toBe(
      receipts[0].raw
    );
  });
  it('rejects altered bytes, stale sequences and mismatched status without refreshing authority', async () => {
    const value = update();
    const match = await expected(value);
    expect((await service.control('/projection', value)).status).toBe(200);
    expect(
      (await service.control('/projection', value, { rawBody: JSON.stringify(value) + ' ' })).status
    ).toBe(403);
    expect((await service.control('/projection-status', match, { tamper: true })).status).toBe(403);
    for (const changes of [
      { keyId: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { sequence: 2 },
      { configurationVersion: 2 },
      { authorizationVersion: 2 },
      { projectionDigest: 'f'.repeat(64) },
      { applicationId: 'other' },
    ])
      expect((await service.control('/projection-status', { ...match, ...changes })).status).toBe(
        403
      );
    expect(
      (
        await service.control(
          '/projection',
          update(2, { credentialActive: false, authorizationVersion: 2 })
        )
      ).status
    ).toBe(200);
    expect((await service.control('/projection-status', match)).status).toBe(403);
    expect((await service.control('/projection', value)).status).toBe(403);
    expect(
      (await service.control('/projection', update(3, { authorizationVersion: 3 }))).status
    ).toBe(403);
  });
  it('acknowledges expired exact persistence without renewing observation or allowing issuance', async () => {
    const value = update(1, { observedAt: Date.now() - 29_000 });
    const match = await expected(value);
    const first = await service.receipt(await service.control('/projection', value));
    expect(first.valid).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await service.restart();
    for (const path of ['/projection', '/projection-status']) {
      const response = await service.receipt(
        await service.control(path, path === '/projection' ? value : match)
      );
      expect(response.valid).toBe(true);
      expect(response.raw).toBe(first.raw);
    }
    expect((await mint(await bound())).status).toBe(403);
    expect((await service.control('/projection', { ...value, sequence: 2 })).status).toBe(403);
  });
  it('rolls back projection when receipt insertion fails inside the same SQL transaction', async () => {
    const first = update();
    const match = await expected(first);
    await service.control('/projection', first);
    await service.setControlFault('rollback');
    expect(
      (
        await service.control(
          '/projection',
          update(2, { credentialActive: false, authorizationVersion: 2 })
        )
      ).status
    ).toBe(403);
    const status = await service.receipt(await service.control('/projection-status', match));
    expect(status.valid).toBe(true);
    expect((await mint(await bound())).status).toBe(200);
    expect(
      (
        await service.control(
          '/projection',
          update(2, { credentialActive: false, authorizationVersion: 2 })
        )
      ).status
    ).toBe(200);
    expect((await mint(await bound())).status).toBe(403);
  });
  it('never acknowledges sync failure and recovers its exact persisted outcome after restart', async () => {
    const value = update();
    const match = await expected(value);
    await service.setControlFault('sync-failure');
    const failed = await service.control('/projection', value);
    expect(failed.status).toBe(403);
    expect(failed.headers.has('X-BugDrop-Control-Receipt-Signature')).toBe(false);
    await service.restart();
    const retry = await service.receipt(await service.control('/projection', value));
    expect(retry.valid).toBe(true);
    expect((await service.receipt(await service.control('/projection-status', match))).raw).toBe(
      retry.raw
    );
  });
  it('recovers ambiguous post-sync DO abort without replaying or renewing the write', async () => {
    const value = update();
    const match = await expected(value);
    await service.setControlFault('crash');
    try {
      const interrupted = await service.control('/projection', value);
      expect(interrupted.status).not.toBe(200);
      expect(interrupted.headers.has('X-BugDrop-Control-Receipt-Signature')).toBe(false);
    } catch (error) {
      expect(String(error)).toContain('injected_post_sync_crash');
    }
    await service.restart();
    const recovered = await service.receipt(await service.control('/projection-status', match));
    expect(recovered.valid).toBe(true);
    expect(recovered.body).toEqual({ ...match, accepted: true });
    expect((await service.receipt(await service.control('/projection', value))).raw).toBe(
      recovered.raw
    );
  });
  it('admits only one of conflicting same-sequence writes and preserves terminal revocation', async () => {
    const variants = [update(), update(1, { credentialActive: false })];
    const results = await Promise.all(variants.map(value => service.control('/projection', value)));
    expect(results.map(response => response.status).sort()).toEqual([200, 403]);
    const winner = results.findIndex(response => response.status === 200);
    expect(
      (
        await service.receipt(
          await service.control('/projection-status', await expected(variants[winner]))
        )
      ).valid
    ).toBe(true);
    const terminal = update(2, { credentialActive: false, authorizationVersion: 2 });
    expect((await service.control('/projection', terminal)).status).toBe(200);
    await service.restart();
    expect(
      (await service.control('/projection', update(3, { authorizationVersion: 3 }))).status
    ).toBe(403);
    expect(
      (await service.receipt(await service.control('/projection-status', await expected(terminal))))
        .valid
    ).toBe(true);
  });
  it('authenticates status before returning anything and keeps it off public routes', async () => {
    const match = await expected(update());
    expect((await service.control('/projection-status', match)).status).toBe(403);
    await service.control('/projection', update());
    expect(
      (
        await service.request('/control/projection-status', {
          method: 'POST',
          body: JSON.stringify(match),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await service.publicRequest('/projection-status', {
          method: 'POST',
          body: JSON.stringify(match),
        })
      ).status
    ).toBe(403);
  });
  it('authenticates permanent uninstall acknowledgements across retry/restart without enabling projections', async () => {
    await service.control('/projection', update());
    const event = { schemaVersion: 1, installationId: '42' };
    const first = await service.receipt(await service.control('/revoke-installation', event), true);
    expect(first.valid).toBe(true);
    expect(first.body).toEqual({
      schemaVersion: 1,
      accepted: true,
      applicationId: 'app-test',
      installationId: '42',
      revoked: true,
    });
    await service.restart();
    expect(
      (await service.receipt(await service.control('/revoke-installation', event), true)).raw
    ).toBe(first.raw);
    expect((await service.control('/projection', update(2))).status).toBe(403);
    expect((await mint(await bound())).status).toBe(403);
  });
});
