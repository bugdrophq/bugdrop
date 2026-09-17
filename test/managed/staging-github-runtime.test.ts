import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, webcrypto, createHmac } from 'node:crypto';
import { start } from '../../managed/staging/test-adapter.mjs';
import { derive, bearer, hmac, digest, utf8 } from '../../src/managed/local/protocol';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';
import { config, installation, privateKey, report, tokenResponse } from './github-staging-fixtures';
let service: Awaited<ReturnType<typeof start>>;
afterEach(async () => {
  await service?.close();
}, 30000);
async function setup({
  publicRepository = false,
  revokeInPreflight = false,
  expireInPreflight = false,
} = {}) {
  const events: string[] = [];
  const webhookSecret = 'synthetic_webhook_key_for_local_worker_only';
  const transport = async (request: Request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.github.com');
    if (url.pathname.endsWith('/access_tokens')) {
      events.push('token');
      if (revokeInPreflight)
        expect(
          (
            await service.control('/revoke-installation', {
              schemaVersion: 1,
              installationId: '202',
            })
          ).status
        ).toBe(200);
      if (expireInPreflight) await new Promise(resolve => setTimeout(resolve, 1800));
      const response = tokenResponse();
      response.token = 'x'.repeat(520);
      response.repositories[0] = { ...response.repositories[0], private: !publicRepository };
      return Response.json(response, { status: 201 });
    }
    if (url.pathname.endsWith('/issues')) {
      events.push('issue');
      return Response.json({ html_url: 'https://github.com/private-canary' }, { status: 201 });
    }
    events.push('installation');
    return Response.json(installation);
  };
  const pepper = randomBytes(32).toString('base64url');
  const derived = await derive(credential.apiKey);
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  service = await start({
    installationId: '202',
    pepper,
    verifier: await hmac(pepper, bearer(derived.authorization).authSecret),
    keyset: {
      activeKid: 'staging-test',
      keys: [
        {
          kid: 'staging-test',
          publicKey: await webcrypto.subtle.exportKey('jwk', pair.publicKey),
          privateKey: await webcrypto.subtle.exportKey('jwk', pair.privateKey),
          notBefore: Date.now() - 1000,
          verifyUntil: Date.now() + 3600000,
        },
      ],
    },
    github: { config, privateKey, webhookSecret, transport },
  });
  const projection = {
    tenantId: 'tenant-test',
    applicationId: 'app-test',
    destinationId: 'destination-test',
    installationId: '202',
    keyId: derived.keyId,
    configurationVersion: 1,
    authorizationVersion: 1,
    origin: 'https://example.com',
    credentialActive: true,
    applicationActive: true,
    installationActive: true,
    tenantActive: true,
    observedAt: Date.now() - (expireInPreflight ? 29000 : 0),
  };
  expect(
    (await service.control('/projection', { schemaVersion: 1, sequence: 1, projection })).status
  ).toBe(200);
  const binding = { submissionId: crypto.randomUUID(), payloadDigest: await digest(utf8(report)) };
  const minted = await service.publicRequest('/v1/submission-capabilities', {
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
  expect(minted.status).toBe(200);
  const capability = await minted.json();
  const submit = () =>
    service
      .request('/submit/submit', {
        method: 'POST',
        body: JSON.stringify({
          token: capability.token,
          binding,
          origin: projection.origin,
          body: Buffer.from(report).toString('base64url'),
        }),
      })
      .then(r => r.json());
  return { events, submit, webhookSecret };
}
describe.sequential('staging wrapper with actual workerd crypto and intercepted GitHub', () => {
  it('uses PKCS1 key and opaque token, verifies private repo and dispatches once across restart', async () => {
    const { events, submit } = await setup();
    expect((await submit()).outcome).toBe('delivered');
    await service.restart();
    expect((await submit()).outcome).toBe('delivered');
    expect(events).toEqual(['installation', 'token', 'issue']);
    expect(JSON.stringify(service.evidence())).not.toContain('private-canary');
    expect(JSON.stringify(service.evidence())).not.toContain(report);
  });
  it.each(['public', 'revoked', 'expired'])(
    'does not create an Issue when %s at final preflight',
    async reason => {
      const { events, submit } = await setup({
        publicRepository: reason === 'public',
        revokeInPreflight: reason === 'revoked',
        expireInPreflight: reason === 'expired',
      });
      expect((await submit()).outcome).toBe('indeterminate');
      expect(events).toEqual(['installation', 'token']);
      await submit();
      expect(events).toEqual(['installation', 'token']);
    }
  );
  it('verifies public staging webhook before durably latching uninstall across restart', async () => {
    const { submit, webhookSecret } = await setup();
    const raw = JSON.stringify({ action: 'deleted', installation });
    const send = (sig: string) =>
      service.publicRequest('/github/staging/webhook', {
        method: 'POST',
        headers: { 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': sig },
        body: raw,
      });
    expect((await send('sha256=' + '0'.repeat(64))).status).toBe(403);
    const signature = 'sha256=' + createHmac('sha256', webhookSecret).update(raw).digest('hex');
    expect((await send(signature)).status).toBe(200);
    await service.restart();
    expect((await submit()).outcome).toBe('rejected');
  });
});
