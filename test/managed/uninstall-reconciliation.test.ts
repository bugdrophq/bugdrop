import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { hmac, utf8 } from '../../src/managed/local/protocol';
import { reconcileVerifiedUninstall } from '../../src/managed/uninstall/reconciliation';
import { sqlReceipt } from '../../src/managed/uninstall/contracts';
const key = Buffer.alloc(32, 4).toString('base64url');
const command = {
  schemaVersion: 1 as const,
  installationId: '202',
  eventHash: 'a'.repeat(64),
  installationHash: 'b'.repeat(64),
  occurredAt: 1_789_650_000_000,
  requestId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
};
const scope = { key, installationId: '202' };
async function request(body: unknown = command, signature?: string) {
  const raw = JSON.stringify(body);
  return new Request('http://uninstall.bugdrop.localhost/apply-verified-uninstall', {
    method: 'POST',
    body: raw,
    headers: {
      'X-BugDrop-Control-Signature':
        signature ?? (await hmac(key, utf8(`bugdrop:uninstall:sql-request:v1\0${raw}`))),
    },
  });
}
describe('private SQL adapter authenticates before authoritative callback', () => {
  it('returns only an exact signed committed receipt', async () => {
    const apply = vi.fn(async item => ({ ...item, sqlApplied: true }));
    const response = await reconcileVerifiedUninstall(await request(), scope, apply);
    expect(response.status).toBe(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith(command);
    const { schemaVersion: _schema, installationId: _installation, ...item } = command;
    expect(
      await sqlReceipt(
        {
          raw: new Uint8Array(await response.arrayBuffer()),
          signature: response.headers.get('X-BugDrop-Uninstall-Receipt-Signature')!,
        },
        key,
        item,
        '202'
      )
    ).toBe('applied');
  });
  it.each([
    { ...command, payload: 'private-canary' },
    { ...command, installationId: '203' },
    { ...command, occurredAt: -1 },
  ])('rejects invalid signed scope before SQL', async input => {
    const apply = vi.fn();
    expect((await reconcileVerifiedUninstall(await request(input), scope, apply)).status).toBe(503);
    expect(apply).not.toHaveBeenCalled();
  });
  it('rejects forged authentication and does not reflect adapter error bytes', async () => {
    const apply = vi.fn(async () => {
      throw new Error('private-canary');
    });
    expect(
      (await reconcileVerifiedUninstall(await request(command, 'bad'), scope, apply)).status
    ).toBe(503);
    expect(apply).not.toHaveBeenCalled();
    const response = await reconcileVerifiedUninstall(await request(), scope, apply);
    expect(await response.text()).not.toContain('private-canary');
    expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
  });
  it.each([
    { ...command, sqlApplied: true, token: 'private-canary' },
    { accepted: true },
    { ...command, sqlApplied: false },
  ])('never signs widened or generic SQL success', async result => {
    const response = await reconcileVerifiedUninstall(await request(), scope, async () => result);
    expect(response.status).toBe(503);
    expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
  });
  it('quarantines only the explicit authoritative missing-mapping result', async () => {
    const response = await reconcileVerifiedUninstall(await request(), scope, async () => ({
      state: 'quarantined',
      reason: 'mapping_missing',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...command,
      state: 'quarantined',
      reason: 'mapping_missing',
    });
  });
});
