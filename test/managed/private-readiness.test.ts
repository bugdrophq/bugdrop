import { describe, it, expect } from 'vitest';
import { canonical, digest } from '../../managed/staging/private-readiness-descriptor.mjs';
describe('private readiness descriptor', () => {
  it('canonicalizes object keys but retains array order', () => {
    expect(canonical({ z: [2, 1], a: 1 })).toBe('{"a":1,"z":[2,1]}');
    expect(digest({ a: 1, z: [2, 1] })).toBe(digest({ z: [2, 1], a: 1 }));
  });
  it.each([NaN, Infinity, undefined, () => 1, { a: undefined }, 1.5])(
    'rejects noncanonical values',
    value => {
      expect(() => canonical(value)).toThrow();
    }
  );
});

import { afterEach } from 'vitest';
import { rm, writeFile, readFile } from 'node:fs/promises';
import { fixture } from './private-readiness-fixture.mjs';
import { runClosedDenials } from '../../managed/staging/private-readiness.mjs';
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(mode = '') {
  const value = await fixture(mode);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    delete (globalThis as unknown as Record<string, unknown>)[value.key];
    await rm(value.directory, { recursive: true });
  }
});
describe('closed-denial client with synthetic pinned adapters only', () => {
  it('requires fresh observations, fixed unsigned probes and verified cleanup', async () => {
    const value = await setup();
    expect(await runClosedDenials(value)).toEqual({
      schemaVersion: 1,
      proofKind: 'private-binding-closed-denial',
      outcome: 'closed_denials_verified',
      approvedDigest: value.approvedDigest,
      probeCount: 2,
      acceptance: false,
    });
    expect(value.state).toMatchObject({ disposed: true, revoked: true, reads: 3 });
    expect(value.state.calls).toEqual([
      {
        binding: 'ingress',
        url: 'https://private-collector.bugdrop.localhost/v1/submission-capabilities',
        method: 'POST',
        redirect: 'manual',
        headers: [['content-type', 'application/json']],
        body: '{}',
      },
      {
        binding: 'observer',
        url: 'https://private-collector.bugdrop.localhost/observation/read',
        method: 'POST',
        redirect: 'manual',
        headers: [['content-type', 'application/json']],
        body: '{}',
      },
    ]);
  });
  it.each(['drift', 'enabled', 'stale'])('rejects %s before opening any transport', async mode => {
    const value = await setup(mode);
    await expect(runClosedDenials(value)).rejects.toThrow('private_readiness_rejected');
    expect(value.state.calls).toEqual([]);
    expect(value.state).not.toHaveProperty('opened');
  });
  it.each([
    'redirect',
    'duplicate-body',
    'cookie',
    'oversize',
    'success',
    'throw',
    'post-drift',
    'credential-live',
    'resource-left',
    'dispose-failed',
    'held-fetch',
    'held-body',
  ])('withholds proof for %s and attempts cleanup', async mode => {
    const value = await setup(mode);
    await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
    expect(value.state.disposed).toBe(true);
  });
  it('refuses artifact tampering before importing transport', async () => {
    const value = await setup();
    await writeFile(
      value.descriptor.runnerArtifacts.find(a => a.name === 'transport')!.absolutePath,
      'throw Error("PRIVATE_CANARY")'
    );
    await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
    expect(value.state).not.toHaveProperty('opened');
  });
  it('cannot accept a descriptor whose approval digest was changed', async () => {
    const value = await setup();
    await expect(runClosedDenials({ ...value, approvedDigest: 'f'.repeat(64) })).rejects.toThrow();
    expect(value.state).not.toHaveProperty('opened');
  });
});

describe('cleanup and approval boundaries', () => {
  it('revokes a late session without turning a timed-out run green', async () => {
    const value = await setup('late-open');
    await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(value.state).toMatchObject({ disposed: true, revoked: true, calls: [] });
  });
  it('freezes approval before passing it to pinned transport code', async () => {
    const value = await setup('mutate-approval');
    await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
    expect(value.state.calls).toEqual([]);
  });
  it('rejects duplicate or noncanonical descriptor bytes even with matching hash', async () => {
    const value = await setup();
    const { hash } = await import('../../managed/staging/private-readiness-descriptor.mjs');
    const canonicalText = canonical(value.descriptor);
    const text = '{"schemaVersion":1,' + canonicalText.slice(1);
    expect(text.match(/"schemaVersion":1/g)).toHaveLength(2);
    expect(JSON.parse(text)).toEqual(value.descriptor);
    await writeFile(value.descriptorPath, text);
    await expect(runClosedDenials({ ...value, approvedDigest: hash(text) })).rejects.toThrow();
    expect(value.state).not.toHaveProperty('opened');
  });
});

it('cancels a response body that arrives after the whole-exchange deadline', async () => {
  const value = await setup('late-body');
  await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(value.state).toMatchObject({ disposed: true, revoked: true, lateBodyCanceled: true });
});

it('still challenges revocation and checks drift when disposal itself fails', async () => {
  const value = await setup('dispose-failed');
  await expect(runClosedDenials(value)).rejects.toThrow(/^private_readiness_rejected$/);
  expect(value.state).toMatchObject({ disposed: true, revoked: true, reads: 3 });
});

it('rejects a repinned provenance receipt bound to the wrong source revision', async () => {
  const value = await setup();
  const { hash } = await import('../../managed/staging/private-readiness-descriptor.mjs');
  const artifact = value.descriptor.runnerArtifacts.find(a => a.name.startsWith('provenance-'))!;
  const receipt = JSON.parse(await readFile(artifact.absolutePath, 'utf8'));
  receipt.sourceRevision = 'f'.repeat(40);
  const text = canonical(receipt);
  await writeFile(artifact.absolutePath, text);
  artifact.sha256 = hash(text);
  value.descriptor.workers.find(
    w => 'provenance-' + w.name === artifact.name
  )!.provenanceReceiptSha256 = artifact.sha256;
  await writeFile(value.descriptorPath, canonical(value.descriptor));
  await expect(
    runClosedDenials({
      descriptorPath: value.descriptorPath,
      approvedDigest: digest(value.descriptor),
    })
  ).rejects.toThrow();
  expect(value.state).not.toHaveProperty('opened');
});

it('rejects an array revision even when all provenance artifacts match its invalid type', async () => {
  const value = await setup();
  const { hash } = await import('../../managed/staging/private-readiness-descriptor.mjs');
  value.descriptor.runtimeRevision = [value.descriptor.runtimeRevision] as unknown as string;
  for (const artifact of value.descriptor.runnerArtifacts.filter(a =>
    a.name.startsWith('provenance-')
  )) {
    const receipt = JSON.parse(await readFile(artifact.absolutePath, 'utf8'));
    receipt.sourceRevision = value.descriptor.runtimeRevision;
    const text = canonical(receipt);
    await writeFile(artifact.absolutePath, text);
    artifact.sha256 = hash(text);
    value.descriptor.workers.find(
      w => 'provenance-' + w.name === artifact.name
    )!.provenanceReceiptSha256 = artifact.sha256;
  }
  await writeFile(value.descriptorPath, canonical(value.descriptor));
  await expect(
    runClosedDenials({
      descriptorPath: value.descriptorPath,
      approvedDigest: digest(value.descriptor),
    })
  ).rejects.toThrow();
  expect(value.state).not.toHaveProperty('opened');
});
