import { reconcileVerifiedUninstall } from '../uninstall/reconciliation';
import {
  applySqlUninstall,
  databaseConfig,
  type SqlConnect,
  type ReconciliationDatabase,
} from './reconciliation-sql';

export interface ReconciliationEnv {
  ENVIRONMENT: string;
  STAGING_ENABLED: string;
  STAGING_PROVIDER_INSTALLATION_ID: string;
  STAGING_RECONCILIATION_HMAC_KEY: string;
  STAGING_RECONCILIATION_DATABASE?: ReconciliationDatabase;
}

export async function reconciliationFetch(
  request: Request,
  env: ReconciliationEnv,
  connect: SqlConnect
): Promise<Response> {
  try {
    // Freeze the full configuration before authentication or asynchronous SQL work.
    const {
      ENVIRONMENT: environment,
      STAGING_ENABLED: enabled,
      STAGING_PROVIDER_INSTALLATION_ID: installationId,
      STAGING_RECONCILIATION_HMAC_KEY: key,
      STAGING_RECONCILIATION_DATABASE: database,
    } = env;
    if (environment !== 'staging' || enabled !== 'true') throw new Error('disabled');
    return await reconcileVerifiedUninstall(request, { installationId, key }, command => {
      const config = databaseConfig(database);
      return applySqlUninstall(command, () => connect(config));
    });
  } catch {
    return Response.json({ error: 'uninstall_reconciliation_pending' }, { status: 503 });
  }
}
