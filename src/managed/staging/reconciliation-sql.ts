import type { ClientConfig } from 'pg';
import type { ReconciliationCommand } from '../uninstall/reconciliation';

export interface SqlConnection {
  on(event: 'error', listener: () => void): unknown;
  connect(): Promise<unknown>;
  query(text: string, values?: string[]): Promise<{ rows: { receipt: unknown }[] }>;
  end(): Promise<unknown>;
}
export type SqlConnect = (config: ClientConfig) => SqlConnection;
const pending = () => new Error('reconciliation_database_pending');

export type ReconciliationDatabase = Pick<
  Hyperdrive,
  'host' | 'port' | 'user' | 'password' | 'database'
>;

/** Origin TLS is verified by the approved Hyperdrive config, never pg's ignored CA option. */
export function databaseConfig(item: ReconciliationDatabase | undefined): ClientConfig {
  if (
    !item ||
    typeof item.host !== 'string' ||
    item.host.length === 0 ||
    !Number.isSafeInteger(item.port) ||
    item.port < 1 ||
    item.port > 65535 ||
    item.database !== 'postgres' ||
    typeof item.user !== 'string' ||
    !/^bugdrop_reconciliation_transport\.[a-z]{20}$/.test(item.user) ||
    typeof item.password !== 'string' ||
    item.password.length < 16
  )
    throw pending();
  return {
    host: item.host,
    port: item.port,
    database: item.database,
    user: item.user,
    password: item.password,
    // The per-invocation host/password identify the private Hyperdrive binding.
    // Hyperdrive independently enforces verify-full + pinned CA to Supabase.
    ssl: false,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    statement_timeout: 1000,
  };
}

const statement = `select private.apply_verified_uninstall(
  $1::text, $2::private.receipt_hash, $3::private.receipt_hash,
  'github_webhook'::private.github_authority, $4::timestamptz, $5::uuid
) as receipt`;

/** Explicit COMMIT resolves before the result is eligible for receipt validation. */
export async function applySqlUninstall(
  command: ReconciliationCommand,
  connect: () => SqlConnection
): Promise<unknown> {
  const client = connect();
  let receipt: unknown;
  let failed = false;
  // pg emits socket errors independently of query promise rejection. Keep this
  // listener through shutdown and never allow a later result to erase the failure.
  client.on('error', () => {
    failed = true;
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bugdrop_reconciliation');
    const result = await client.query(statement, [
      command.installationId,
      command.eventHash,
      command.installationHash,
      new Date(command.occurredAt).toISOString(),
      command.requestId,
    ]);
    if (result.rows.length !== 1) throw pending();
    await client.query('COMMIT');
    receipt = result.rows[0].receipt;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error &&
      error.code === '23503' &&
      error.message === 'uninstall mapping unavailable'
    ) {
      receipt = { state: 'quarantined', reason: 'mapping_missing' };
    } else {
      failed = true;
    }
  } finally {
    try {
      await client.end();
    } catch {
      failed = true;
    }
  }
  if (failed) throw pending();
  return receipt;
}
