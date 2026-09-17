import { Buffer } from 'node:buffer';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { hmac, utf8 } from '../../src/managed/local/protocol';
import { applySqlUninstall, databaseConfig } from '../../src/managed/staging/reconciliation-sql';
import { reconciliationFetch } from '../../src/managed/staging/reconciliation-handler';

const key = Buffer.alloc(32, 4).toString('base64url');
const command = {
  schemaVersion: 1 as const,
  installationId: '202',
  eventHash: 'a'.repeat(64),
  installationHash: 'b'.repeat(64),
  occurredAt: 1_789_650_000_000,
  requestId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
};
const config = {
  host: 'example.hyperdrive.local',
  port: 5432,
  database: 'postgres',
  user: 'bugdrop_reconciliation_transport.xwvgzjmzjilkkofvmrat',
  password: 'test-only-not-a-live-password',
};
const env = {
  ENVIRONMENT: 'staging',
  STAGING_ENABLED: 'true',
  STAGING_PROVIDER_INSTALLATION_ID: '202',
  STAGING_RECONCILIATION_HMAC_KEY: key,
  STAGING_RECONCILIATION_DATABASE: config,
};
async function request(signature?: string) {
  const body = JSON.stringify(command);
  return new Request('http://reconciliation.bugdrop.localhost/apply-verified-uninstall', {
    method: 'POST',
    body,
    headers: {
      'X-BugDrop-Control-Signature':
        signature ?? (await hmac(key, utf8(`bugdrop:uninstall:sql-request:v1\0${body}`))),
    },
  });
}
function connection(receipt: unknown = { ...command, sqlApplied: true }) {
  return {
    on: vi.fn(),
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [{ receipt }] })),
    end: vi.fn(async () => {}),
  };
}

describe('hosted private reconciliation transport', () => {
  it('contains pg error events even when a query also resolves', async () => {
    const client = new Client();
    vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    vi.spyOn(client, 'end').mockResolvedValue(undefined);
    vi.spyOn(client, 'query').mockImplementation(() => {
      client.emit('error', new Error('private-socket-canary'));
      return Promise.resolve({ rows: [{ receipt: { ...command, sqlApplied: true } }] });
    });
    const response = await reconciliationFetch(await request(), env, () => client);
    expect(response.status).toBe(503);
    expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
    expect(await response.text()).not.toContain('private-socket-canary');
    expect(client.listenerCount('error')).toBe(1);
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('authenticates before opening a connection', async () => {
    const connect = vi.fn();
    const response = await reconciliationFetch(await request('bad'), env, connect);
    expect(response.status).toBe(503);
    expect(connect).not.toHaveBeenCalled();
  });
  it('commits the restricted role transaction with the original tuple and closes', async () => {
    const client = connection();
    const response = await reconciliationFetch(await request(), env, () => client);
    expect(response.status).toBe(200);
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("'github_webhook'::private.github_authority"),
      [
        '202',
        command.eventHash,
        command.installationHash,
        new Date(command.occurredAt).toISOString(),
        command.requestId,
      ]
    );
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'SET LOCAL ROLE bugdrop_reconciliation');
    expect(client.query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ...command, sqlApplied: true });
  });
  it.each(['connect', 'query', 'end'] as const)(
    'withholds receipts on %s failure',
    async method => {
      const client = connection();
      client[method].mockRejectedValueOnce(new Error('secret-canary'));
      const response = await reconciliationFetch(await request(), env, () => client);
      expect(response.status).toBe(503);
      expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
      expect(await response.text()).not.toContain('secret-canary');
      expect(client.end).toHaveBeenCalledOnce();
    }
  );
  it.each([
    { code: '23503', message: 'unrelated foreign key failure' },
    { code: '08006', message: 'uninstall mapping unavailable' },
  ])('does not misclassify a generic SQL failure as authoritative quarantine', async error => {
    const client = connection();
    client.query.mockRejectedValueOnce(error);
    await expect(applySqlUninstall(command, () => client)).rejects.toThrow(
      'reconciliation_database_pending'
    );
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('quarantines the exact authoritative missing-mapping error', async () => {
    const client = connection();
    client.query.mockRejectedValueOnce({ code: '23503', message: 'uninstall mapping unavailable' });
    expect(await applySqlUninstall(command, () => client)).toEqual({
      state: 'quarantined',
      reason: 'mapping_missing',
    });
  });
  it('withholds an otherwise valid receipt when COMMIT is uncertain', async () => {
    const client = connection();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ receipt: { ...command, sqlApplied: true } }] })
      .mockRejectedValueOnce(new Error('connection lost during commit'));
    const response = await reconciliationFetch(await request(), env, () => client);
    expect(response.status).toBe(503);
    expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('does not sign an unexpected widened SQL receipt', async () => {
    const response = await reconciliationFetch(await request(), env, () =>
      connection({ ...command, sqlApplied: true, extra: 'secret-canary' })
    );
    expect(response.status).toBe(503);
    expect(response.headers.has('X-BugDrop-Uninstall-Receipt-Signature')).toBe(false);
  });
  it.each([
    { STAGING_ENABLED: 'false' },
    { ENVIRONMENT: 'production' },
    { STAGING_PROVIDER_INSTALLATION_ID: 'UNAPPROVED' },
  ])('denies unapproved configuration before DB', async change => {
    const connect = vi.fn();
    expect(
      (await reconciliationFetch(await request(), { ...env, ...change }, connect)).status
    ).toBe(503);
    expect(connect).not.toHaveBeenCalled();
  });
  it('uses private Hyperdrive coordinates and bounded connection/query timeouts', () => {
    expect(databaseConfig(config)).toMatchObject({
      ...config,
      ssl: false,
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
      statement_timeout: 1000,
    });
  });
  it.each([
    { user: 'postgres' },
    { host: '' },
    { port: 0 },
    { password: '' },
    { database: 'another' },
  ])('rejects invalid or privileged binding coordinates', change => {
    expect(() => databaseConfig({ ...config, ...change })).toThrow();
  });
  it('fails closed when the approved Hyperdrive binding is absent', async () => {
    const connect = vi.fn();
    const response = await reconciliationFetch(
      await request(),
      { ...env, STAGING_RECONCILIATION_DATABASE: undefined },
      connect
    );
    expect(response.status).toBe(503);
    expect(connect).not.toHaveBeenCalled();
  });
});
