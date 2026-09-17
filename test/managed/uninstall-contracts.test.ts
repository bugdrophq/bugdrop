import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { hmac, utf8 } from '../../src/managed/local/protocol';
import { commitments, edgeReceipt, sqlReceipt } from '../../src/managed/uninstall/contracts';

const key = Buffer.alloc(32, 7).toString('base64url');
const work = {
  eventHash: 'a'.repeat(64),
  installationHash: 'b'.repeat(64),
  occurredAt: 1_789_650_000_000,
  requestId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
};
const edge = {
  schemaVersion: 1,
  accepted: true,
  applicationId: 'app-test',
  installationId: '202',
  revoked: true,
};
const sql = { schemaVersion: 1, ...work, installationId: '202', sqlApplied: true };
async function signed(value: unknown, domain: string) {
  const raw = utf8(JSON.stringify(value));
  const signature = await hmac(key, utf8(`${domain}\0${new TextDecoder().decode(raw)}`));
  return { raw, signature };
}
describe('uninstall normalized commitments and independent receipts', () => {
  it('keeps stable scoped commitments distinct across domains and installations', async () => {
    const first = await commitments(key, 101, 202);
    expect(await commitments(key, 101, 202)).toEqual(first);
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.installationHash).not.toBe(first.eventHash);
    expect(await commitments(key, 102, 202)).not.toEqual(first);
    expect(await commitments(key, 101, 203)).not.toEqual(first);
  });
  it('accepts only the authenticated scoped permanent edge receipt', async () => {
    const proof = await signed(edge, 'bugdrop:uninstall:edge-receipt:v1');
    expect(await edgeReceipt(proof, key, 'app-test', '202')).toBe(true);
    expect(await edgeReceipt(proof, key, 'other-app', '202')).toBe(false);
    expect(await edgeReceipt(proof, key, 'app-test', '203')).toBe(false);
    expect(await edgeReceipt({ ...proof, signature: 'bad' }, key, 'app-test', '202')).toBe(false);
  });
  it.each([
    { schemaVersion: 1, accepted: true },
    { ...edge, revoked: false },
    { ...edge, payload: 'private-canary' },
  ])('rejects generic or widened edge evidence', async value => {
    expect(
      await edgeReceipt(
        await signed(value, 'bugdrop:uninstall:edge-receipt:v1'),
        key,
        'app-test',
        '202'
      )
    ).toBe(false);
  });
  it('requires SQL acknowledgement of the exact original intake tuple', async () => {
    const proof = await signed(sql, 'bugdrop:uninstall:sql-receipt:v1');
    expect(await sqlReceipt(proof, key, work, '202')).toBe('applied');
    for (const changed of [
      { ...work, occurredAt: work.occurredAt + 1 },
      { ...work, requestId: 'bd51c858-77ce-4ba2-b806-8fbf07924ace' },
      { ...work, eventHash: 'c'.repeat(64) },
      { ...work, installationHash: 'c'.repeat(64) },
    ])
      expect(await sqlReceipt(proof, key, changed, '202')).toBe('pending');
    expect(await sqlReceipt(proof, key, work, '203')).toBe('pending');
  });
  it('only quarantines authenticated exact mapping-missing evidence', async () => {
    const missing = {
      schemaVersion: 1,
      ...work,
      installationId: '202',
      state: 'quarantined',
      reason: 'mapping_missing',
    };
    const proof = await signed(missing, 'bugdrop:uninstall:sql-receipt:v1');
    expect(await sqlReceipt(proof, key, work, '202')).toBe('quarantined');
    expect(await sqlReceipt({ ...proof, signature: '' }, key, work, '202')).toBe('pending');
    expect(
      await sqlReceipt(
        await signed({ error: 'not_found' }, 'bugdrop:uninstall:sql-receipt:v1'),
        key,
        work,
        '202'
      )
    ).toBe('pending');
  });
});
