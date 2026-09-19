import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CurrentSelection,
  controlMac,
  type ControlEnvelope,
  type CurrentBundle,
  type QualifiedFence,
} from '../../src/managed/opt-in/current-selection';
import { executeScopedOutcome } from '../../src/managed/opt-in/current-adapter';
import { identity, recheck } from '../../src/managed/opt-in/verifier';
import { encodeOutcome, type OutcomeCommand } from '../../src/managed/opt-in/outcome-command';

const clock = 1_800_000_000_000;
const pin = {
  realm: 'staging' as const,
  sourceId: 'synthetic-source',
  sourceEpoch: '99999999-9999-4999-8999-999999999999',
};
const pub = {
  schemaVersion: 2,
  realm: 'staging',
  sourceId: pin.sourceId,
  sourceEpoch: pin.sourceEpoch,
  publicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sequence: 1,
  lifecycleVersion: 1,
  observedAt: clock,
  protocolMode: 2,
  active: true,
  scope: {
    tenantId: '44444444-4444-4444-8444-444444444444',
    applicationId: '55555555-5555-4555-8555-555555555555',
    destinationId: '66666666-6666-4666-8666-666666666666',
    credentialId: '22222222-2222-4222-8222-222222222222',
    installationGeneration: '33333333-3333-4333-8333-333333333333',
    providerInstallationId: '9001',
    githubAppId: '8001',
    publicApplicationId: 'app_fixture',
    keyId: 'ICEiIyQlJicoKSorLC0uLw',
    endpoint: 'https://issuance.example.test/v2/submission-capabilities',
    origin: 'https://customer.example.test',
    deploymentDigest: 'a'.repeat(64),
  },
  credentialVerifierRef: 'fixture-verifier',
  catalogDigest: 'd3ac8a92c537d29b53f4d4fe6a8a73a5358997cda02ab25b76f61fa4304e6995',
  catalog: {
    schemaVersion: 1,
    normalizationVersion: 1,
    server: ['0.1.0'],
    browser: ['0.1.0', '0.2.0'],
    widget: [],
  },
  capabilityKid: 'cap-v2-fixture',
  confirmationKid: 'confirm-v2-fixture',
  keys: [
    {
      kid: 'cap-v2-fixture',
      purpose: 'capability-v2',
      publicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg',
        y: 'B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E',
      },
      notBefore: clock - 1000,
      verifyUntil: clock + 3_600_000,
    },
    {
      kid: 'confirm-v2-fixture',
      purpose: 'confirmation-v2',
      publicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
        y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
      },
      notBefore: clock - 1000,
      verifyUntil: clock + 3_600_000,
    },
  ],
  v1PublicKeys: [],
};
type Publication = typeof pub;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
const b64 = (raw: Uint8Array) => Buffer.from(raw).toString('base64url');
const requestKeys = {
  'publication.accept': Buffer.alloc(32, 0x10),
  'alias.export': Buffer.alloc(32, 0x12),
  'server-config.export': Buffer.alloc(32, 0x13),
};
const receiptKey = Buffer.alloc(32, 0x30);
type Operation = keyof typeof requestKeys;
async function envelope(
  value: unknown,
  operation: Operation,
  receipt = false
): Promise<ControlEnvelope> {
  const raw = bytes(value);
  return {
    raw,
    keyId: 'synthetic-control',
    mac: b64(
      await controlMac(
        operation,
        receipt ? 'receipt' : 'request',
        receipt ? receiptKey : requestKeys[operation],
        raw
      )
    ),
  };
}
async function bundle(p: Publication): Promise<CurrentBundle> {
  const publicationDigest = sha(bytes(p));
  const s = p.scope;
  const alias = {
    schemaVersion: 2,
    realm: 'staging',
    sourceEpoch: pin.sourceEpoch,
    publicationId: p.publicationId,
    sequence: p.sequence,
    publicationDigest,
    publicApplicationId: s.publicApplicationId,
    applicationId: s.applicationId,
    installationGeneration: s.installationGeneration,
    credentialId: s.credentialId,
    keyId: s.keyId,
    endpoint: s.endpoint,
    deploymentDigest: s.deploymentDigest,
    observedAt: p.observedAt,
  };
  const server = {
    schemaVersion: 2,
    realm: 'staging',
    sourceEpoch: pin.sourceEpoch,
    publicationId: p.publicationId,
    sequence: p.sequence,
    publicationDigest,
    observedAt: p.observedAt,
    options: {
      endpoint: s.endpoint,
      origin: s.origin,
      applicationId: s.publicApplicationId,
      credentialId: s.credentialId,
      keyId: s.keyId,
      installationGeneration: s.installationGeneration,
      deploymentDigest: s.deploymentDigest,
      catalogDigest: p.catalogDigest,
      catalog: p.catalog,
      confirmationKeys: [{ kid: p.confirmationKid, publicKey: p.keys[1].publicKey }],
    },
  };
  const receipt = {
    schemaVersion: 2,
    accepted: true,
    sourceEpoch: pin.sourceEpoch,
    applicationId: s.applicationId,
    keyId: s.keyId,
    publicationId: p.publicationId,
    sequence: p.sequence,
    lifecycleVersion: p.lifecycleVersion,
    publicationDigest,
  };
  return {
    publication: await envelope(p, 'publication.accept'),
    publicationReceipt: await envelope(receipt, 'publication.accept', true),
    alias: await envelope(alias, 'alias.export'),
    server: await envelope(server, 'server-config.export'),
  };
}
function harness(sourcePin = pin) {
  let fence: QualifiedFence | undefined;
  let now = clock;
  const provision = vi.fn(async (digest: string, credentialVerifierRef: string) => ({
    publicationDigest: digest,
    credentialVerifierRef,
    authenticate: async () => true,
    signingKeys: new Map([
      ['cap-v2-fixture', {} as CryptoKey],
      ['confirm-v2-fixture', {} as CryptoKey],
    ]),
  }));
  const selection = new CurrentSelection({
    pin: sourcePin,
    key: (operation, direction, keyId, source) =>
      keyId === 'synthetic-control' && source === sourcePin
        ? direction === 'receipt'
          ? receiptKey
          : requestKeys[operation]
        : undefined,
    fence: () => fence,
    provision,
    now: () => now,
  });
  return {
    selection,
    provision,
    setFence: (p?: Publication) => {
      fence = p && {
        qualified: true,
        sourceEpoch: sourcePin.sourceEpoch,
        publicationDigest: sha(bytes(p)),
        publicationId: p.publicationId,
        sequence: p.sequence,
        lifecycleVersion: p.lifecycleVersion,
      };
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

it('matches the frozen C0 first-publication digest and request MAC', async () => {
  const first = await bundle(pub);
  expect(sha(first.publication.raw)).toBe(
    'dcbb0a85603a637d80bee53145dd15862003b33d80a03bc466b84f5af12e9117'
  );
  expect(first.publication.mac).toBe('_kSsyv2N0kqAsM9G-mf1pMgojJafIoo2-Q84Tut-VW4');
  expect(first.publicationReceipt.mac).toBe('LQLsfPy7sAYJ2Zvv2b8zTpzZOXaTjgf2ziBo7mv2ZOw');
  expect(first.alias.mac).toBe('_hRK8ZvDHHSB0un0ga-6Zu12DDg0G4M99181dgjHM_k');
  expect(first.server.mac).toBe('sIJO2JVHxR1xr_CmmDIaAhTWBqwehucx1_X4zbHUTao');
});
it('requires an independent qualified current fence and matching provisioner', async () => {
  const h = harness();
  await expect(h.selection.install(await bundle(pub))).rejects.toThrow(
    'current_authority_unavailable'
  );
  expect(h.provision).not.toHaveBeenCalled();
  h.setFence(pub);
  await h.selection.install(await bundle(pub));
  expect(h.selection.authority()?.scope.publicApplicationId).toBe('app_fixture');
  expect(h.selection.exports()?.server).toMatchObject({
    options: { applicationId: 'app_fixture' },
  });
  h.setFence();
  expect(h.selection.authority()).toBeUndefined();
  expect(h.selection.exports()).toBeUndefined();
});
it('rejects authenticated but mixed alias/server exports and closes the prior cache', async () => {
  const h = harness();
  h.setFence(pub);
  await h.selection.install(await bundle(pub));
  const changed = structuredClone(pub);
  changed.sequence = 2;
  changed.observedAt = clock + 10_000;
  h.setFence(changed);
  const mixed = await bundle(changed);
  mixed.alias = (await bundle(pub)).alias;
  await expect(h.selection.install(mixed)).rejects.toThrow('current_authority_unavailable');
  expect(h.selection.authority()).toBeUndefined();
  const other = await bundle(changed);
  const server = JSON.parse(new TextDecoder().decode(other.server.raw));
  server.options.credentialId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  other.server = await envelope(server, 'server-config.export');
  await expect(h.selection.install(other)).rejects.toThrow('current_authority_unavailable');
  expect(h.selection.authority()).toBeUndefined();
});
it('cannot revive an original P5 admission after A→B→A-content revisions', async () => {
  const h = harness();
  h.setFence(pub);
  await h.selection.install(await bundle(pub));
  const original = identity(h.selection.authority()!);
  const changed = structuredClone(pub);
  changed.publicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  changed.sequence = 2;
  changed.lifecycleVersion = 2;
  changed.observedAt = clock + 10_000;
  changed.catalog.server.push('0.3.0');
  changed.catalogDigest = '0d6204663e9c4dd6c1ffcc1573e95ed4f86b5143cf4a7b981c35a284f139208d';
  h.setFence(changed);
  h.setNow(clock + 10_000);
  await h.selection.install(await bundle(changed));
  expect(() => recheck(h.selection.authority, original, clock + 10_000)).toThrow('scope_rejected');
  const reverted = structuredClone(pub);
  reverted.publicationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  reverted.sequence = 3;
  reverted.lifecycleVersion = 3;
  reverted.observedAt = clock + 20_000;
  h.setFence(reverted);
  h.setNow(clock + 20_000);
  await h.selection.install(await bundle(reverted));
  expect(() => recheck(h.selection.authority, original, clock + 20_000)).toThrow('scope_rejected');
  expect(h.selection.authority()?.publicationId).toBe(reverted.publicationId);
});
it('preserves P5 identity for a freshness-only renewal', async () => {
  const h = harness();
  h.setFence(pub);
  await h.selection.install(await bundle(pub));
  const original = identity(h.selection.authority()!);
  const renewal = structuredClone(pub);
  renewal.sequence = 2;
  renewal.observedAt = clock + 10_000;
  h.setFence(renewal);
  h.setNow(clock + 10_000);
  await h.selection.install(await bundle(renewal));
  expect(identity(recheck(h.selection.authority, original, clock + 10_000))).toBe(original);
});
it('does not forget the accepted sequence after a failed replacement', async () => {
  const h = harness();
  h.setFence(pub);
  await h.selection.install(await bundle(pub));
  const newer = structuredClone(pub);
  newer.sequence = 2;
  newer.observedAt = clock + 10_000;
  h.setFence(newer);
  h.setNow(clock + 10_000);
  await h.selection.install(await bundle(newer));
  const broken = await bundle(newer);
  broken.alias.mac = broken.publication.mac;
  await expect(h.selection.install(broken)).rejects.toThrow('current_authority_unavailable');
  h.setFence(pub);
  await expect(h.selection.install(await bundle(pub))).rejects.toThrow(
    'current_authority_unavailable'
  );
  expect(h.selection.authority()).toBeUndefined();
});
it('rejects a coercible array alias and a wrong-purpose selected key', async () => {
  const h = harness();
  const aliasArray = structuredClone(pub) as unknown as Record<string, unknown>;
  (aliasArray.scope as Record<string, unknown>).publicApplicationId = ['app_fixture'];
  h.setFence(aliasArray as Publication);
  await expect(h.selection.install(await bundle(aliasArray as Publication))).rejects.toThrow(
    'current_authority_unavailable'
  );
  const wrongKey = structuredClone(pub);
  wrongKey.keys[0].purpose = 'confirmation-v2';
  h.setFence(wrongKey);
  await expect(h.selection.install(await bundle(wrongKey))).rejects.toThrow(
    'current_authority_unavailable'
  );
  expect(h.selection.authority()).toBeUndefined();
});
it('rejects a currently valid key that cannot cover the P5 capability lifetime', async () => {
  const h = harness();
  const tooShort = structuredClone(pub);
  tooShort.keys[0].verifyUntil = clock + 50_000;
  h.setFence(tooShort);
  await expect(h.selection.install(await bundle(tooShort))).rejects.toThrow(
    'current_authority_unavailable'
  );
  expect(h.selection.exports()).toBeUndefined();
});
it('rejects malformed authenticated publication identifiers and nonselected key records', async () => {
  const cases: [string, (value: Publication) => void][] = [
    [
      'publicationId',
      value => {
        value.publicationId = 'not-a-uuid';
      },
    ],
    [
      'array publicationId',
      value => {
        (value as unknown as Record<string, unknown>).publicationId = [pub.publicationId];
      },
    ],
    [
      'credentialVerifierRef',
      value => {
        value.credentialVerifierRef = 'bad ref';
      },
    ],
    [
      'providerInstallationId',
      value => {
        value.scope.providerInstallationId = '09001';
      },
    ],
    [
      'invalid final DNS label',
      value => {
        value.scope.endpoint = 'https://issuance.example-/v2/submission-capabilities';
      },
    ],
    [
      'extra key record',
      value => {
        value.keys.push({ ...structuredClone(value.keys[0]), kid: 'cap-v2-extra', notBefore: -1 });
        value.keys.sort((a, b) => a.kid.localeCompare(b.kid));
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(pub);
    mutate(value);
    const h = harness();
    h.setFence(value);
    await expect(h.selection.install(await bundle(value)), name).rejects.toThrow(
      'current_authority_unavailable'
    );
  }
});
it('rejects malformed independent source pins and an unsorted V1 inventory', async () => {
  for (const [field, bad] of [
    ['sourceId', 'bad source'],
    ['sourceEpoch', 'bad-epoch'],
  ] as const) {
    const sourcePin = { ...pin, [field]: bad };
    const value = structuredClone(pub);
    value[field] = bad;
    const h = harness(sourcePin);
    h.setFence(value);
    await expect(h.selection.install(await bundle(value))).rejects.toThrow(
      'current_authority_unavailable'
    );
  }
  const publicJwk = async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const key = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { kty: key.kty!, crv: key.crv!, x: key.x!, y: key.y! };
  };
  const values = [await publicJwk(), await publicJwk()].sort((a, b) =>
    JSON.stringify(Object.values(a)) < JSON.stringify(Object.values(b)) ? 1 : -1
  );
  const value = structuredClone(pub);
  (value as unknown as { v1PublicKeys: typeof values }).v1PublicKeys = values;
  const h = harness();
  h.setFence(value);
  await expect(h.selection.install(await bundle(value))).rejects.toThrow(
    'current_authority_unavailable'
  );
});
it('accepts C0 alias length 100 and rejects 101 despite broader P5 syntax', async () => {
  const accepted = structuredClone(pub);
  accepted.scope.publicApplicationId = `app_${'a'.repeat(96)}`;
  const good = harness();
  good.setFence(accepted);
  await good.selection.install(await bundle(accepted));
  expect(good.selection.authority()?.scope.publicApplicationId).toHaveLength(100);

  const rejected = structuredClone(pub);
  rejected.scope.publicApplicationId = `app_${'a'.repeat(97)}`;
  const bad = harness();
  bad.setFence(rejected);
  await expect(bad.selection.install(await bundle(rejected))).rejects.toThrow(
    'current_authority_unavailable'
  );
});
it('rejects a correctly MACed but noncanonical publication body', async () => {
  const h = harness();
  h.setFence(pub);
  const changed = await bundle(pub);
  const value = new TextDecoder().decode(changed.publication.raw);
  changed.publication.raw = new TextEncoder().encode(
    value.replace('"schemaVersion":2', '"schemaVersion":2 ')
  );
  changed.publication.mac = b64(
    await controlMac(
      'publication.accept',
      'request',
      requestKeys['publication.accept'],
      changed.publication.raw
    )
  );
  await expect(h.selection.install(changed)).rejects.toThrow('current_authority_unavailable');
  expect(h.selection.authority()).toBeUndefined();
});
it('rejects wrong-purpose MAC and stale current selection', async () => {
  const h = harness();
  h.setFence(pub);
  const wrong = await bundle(pub);
  wrong.alias.mac = wrong.publication.mac;
  await expect(h.selection.install(wrong)).rejects.toThrow('current_authority_unavailable');
  const good = await bundle(pub);
  await h.selection.install(good);
  h.setNow(clock + 30_001);
  expect(h.selection.authority()).toBeUndefined();
});

const command: OutcomeCommand = {
  schemaVersion: 2,
  command: 'ingest_outcome_v2',
  arguments: [
    pub.scope.tenantId,
    pub.scope.applicationId,
    pub.scope.installationGeneration,
    pub.scope.destinationId,
    pub.scope.credentialId,
    'c'.repeat(64),
    'd'.repeat(64),
    '2027-01-15T08:00:10.000Z',
    '2027-01-15T08:00:12.000Z',
    'authorized',
    'none',
    true,
    '77777777-7777-4777-8777-777777777777',
    '0.1.0',
    '0.2.0',
    null,
    2,
  ],
};
async function outcomeRequest(input = command): Promise<ControlEnvelope> {
  const raw = encodeOutcome(input);
  return {
    raw,
    keyId: 'synthetic-outcome',
    mac: b64(await controlMac('outcome.execute', 'request', Buffer.alloc(32, 0x14), raw)),
  };
}
const peer = {
  qualified: true as const,
  role: 'bugdrop-outcomes' as const,
  keyId: 'synthetic-outcome',
  pin,
  scope: pub.scope,
  deploymentDigest: pub.scope.deploymentDigest,
  requestKey: Buffer.alloc(32, 0x14),
  receiptKey: Buffer.alloc(32, 0x34),
};
it('signs P6 receipt only after scoped, confirmed COMMIT classification', async () => {
  const execute = vi.fn(async () => ({ committed: true, rows: [{ result: 'applied' }] }));
  const signed = await executeScopedOutcome(
    await outcomeRequest(),
    () => peer,
    execute,
    new AbortController().signal,
    () => Date.parse(command.arguments[8])
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(new TextDecoder().decode(signed.raw))).toEqual({
    schemaVersion: 2,
    eventHash: command.arguments[5],
    result: 'applied',
  });
  expect(signed.mac).toBe(
    b64(await controlMac('outcome.execute', 'receipt', peer.receiptKey, signed.raw))
  );
});
it('cannot acknowledge unknown COMMIT, query-only success, or a different original scope', async () => {
  const request = await outcomeRequest();
  const unknownCommit = vi.fn(async () => {
    throw new Error('unknown_commit');
  });
  await expect(
    executeScopedOutcome(
      request,
      () => peer,
      unknownCommit,
      new AbortController().signal,
      () => Date.parse(command.arguments[8])
    )
  ).rejects.toThrow('outcome_unavailable');
  const queryOnly = vi.fn(async () => ({ committed: false, rows: [{ result: 'applied' }] }));
  await expect(
    executeScopedOutcome(
      request,
      () => peer,
      queryOnly,
      new AbortController().signal,
      () => Date.parse(command.arguments[8])
    )
  ).rejects.toThrow('outcome_unavailable');
  const wrongPeer = {
    ...peer,
    scope: { ...peer.scope, credentialId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
  };
  await expect(
    executeScopedOutcome(
      request,
      () => wrongPeer,
      queryOnly,
      new AbortController().signal,
      () => Date.parse(command.arguments[8])
    )
  ).rejects.toThrow('outcome_unavailable');
  expect(queryOnly).toHaveBeenCalledTimes(1);
});
it('does not reach SQL for missing, wrong-role or wrong-key peer authorization', async () => {
  const request = await outcomeRequest();
  const execute = vi.fn(async () => ({ committed: true, rows: [{ result: 'applied' }] }));
  const signal = new AbortController().signal;
  const now = () => Date.parse(command.arguments[8]);
  await expect(
    executeScopedOutcome(request, () => undefined, execute, signal, now)
  ).rejects.toThrow('outcome_unavailable');
  await expect(
    executeScopedOutcome(request, () => ({ ...peer, role: 'wrong' as never }), execute, signal, now)
  ).rejects.toThrow('outcome_unavailable');
  await expect(
    executeScopedOutcome(
      request,
      () => ({ ...peer, requestKey: Buffer.alloc(32, 1) }),
      execute,
      signal,
      now
    )
  ).rejects.toThrow('outcome_unavailable');
  for (const badPeer of [
    { ...peer, keyId: 'different-key' },
    { ...peer, pin: { ...peer.pin, sourceEpoch: 'bad-epoch' } },
    { ...peer, receiptKey: peer.requestKey },
  ]) {
    await expect(
      executeScopedOutcome(request, () => badPeer, execute, signal, now)
    ).rejects.toThrow('outcome_unavailable');
  }
  await expect(
    executeScopedOutcome(
      { ...request, extra: true } as ControlEnvelope,
      () => peer,
      execute,
      signal,
      now
    )
  ).rejects.toThrow('outcome_unavailable');
  await expect(
    executeScopedOutcome(
      { ...request, raw: new Uint8Array(2049) },
      () => peer,
      execute,
      signal,
      now
    )
  ).rejects.toThrow('outcome_unavailable');
  expect(execute).not.toHaveBeenCalled();
});
it('cannot return a receipt after the caller aborts an uncertain COMMIT', async () => {
  let complete: ((value: unknown) => void) | undefined;
  const execute = vi.fn(
    () =>
      new Promise<unknown>(resolve => {
        complete = resolve;
      })
  );
  const controller = new AbortController();
  const pending = executeScopedOutcome(
    await outcomeRequest(),
    () => peer,
    execute,
    controller.signal,
    () => Date.parse(command.arguments[8])
  );
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  controller.abort();
  complete?.({ committed: true, rows: [{ result: 'applied' }] });
  await expect(pending).rejects.toThrow('outcome_unavailable');
});
