import { bytes, https, uuid, utf8 } from './protocol';
import { digest, fields, ordered, unavailable } from './current-control';

const hash = /^[0-9a-f]{64}$/;
const source = /^[A-Za-z0-9_-]{1,64}$/;
const providerId = /^[1-9][0-9]*$/;
const dottedDns = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
function canonicalProviderId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    providerId.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}
function issuerEndpoint(value: unknown): boolean {
  if (typeof value !== 'string' || !https(value, true)) return false;
  const origin = new URL(value);
  return !origin.port && dottedDns.test(origin.hostname);
}

/** Full C0 syntax checks; original SQL/provisioning/reader fence remain injected trust. */
export async function validatePublicationDetails(
  p: Record<string, unknown>,
  pin: { realm: 'staging'; sourceId: string; sourceEpoch: string }
): Promise<void> {
  const scope = ordered(p.scope, fields.scope);
  const catalog = ordered(p.catalog, fields.catalog);
  if (
    pin.realm !== 'staging' ||
    typeof pin.sourceId !== 'string' ||
    typeof pin.sourceEpoch !== 'string' ||
    !source.test(pin.sourceId) ||
    !uuid.test(pin.sourceEpoch) ||
    p.schemaVersion !== 2 ||
    p.realm !== pin.realm ||
    p.sourceId !== pin.sourceId ||
    p.sourceEpoch !== pin.sourceEpoch ||
    typeof p.publicationId !== 'string' ||
    !uuid.test(p.publicationId) ||
    !Number.isSafeInteger(p.sequence) ||
    (p.sequence as number) < 1 ||
    !Number.isSafeInteger(p.lifecycleVersion) ||
    (p.lifecycleVersion as number) < 1 ||
    !Number.isSafeInteger(p.observedAt) ||
    (p.observedAt as number) < 0 ||
    p.protocolMode !== 2 ||
    p.active !== true ||
    typeof p.credentialVerifierRef !== 'string' ||
    !source.test(p.credentialVerifierRef) ||
    typeof p.catalogDigest !== 'string' ||
    !hash.test(p.catalogDigest) ||
    typeof p.capabilityKid !== 'string' ||
    !/^cap-v2-[A-Za-z0-9_-]{1,57}$/.test(p.capabilityKid) ||
    typeof p.confirmationKid !== 'string' ||
    !source.test(p.confirmationKid) ||
    p.capabilityKid === p.confirmationKid ||
    ['tenantId', 'applicationId', 'destinationId', 'credentialId', 'installationGeneration'].some(
      k => typeof scope[k] !== 'string' || !uuid.test(scope[k])
    ) ||
    !canonicalProviderId(scope.providerInstallationId) ||
    !canonicalProviderId(scope.githubAppId) ||
    typeof scope.keyId !== 'string' ||
    typeof scope.deploymentDigest !== 'string' ||
    !hash.test(scope.deploymentDigest) ||
    !issuerEndpoint(scope.endpoint) ||
    typeof scope.origin !== 'string' ||
    !https(scope.origin) ||
    !Array.isArray(p.keys) ||
    p.keys.length < 2 ||
    p.keys.length > 128 ||
    !Array.isArray(p.v1PublicKeys) ||
    p.v1PublicKeys.length > 128 ||
    catalog.schemaVersion !== 1 ||
    catalog.normalizationVersion !== 1 ||
    !Array.isArray(catalog.server) ||
    !Array.isArray(catalog.browser) ||
    !Array.isArray(catalog.widget) ||
    catalog.widget.length !== 0 ||
    typeof scope.publicApplicationId !== 'string' ||
    !/^app_[A-Za-z0-9_-]{1,96}$/.test(scope.publicApplicationId)
  )
    unavailable();
  bytes(scope.keyId, 16);
  const version = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
  for (const list of [catalog.server, catalog.browser, catalog.widget] as unknown[][]) {
    if (
      list.length > 128 ||
      list.some(
        (v, i) =>
          typeof v !== 'string' || !version.test(v) || (i > 0 && (list[i - 1] as string) >= v)
      )
    )
      unavailable();
  }
  const names: string[] = [];
  const materials: string[] = [];
  for (const item of p.keys as unknown[]) {
    const key = ordered(item, fields.key);
    const jwk = ordered(key.publicKey, fields.jwk);
    if (
      typeof key.kid !== 'string' ||
      !['capability-v2', 'confirmation-v2'].includes(key.purpose as string) ||
      !(key.purpose === 'capability-v2'
        ? /^cap-v2-[A-Za-z0-9_-]{1,57}$/.test(key.kid)
        : source.test(key.kid)) ||
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      typeof jwk.x !== 'string' ||
      typeof jwk.y !== 'string' ||
      !Number.isSafeInteger(key.notBefore) ||
      !Number.isSafeInteger(key.verifyUntil) ||
      (key.notBefore as number) < 0 ||
      (key.notBefore as number) >= (key.verifyUntil as number)
    )
      unavailable();
    bytes(jwk.x, 32);
    bytes(jwk.y, 32);
    await crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    names.push(key.kid);
    materials.push(JSON.stringify(Object.values(jwk)));
  }
  if (
    names.some((name, i) => i > 0 && names[i - 1] >= name) ||
    names.filter(name => name === p.capabilityKid).length !== 1 ||
    names.filter(name => name === p.confirmationKid).length !== 1 ||
    new Set(materials).size !== materials.length
  )
    unavailable();
  for (const item of p.v1PublicKeys as unknown[]) {
    const jwk = ordered(item, fields.jwk);
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') unavailable();
    bytes(jwk.x, 32);
    bytes(jwk.y, 32);
    await crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const material = JSON.stringify(Object.values(jwk));
    if (
      materials.includes(material) ||
      (materials.length > (p.keys as unknown[]).length && materials.at(-1)! >= material)
    )
      unavailable();
    materials.push(material);
  }
  const catalogBytes = utf8(
    'bugdrop:version-catalog:v1\0' +
      JSON.stringify([1, 1, catalog.server, catalog.browser, catalog.widget])
  );
  if ((await digest(catalogBytes)) !== p.catalogDigest) unavailable();
}
