import { hmac, reject, utf8 } from '../local/protocol';
import type { UninstallAdapters } from './adapters';

export interface RoutingEnvironment extends UninstallAdapters {
  ENVIRONMENT: string;
  STAGING_UNINSTALL_COMMITMENT_KEY: string;
}
interface RoutingConfig {
  appId: number;
  installationId: number;
}
export async function routingSnapshot(env: RoutingEnvironment, config: RoutingConfig) {
  // Capture credentials and service bindings before the first asynchronous operation.
  const deployment = env.ENVIRONMENT;
  const key = env.STAGING_UNINSTALL_COMMITMENT_KEY;
  const githubAppId = config.appId;
  const providerId = config.installationId;
  const adapters: Readonly<UninstallAdapters> = Object.freeze({
    STAGING_CONTROL: env.STAGING_CONTROL,
    STAGING_RECONCILIATION: env.STAGING_RECONCILIATION,
    STAGING_UNINSTALL_HMAC_KEY: env.STAGING_UNINSTALL_HMAC_KEY,
    STAGING_RECONCILIATION_HMAC_KEY: env.STAGING_RECONCILIATION_HMAC_KEY,
    STAGING_APPLICATION_ID: env.STAGING_APPLICATION_ID,
  });
  if (
    deployment !== 'staging' ||
    !Number.isSafeInteger(githubAppId) ||
    githubAppId < 1 ||
    !Number.isSafeInteger(providerId) ||
    providerId < 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(adapters.STAGING_APPLICATION_ID)
  )
    reject();
  const hash = await hmac(
    key,
    utf8(
      `bugdrop:uninstall:routing:v1\0${JSON.stringify([
        deployment,
        githubAppId,
        adapters.STAGING_APPLICATION_ID,
        providerId,
      ])}`
    )
  );
  return Object.freeze({
    hash,
    installationId: String(providerId),
    githubAppId,
    adapters,
    matches(current: RoutingEnvironment, target: RoutingConfig): boolean {
      return (
        current.ENVIRONMENT === deployment &&
        current.STAGING_UNINSTALL_COMMITMENT_KEY === key &&
        target.appId === githubAppId &&
        target.installationId === providerId &&
        Object.entries(adapters).every(
          ([name, value]) => current[name as keyof UninstallAdapters] === value
        )
      );
    },
  });
}
