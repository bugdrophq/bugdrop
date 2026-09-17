import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { hmac, utf8 } from '../../src/managed/local/protocol';
import {
  projectionDigest,
  selector,
  receiptResponse,
  verifyReceipt,
  statusMessage,
} from '../../src/managed/staging/control-receipt';
const key = randomBytes(32).toString('base64url');
const expected = {
  schemaVersion: 1 as const,
  applicationId: 'app-test',
  keyId: 'AAAAAAAAAAAAAAAAAAAAAA',
  sequence: 1,
  configurationVersion: 1,
  authorizationVersion: 2,
  projectionDigest: 'a'.repeat(64),
};
describe('private projection receipt contract', () => {
  it('hashes exact bytes including whitespace, not reserialized JSON', async () => {
    expect(await projectionDigest(utf8('{}'))).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
    );
    expect(await projectionDigest(utf8('{} '))).not.toBe(await projectionDigest(utf8('{}')));
  });
  it('requires every selector and rejects extra fields and malformed values', () => {
    expect(selector(expected, 'app-test')).toEqual(expected);
    for (const field of Object.keys(expected)) {
      const partial = { ...expected };
      delete partial[field as keyof typeof partial];
      expect(() => selector(partial, 'app-test')).toThrow();
    }
    for (const changes of [
      { extra: true },
      { sequence: 0 },
      { sequence: 1.2 },
      { keyId: 'key' },
      { applicationId: 'other' },
      { projectionDigest: 'A'.repeat(64) },
      { authorizationVersion: -1 },
    ])
      expect(() => selector({ ...expected, ...changes }, 'app-test')).toThrow();
  });
  it('verifies exact authenticated receipt and rejects generic or mismatched acknowledgements', async () => {
    const receipt = { ...expected, accepted: true as const };
    expect(await verifyReceipt(await receiptResponse(receipt, key), key, expected)).toEqual(
      receipt
    );
    for (const response of [
      Response.json({ schemaVersion: 1, accepted: true }),
      await receiptResponse({ ...receipt, sequence: 2 }, key),
      await receiptResponse(receipt, randomBytes(32).toString('base64url')),
    ])
      await expect(verifyReceipt(response, key, expected)).rejects.toThrow();
  });
  it('does not accept request authentication as response authentication or a tampered body', async () => {
    const raw = JSON.stringify({ ...expected, accepted: true });
    for (const signature of [await hmac(key, utf8(raw)), await hmac(key, statusMessage(utf8(raw)))])
      await expect(
        verifyReceipt(
          new Response(raw, {
            headers: {
              'X-BugDrop-Control-Receipt-Signature': signature,
            },
          }),
          key,
          expected
        )
      ).rejects.toThrow();
    const signed = await receiptResponse({ ...expected, accepted: true }, key);
    await expect(
      verifyReceipt(
        new Response((await signed.text()) + ' ', { headers: signed.headers }),
        key,
        expected
      )
    ).rejects.toThrow();
  });
});
