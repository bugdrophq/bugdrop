import { describe, expect, it } from 'vitest';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';
import origins from '../protocol/v1/fixtures/origin.v1.json';
import bound from '../protocol/v1/fixtures/submission-binding.v1.json';
import envelope from '../protocol/v1/fixtures/capability-response.v1.json';
import validation from '../protocol/v1/fixtures/capability-validation.v1.json';
import widget from '../protocol/v1/fixtures/widget-public-api.v1.json';
import {
  bearer,
  binding,
  bytes,
  derive,
  digest,
  hmac,
  origin,
  utf8,
} from '../../src/managed/local/protocol';
import { authenticate, type Authority } from '../../src/managed/local/authority';
import { issue, validEnvelope, verify, verifySubmission } from '../../src/managed/local/capability';

async function authority(): Promise<Authority> {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pepper = Buffer.alloc(32, 1).toString('base64url');
  return {
    now: Date.parse(validation.now),
    pepper,
    receiptKey: pepper,
    signingKid: 'fixture-kid',
    signingKeys: [
      {
        kid: 'fixture-kid',
        privateKey: await crypto.subtle.exportKey('jwk', key.privateKey),
        publicKey: await crypto.subtle.exportKey('jwk', key.publicKey),
        notBefore: 0,
        verifyUntil: Date.parse(validation.now) + 86_400_000,
      },
    ],
    projection: {
      tenantId: 'fixture-tenant',
      applicationId: 'fixture-app',
      destinationId: 'fixture-destination',
      installationId: '42',
      configurationVersion: 1,
      authorizationVersion: 1,
      origin: 'https://example.com',
      keyId: credential.keyId,
      verifier: await hmac(pepper, bytes(credential.authSecret, 32)),
      credentialActive: true,
      applicationActive: true,
      installationActive: true,
      tenantActive: true,
      observedAt: Date.parse(validation.now),
    },
  };
}
describe('actual local service consumes merged SDK V1 vectors', () => {
  it('derives and verifies the exact peppered auth-secret contract', async () => {
    expect(await derive(credential.apiKey)).toEqual({
      keyId: credential.keyId,
      authorization: credential.authorization,
    });
    const a = await authority();
    await expect(authenticate(credential.authorization, a)).resolves.toBeUndefined();
    const wrong = {
      ...a,
      projection: {
        ...a.projection,
        verifier: await hmac(a.pepper, bytes(credential.rootSecret, 32)),
      },
    };
    await expect(authenticate(credential.authorization, wrong)).rejects.toThrow(
      'managed_request_rejected'
    );
    for (const value of credential.invalidApiKeys)
      await expect(derive(value)).rejects.toThrow('managed_request_rejected');
    for (const value of credential.invalidAuthorizations)
      expect(() => bearer(value)).toThrow('managed_request_rejected');
  });
  it('enforces exact canonical origins and digest encodings', () => {
    for (const value of origins.valid) expect(origin(value)).toBe(value);
    for (const value of origins.invalid)
      expect(() => origin(value)).toThrow('managed_request_rejected');
    for (const value of bound.invalidPayloadDigests)
      expect(() => binding({ submissionId: 's', payloadDigest: value })).toThrow();
  });
  it('signs the fixture binding and rejects every changed byte/identifier', async () => {
    const a = await authority();
    const token = await issue(bound.bound, a);
    expect(await digest(utf8(bound.requestBody))).toBe(bound.bound.payloadDigest);
    for (const vector of bound.verificationCases) {
      const attempt = verifySubmission(
        token.token,
        a.projection.origin,
        { ...bound.bound, submissionId: vector.submissionId },
        utf8(vector.requestBody),
        a
      );
      if (vector.accepted) await expect(attempt).resolves.toMatchObject(bound.bound);
      else await expect(attempt).rejects.toThrow();
    }
  });
  it('emits canonical V1 envelopes while honoring response-validation fixture boundaries', async () => {
    const a = await authority();
    const token = await issue(bound.bound, a);
    expect(Object.keys(token)).toEqual(Object.keys(envelope));
    expect(validEnvelope(token, a.now)).toBe(true);
    for (const v of validation.expirationCases)
      expect(validEnvelope({ ...envelope, expiresAt: v.expiresAt }, a.now)).toBe(v.accepted);
    expect(widget.authentication.providerParameterType).toBe('submission-binding-v1');
    expect(widget.authentication.providerReturnType).toBe('opaque-token-string');
    expect(typeof token.token).toBe('string');
  });
  it('rejects signature tampering, algorithm/key confusion, foreign scope and expired keys', async () => {
    const a = await authority();
    const c = await issue(bound.bound, a);
    const parts = c.token.split('.');
    for (const header of [
      { alg: 'none', kid: 'fixture-kid' },
      { alg: 'HS256', kid: 'fixture-kid' },
      { alg: 'ES256', kid: 'unknown' },
    ]) {
      const changed = Buffer.from(
        JSON.stringify({ ...header, typ: 'bugdrop-local-capability-v1' })
      ).toString('base64url');
      await expect(verify([changed, ...parts.slice(1)].join('.'), a)).rejects.toThrow();
    }
    const changed = [...parts];
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    changed[2] = signature.toString('base64url');
    await expect(verify(changed.join('.'), a)).rejects.toThrow();
    for (const field of ['tenantId', 'applicationId', 'destinationId', 'installationId'] as const)
      await expect(
        verify(c.token, { ...a, projection: { ...a.projection, [field]: 'other' } })
      ).rejects.toThrow();
    await expect(verify(c.token, { ...a, signingKeys: [] })).rejects.toThrow();
    a.signingKeys[0].verifyUntil = a.now;
    await expect(verify(c.token, a)).rejects.toThrow();
  });
});
