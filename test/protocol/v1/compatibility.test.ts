import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import origins from './fixtures/origin.v1.json';
import submission from './fixtures/submission-binding.v1.json';
import credential from './fixtures/api-key-credential.v1.json';
import {
  canonicalBytes,
  exactOrigin,
  parseBearer,
  parseBinding,
  parseExchange,
  signedOnlyDouble,
  verifyBinding,
} from './service-double';

const origin = origins.valid[0];
const body = () => ({ schemaVersion: 1, ...submission.bound, origin });
function headers() {
  return new Headers({
    Authorization: credential.authorization,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
    'X-BugDrop-Contract-Version': '1',
    'X-BugDrop-SDK-Version': '0.1.0-preview.7',
  });
}

describe('SDK protocol v1 compatibility (test-only service boundary)', () => {
  it('checks the pinned fixture hashes in ordinary CI', () => {
    expect(
      execFileSync(process.execPath, ['scripts/protocol/check-fixture-drift.mjs'], {
        encoding: 'utf8',
      })
    ).toContain('Protocol fixtures match');
  });

  it('derives the exact SDK bearer bytes without sending the root credential', () => {
    const auth = createHmac('sha256', canonicalBytes(credential.rootSecret, 32))
      .update(`bugdrop:auth:v1\0${credential.keyId}`)
      .digest('base64url');
    expect(auth).toBe(credential.authSecret);
    expect(credential.authorization).toBe(`Bearer bd_auth_v1.${credential.keyId}.${auth}`);
    expect(parseBearer(credential.authorization)).toEqual({
      keyId: credential.keyId,
      authSecret: Buffer.from(auth, 'base64url'),
    });
  });

  it.each([
    ...credential.invalidAuthorizations,
    ...credential.invalidApiKeys.map(value => `Bearer ${value}`),
    null,
    '',
    `Bearer ${credential.apiKey}`,
    credential.authorization.toLowerCase(),
    ` ${credential.authorization}`,
    `${credential.authorization} `,
    `${credential.authorization}\n`,
    `${credential.authorization}\r\n`,
    credential.authorization.replace('Bearer ', 'Bearer  '),
    `${credential.authorization}=`,
    `${credential.authorization.slice(0, -1)}p`,
    credential.authorization.replace(credential.keyId, `${credential.keyId}=`),
    credential.authorization.replace(credential.keyId, `${credential.keyId.slice(0, -1)}x`),
  ])('rejects noncanonical or wrong credentials: %s', value => {
    expect(() => parseBearer(value)).toThrow();
  });

  it.each(origins.valid)('accepts canonical origin %s', value => {
    expect(exactOrigin(value)).toBe(value);
    expect(parseExchange(headers(), { ...body(), origin: value }, value).origin).toBe(value);
  });
  it.each([
    ...origins.invalid,
    'https://app.example.com/',
    'https://app.example.com?',
    'https://app.example.com#',
    'null',
    'https://app.example.com.:8443',
    'http://localhost.',
  ])('rejects origin alias %s', value => {
    expect(() => exactOrigin(value)).toThrow();
    expect(() => parseExchange(headers(), { ...body(), origin: value }, origin)).toThrow();
    expect(() => parseExchange(headers(), body(), value)).toThrow();
  });
  it.each([
    'https://other.example.com',
    'https://app.example.com:8443',
    'https://sub.app.example.com',
  ])('rejects canonical but unconfigured origin %s', value => {
    expect(() => parseExchange(headers(), { ...body(), origin: value }, origin)).toThrow();
  });

  it.each(submission.verificationCases)('$name matches the SDK binding result', vector => {
    const verify = () =>
      verifyBinding(submission.bound, vector.submissionId, Buffer.from(vector.requestBody));
    if (vector.accepted) expect(verify).not.toThrow();
    else expect(verify).toThrow();
  });
  it.each([
    ...submission.invalidPayloadDigests,
    `${submission.bound.payloadDigest.slice(0, -1)}R`,
    '',
    null,
    42,
  ])('rejects invalid digest %s', payloadDigest => {
    expect(() => parseExchange(headers(), { ...body(), payloadDigest }, origin)).toThrow();
  });
  it.each(['', 'a'.repeat(201), 'é'.repeat(101), '\ud800', '\udc00', null, 42])(
    'rejects invalid submission ID',
    submissionId => {
      expect(() => parseExchange(headers(), { ...body(), submissionId }, origin)).toThrow();
    }
  );
  it.each(['a', 'é'.repeat(100), '🪲'.repeat(50), ' opaque id '])(
    'preserves valid opaque IDs exactly',
    submissionId => {
      expect(parseBinding({ ...submission.bound, submissionId }).submissionId).toBe(submissionId);
    }
  );
  it.each(['submissionId', 'payloadDigest', 'schemaVersion'])('requires %s', field => {
    const request: Record<string, unknown> = body();
    delete request[field];
    expect(() => parseExchange(headers(), request, origin)).toThrow();
  });
  it('captures the explicit SDK version separately from schema version', () => {
    expect(parseExchange(headers(), body(), origin)).toEqual({
      ...submission.bound,
      origin,
      sdkVersion: '0.1.0-preview.7',
    });
    const requestHeaders = headers();
    requestHeaders.set('X-BugDrop-SDK-Version', '2.3.4');
    expect(parseExchange(requestHeaders, body(), origin).sdkVersion).toBe('2.3.4');
  });
  it.each([
    'Authorization',
    'Content-Type',
    'Accept',
    'X-BugDrop-Contract-Version',
    'X-BugDrop-SDK-Version',
  ])('fails closed without %s', field => {
    const requestHeaders = headers();
    requestHeaders.delete(field);
    expect(() => parseExchange(requestHeaders, body(), origin)).toThrow();
  });
  it.each([
    'subject',
    'sub',
    'reporterId',
    'userId',
    'pseudonym',
    'email',
    'reporter',
    'metadata',
    'applicationId',
    'repository',
    'installation',
    'labels',
  ])('rejects unexpected %s without reflecting canary data', field => {
    const canary = 'private-end-user-canary';
    try {
      parseExchange(headers(), { ...body(), [field]: { identity: canary } }, origin);
      throw new Error('Unexpected acceptance');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(canary);
    }
  });

  it.each(['auth', 'binding', 'delivery'])(
    'never invokes anonymous transport after %s failure',
    async failure => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('No network allowed'));
      const managed = vi.fn(async () => {
        if (failure === 'delivery') throw new Error('unavailable');
      });
      const verify = vi.fn(async () => {
        if (failure === 'auth') throw new Error('unauthorized');
        return submission.bound;
      });
      try {
        expect(
          await signedOnlyDouble(
            verify,
            submission.bound.submissionId,
            Buffer.from(
              failure === 'binding' ? `${submission.requestBody} ` : submission.requestBody
            ),
            managed
          )
        ).toBe('rejected');
        expect(managed).toHaveBeenCalledTimes(failure === 'delivery' ? 1 : 0);
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    }
  );
  it('only hands a verified exact body to managed delivery once', async () => {
    const managed = vi.fn(async () => {});
    expect(
      await signedOnlyDouble(
        async () => submission.bound,
        submission.bound.submissionId,
        Buffer.from(submission.requestBody),
        managed
      )
    ).toBe('accepted');
    expect(managed).toHaveBeenCalledExactlyOnceWith(Buffer.from(submission.requestBody));
  });
});
