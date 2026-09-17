import { observeCapability } from '../../src/managed/staging/observation-ingress';
import type { StagingIngressEnv } from '../../src/managed/staging/ingress-env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../../managed/staging/test-adapter.mjs';
let service: Awaited<ReturnType<typeof start>>;
let scope: { runId: string; scenario: string; leaseId: string };
beforeEach(async () => {
  service = await start({ pepper: '', verifier: '', keyset: {}, enableObservation: true });
  const opened = await service.observation('/observation/start', {
    runId: crypto.randomUUID(),
    scenario: 'origin-aliases',
  });
  expect(opened.status).toBe(200);
  expect(opened.valid).toBe(true);
  scope = {
    runId: opened.body.snapshot.runId,
    scenario: 'origin-aliases',
    leaseId: opened.body.leaseId,
  };
});
afterEach(async () => {
  await service.close();
});
const read = () => service.observation('/observation/read', scope);
const begin = () => service.observation('/observation/begin', { sdkVersion: '0.1.0' });
const finish = (sequence: number) =>
  service.observation('/observation/finish', { ...scope, sequence, status: 403 });
describe('private durable staging observation', () => {
  it('misbound authority cannot certify a different application as this lease', async () => {
    await service.close();
    service = await start({
      pepper: '',
      verifier: '',
      keyset: {},
      enableObservation: true,
      issuerOverride: {
        now: Date.now(),
        projection: {
          observedAt: Date.now(),
          credentialActive: true,
          applicationActive: true,
          installationActive: true,
          tenantActive: true,
          origin: 'https://example.com',
          applicationId: 'other-app',
          installationId: '99',
        },
      },
    });
    const opened = await service.observation('/observation/start', {
      runId: crypto.randomUUID(),
      scenario: 'origin-aliases',
    });
    scope = {
      runId: opened.body.snapshot.runId,
      scenario: 'origin-aliases',
      leaseId: opened.body.leaseId,
    };
    const response = await service.publicRequest('/v1/submission-capabilities', {
      method: 'POST',
      headers: { 'X-BugDrop-SDK-Version': '0.1.0' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect((await read()).body.snapshot).toMatchObject({ count: 1, complete: false });
  });
  it('reports an undelivered begin as HTTP503 without claiming it reached durable observation', async () => {
    let invoked = false;
    const env = {
      ENVIRONMENT: 'staging',
      STAGING_ENABLED: 'true',
      STAGING_OBSERVATION_ENABLED: 'true',
      STAGING_APPLICATION_ID: 'app-test',
      STAGING_INSTALLATION_ID: '42',
      STAGING_OBSERVATION_HMAC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      STAGING_OBSERVATION: {
        fetch: async () => {
          throw new Error('unavailable');
        },
      },
    } as unknown as StagingIngressEnv;
    const response = await observeCapability(
      new Request('https://example.com/v1/submission-capabilities'),
      env,
      async () => {
        invoked = true;
        return new Response();
      }
    );
    expect(response.status).toBe(503);
    expect(invoked).toBe(false);
    // The actual collector must poison this run from the SDK outcome, not accept this raw snapshot alone.
    expect((await read()).body.snapshot).toMatchObject({
      count: 0,
      complete: true,
      exclusive: true,
    });
  });
  it('counts rejected HTTP with actual allowlisted header and no private data', async () => {
    expect((await read()).body.snapshot).toMatchObject({
      count: 0,
      complete: true,
      exclusive: true,
    });
    const response = await service.publicRequest('/v1/submission-capabilities', {
      method: 'POST',
      headers: { 'X-BugDrop-SDK-Version': '0.1.0', Authorization: 'PRIVATE_CANARY' },
      body: 'PRIVATE_CANARY',
    });
    expect(response.status).toBe(403);
    const observed = await read();
    expect(observed.valid).toBe(true);
    expect(observed.body.snapshot).toMatchObject({ count: 1, complete: true, exclusive: true });
    expect(observed.body.exchanges).toEqual([{ sequence: 1, sdkVersion: '0.1.0', status: 403 }]);
    expect(JSON.stringify(await service.observationTest({}))).not.toContain('PRIVATE_CANARY');
  });
  it('does not turn unknown SDK header into trusted version', async () => {
    await service.publicRequest('/v1/submission-capabilities', {
      headers: { 'X-BugDrop-SDK-Version': 'PRIVATE_CANARY' },
    });
    const observed = await read();
    expect(observed.body.snapshot.complete).toBe(false);
    expect(observed.body.exchanges[0].sdkVersion).toBeNull();
    expect(JSON.stringify(await service.observationTest({}))).not.toContain('PRIVATE_CANARY');
  });
  it('rejects signatures, scope substitutions, missing selectors and public controls', async () => {
    expect((await service.observation('/observation/read', scope, true)).status).toBe(403);
    for (const change of [
      { applicationId: 'other' },
      { installationId: '43' },
      { leaseId: crypto.randomUUID() },
      { extra: 'private' },
    ])
      expect((await service.observation('/observation/read', { ...scope, ...change })).status).toBe(
        403
      );
    expect((await service.observation('/observation/read', {})).status).toBe(403);
    expect((await service.publicRequest('/observation/read', { method: 'POST' })).status).toBe(403);
  });
  it('inflight and overlapping requests cannot yield complete exclusive evidence', async () => {
    await begin();
    expect((await read()).body.snapshot.complete).toBe(false);
    await begin();
    await finish(1);
    await finish(2);
    expect((await read()).body.snapshot).toMatchObject({
      count: 2,
      complete: false,
      exclusive: false,
    });
  });
  it('bounds retained exchanges and invalidates overflow', async () => {
    for (let i = 1; i <= 64; i++) {
      expect((await begin()).status).toBe(200);
      await finish(i);
    }
    expect((await read()).body.snapshot.complete).toBe(true);
    expect((await begin()).status).toBe(403);
    expect((await read()).body.snapshot).toMatchObject({
      count: 64,
      complete: false,
      exclusive: false,
    });
  });
  it.each(['sync', 'write'])('invalidates %s failure even across restart', async failure => {
    await service.observationTest({ failure });
    expect((await begin()).status).toBe(403);
    expect((await read()).body.snapshot.complete).toBe(false);
    await service.restart();
    expect((await read()).body.snapshot.complete).toBe(false);
  });
  it('restart invalidates a previously complete window', async () => {
    await begin();
    await finish(1);
    await service.restart();
    expect((await read()).body.snapshot.complete).toBe(false);
  });
  it('expiry and repeated alarms remove only observer rows and preserve permanent revocation', async () => {
    expect(
      (await service.control('/revoke-installation', { schemaVersion: 1, installationId: '42' }))
        .status
    ).toBe(200);
    await service.observationTest({ advance: 900000, alarm: true });
    expect((await read()).status).toBe(403);
    const state = await service.observationTest({ alarm: true });
    expect(state.observation).toEqual([]);
    expect(state.revocation).toEqual([{ id: 1 }]);
  });
  it('does not replace a closed lease while its old admission is unfinished', async () => {
    expect((await begin()).status).toBe(200);
    expect((await service.observation('/observation/close', scope)).status).toBe(200);
    expect(
      (
        await service.observation('/observation/start', {
          runId: crypto.randomUUID(),
          scenario: 'revoked',
        })
      ).status
    ).toBe(403);
  });
  it('echoes fresh nonces without retaining them and rejects old schema', async () => {
    const first = await read(),
      second = await read();
    expect(first.body.requestNonce).not.toBe(second.body.requestNonce);
    expect(JSON.stringify(await service.observationTest({}))).not.toContain(
      first.body.requestNonce
    );
    expect(
      (await service.observation('/observation/read', { ...scope, schemaVersion: 1 })).status
    ).toBe(403);
    expect(
      (await service.observation('/observation/read', { ...scope, requestNonce: 'invalid' })).status
    ).toBe(403);
  });
  it('close prevents zero-reset reads and active lease replacement', async () => {
    expect(
      (
        await service.observation('/observation/start', {
          runId: crypto.randomUUID(),
          scenario: 'revoked',
        })
      ).status
    ).toBe(403);
    await service.observation('/observation/close', scope);
    expect((await read()).status).toBe(403);
    expect(
      (await service.publicRequest('/v1/submission-capabilities', { method: 'POST' })).status
    ).toBe(503);
  });
});
