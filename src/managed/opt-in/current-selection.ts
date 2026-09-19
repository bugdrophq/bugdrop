import { current, identity, registered } from './verifier';
import type { AuthoritySnapshot, CurrentAuthority } from './protocol';
import {
  digest,
  expectedExports,
  fields,
  ordered,
  parseCanonical,
  same,
  unavailable,
  verifyControlMac,
  type ControlEnvelope,
  type Direction,
  type Operation,
} from './current-control';
import { validatePublicationDetails } from './current-validation';
export { controlMac } from './current-control';
export type { ControlEnvelope } from './current-control';

export interface CurrentBundle {
  publication: ControlEnvelope;
  publicationReceipt: ControlEnvelope;
  alias: ControlEnvelope;
  server: ControlEnvelope;
}
export interface SourcePin {
  realm: 'staging';
  sourceId: string;
  sourceEpoch: string;
}
export interface CurrentSelector {
  publicationDigest: string;
  publicationId: string;
  sequence: number;
  lifecycleVersion: number;
}
export interface QualifiedFence extends CurrentSelector {
  qualified: true;
  sourceEpoch: string;
}
export interface ProvisionedAuthority {
  publicationDigest: string;
  credentialVerifierRef: string;
  authenticate: AuthoritySnapshot['authenticate'];
  signingKeys: ReadonlyMap<string, CryptoKey>;
}
export interface CurrentSelectionDependencies {
  pin: SourcePin;
  key: (
    operation: Exclude<Operation, 'outcome.execute'>,
    direction: Direction,
    keyId: string,
    pin: SourcePin,
    at: number
  ) => Uint8Array | undefined;
  fence: () => QualifiedFence | undefined;
  provision: (
    publicationDigest: string,
    verifierRef: string
  ) => Promise<ProvisionedAuthority | undefined>;
  now?: () => number;
}
function selector(
  publication: Record<string, unknown>,
  publicationDigest: string
): CurrentSelector {
  return {
    publicationDigest,
    publicationId: publication.publicationId as string,
    sequence: publication.sequence as number,
    lifecycleVersion: publication.lifecycleVersion as number,
  };
}
function selected(
  fence: QualifiedFence | undefined,
  selected: CurrentSelector,
  epoch: string
): boolean {
  return (
    fence?.qualified === true &&
    fence.sourceEpoch === epoch &&
    same(
      [fence.publicationDigest, fence.publicationId, fence.sequence, fence.lifecycleVersion],
      [
        selected.publicationDigest,
        selected.publicationId,
        selected.sequence,
        selected.lifecycleVersion,
      ]
    )
  );
}
function usableKeys(snapshot: AuthoritySnapshot, now: number): void {
  const capability = registered(snapshot, snapshot.capabilityKid, 'capability-v2', now);
  const confirmation = registered(snapshot, snapshot.confirmationKid, 'confirmation-v2', now);
  if (
    capability.verifyUntil < (Math.floor(now / 1000) + 300) * 1000 ||
    confirmation.verifyUntil < now + 65_000
  )
    unavailable();
}

/** Private in-process selector. No route or production fence/provisioner is installed here. */
export class CurrentSelection {
  private lastAccepted?: { selected: CurrentSelector; publication: Record<string, unknown> };
  private installed?: {
    selected: CurrentSelector;
    publication: Record<string, unknown>;
    alias: Record<string, unknown>;
    server: Record<string, unknown>;
    provisioned: ProvisionedAuthority;
    authorityIdentity: string;
  };
  private readonly now: () => number;
  constructor(private readonly deps: CurrentSelectionDependencies) {
    this.now = deps.now ?? (() => Date.now());
  }
  private key(
    operation: Exclude<Operation, 'outcome.execute'>,
    direction: Direction,
    envelope: ControlEnvelope
  ): Uint8Array {
    const key = this.deps.key(operation, direction, envelope.keyId, this.deps.pin, this.now());
    if (!key) unavailable();
    return key;
  }
  async install(bundle: CurrentBundle): Promise<void> {
    // A failed or partial update never leaves an old positive cache usable.
    this.installed = undefined;
    try {
      for (const [operation, envelope, direction] of [
        ['publication.accept', bundle.publication, 'request'],
        ['publication.accept', bundle.publicationReceipt, 'receipt'],
        ['alias.export', bundle.alias, 'request'],
        ['server-config.export', bundle.server, 'request'],
      ] as const)
        await verifyControlMac(
          operation,
          direction,
          this.key(operation, direction, envelope),
          envelope
        );
      const p = parseCanonical(bundle.publication.raw, fields.publication);
      const a = parseCanonical(bundle.alias.raw, fields.alias);
      const s = parseCanonical(bundle.server.raw, fields.server);
      const r = parseCanonical(bundle.publicationReceipt.raw, fields.receipt);
      await validatePublicationDetails(p, this.deps.pin);
      ordered(ordered(s.options, fields.options).catalog, fields.catalog);
      const options = ordered(s.options, fields.options);
      if (!Array.isArray(options.confirmationKeys) || options.confirmationKeys.length !== 1)
        unavailable();
      ordered(
        ordered((options.confirmationKeys as unknown[])[0], ['kid', 'publicKey']).publicKey,
        fields.jwk
      );
      const scope = p.scope as Record<string, unknown>;
      const pin = this.deps.pin;
      if (
        p.schemaVersion !== 2 ||
        p.realm !== pin.realm ||
        p.sourceId !== pin.sourceId ||
        p.sourceEpoch !== pin.sourceEpoch ||
        p.protocolMode !== 2 ||
        p.active !== true ||
        !Number.isSafeInteger(p.sequence) ||
        (p.sequence as number) < 1 ||
        !Number.isSafeInteger(p.lifecycleVersion) ||
        (p.lifecycleVersion as number) < 1 ||
        typeof p.credentialVerifierRef !== 'string'
      )
        unavailable();
      const publicationDigest = await digest(bundle.publication.raw);
      const chosen = selector(p, publicationDigest);
      if (
        !same(r, {
          schemaVersion: 2,
          accepted: true,
          sourceEpoch: pin.sourceEpoch,
          applicationId: scope.applicationId,
          keyId: scope.keyId,
          publicationId: p.publicationId,
          sequence: p.sequence,
          lifecycleVersion: p.lifecycleVersion,
          publicationDigest,
        })
      )
        unavailable();
      const expected = expectedExports(p, publicationDigest);
      if (!same(a, expected.alias) || !same(s, expected.server)) unavailable();
      if (!selected(this.deps.fence(), chosen, pin.sourceEpoch)) unavailable();
      const last = this.lastAccepted;
      if (last) {
        const original = last.publication;
        const oldScope = original.scope as Record<string, unknown>;
        if (
          chosen.sequence < last.selected.sequence ||
          (chosen.sequence === last.selected.sequence && !same(chosen, last.selected)) ||
          (p.observedAt as number) < (original.observedAt as number) ||
          [
            'tenantId',
            'applicationId',
            'installationGeneration',
            'publicApplicationId',
            'providerInstallationId',
            'githubAppId',
          ].some(k => scope[k] !== oldScope[k])
        )
          unavailable();
        if (chosen.sequence > last.selected.sequence) {
          const renewal =
            p.publicationId === original.publicationId &&
            p.lifecycleVersion === original.lifecycleVersion;
          if (
            renewal &&
            !same({ ...p, sequence: 0, observedAt: 0 }, { ...original, sequence: 0, observedAt: 0 })
          )
            unavailable();
          if (
            !renewal &&
            (p.publicationId === original.publicationId ||
              (p.lifecycleVersion as number) <= (original.lifecycleVersion as number))
          )
            unavailable();
        }
      }
      const provisioned = await this.deps.provision(
        publicationDigest,
        p.credentialVerifierRef as string
      );
      if (
        !provisioned ||
        provisioned.publicationDigest !== publicationDigest ||
        provisioned.credentialVerifierRef !== p.credentialVerifierRef ||
        !provisioned.signingKeys.has(p.capabilityKid as string) ||
        !provisioned.signingKeys.has(p.confirmationKid as string)
      )
        unavailable();
      if (!selected(this.deps.fence(), chosen, pin.sourceEpoch)) unavailable();
      const snapshot = this.snapshot(p, provisioned);
      current(() => snapshot, this.now());
      usableKeys(snapshot, this.now());
      this.installed = {
        selected: chosen,
        publication: p,
        alias: a,
        server: s,
        provisioned,
        authorityIdentity: identity(snapshot),
      };
      this.lastAccepted = { selected: chosen, publication: p };
    } catch {
      unavailable();
    }
  }
  private snapshot(
    p: Record<string, unknown>,
    provisioned: ProvisionedAuthority
  ): AuthoritySnapshot {
    return {
      publicationId: p.publicationId as string,
      lifecycleVersion: p.lifecycleVersion as number,
      observedAt: p.observedAt as number,
      active: true,
      protocolMode: 2,
      scope: structuredClone(p.scope) as AuthoritySnapshot['scope'],
      catalog: structuredClone(p.catalog) as AuthoritySnapshot['catalog'],
      catalogDigest: p.catalogDigest as string,
      capabilityKid: p.capabilityKid as string,
      confirmationKid: p.confirmationKid as string,
      keys: (p.keys as AuthoritySnapshot['keys']).map(k => ({
        ...structuredClone(k),
        signingKey: provisioned.signingKeys.get(k.kid),
      })),
      v1PublicKeys: structuredClone(p.v1PublicKeys) as JsonWebKey[],
      authenticate: provisioned.authenticate,
    };
  }
  readonly authority: CurrentAuthority = () => {
    const value = this.installed;
    if (!value || !selected(this.deps.fence(), value.selected, this.deps.pin.sourceEpoch))
      return undefined;
    try {
      const snapshot = this.snapshot(value.publication, value.provisioned);
      current(() => snapshot, this.now());
      usableKeys(snapshot, this.now());
      return identity(snapshot) === value.authorityIdentity ? snapshot : undefined;
    } catch {
      return undefined;
    }
  };
  exports(): { alias: object; server: object } | undefined {
    if (!this.authority()) return undefined;
    return {
      alias: structuredClone(this.installed!.alias),
      server: structuredClone(this.installed!.server),
    };
  }
}
