import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const fail = () => {
  throw new Error('private_readiness_rejected');
};
export function exact(value, fields) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join('|') !== [...fields].sort().join('|')
  )
    fail();
  return value;
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail();
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    if (keys.some(key => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key))) fail();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return fail();
}
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = value => hash(canonical(value));
const sha = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
};
const names = ['authority', 'delivery', 'github', 'ingress', 'reconciliation'].map(
  role => `bugdrop-managed-${role}-staging`
);
const entries = {
  authority: ['StagingObservation'],
  delivery: [],
  github: [],
  ingress: ['default'],
  reconciliation: [],
};
export async function readPinned(artifact) {
  exact(artifact, ['name', 'absolutePath', 'sha256']);
  sha(artifact.sha256);
  if (
    !isAbsolute(artifact.absolutePath) ||
    (await realpath(artifact.absolutePath)) !== artifact.absolutePath
  )
    fail();
  const info = await stat(artifact.absolutePath);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) fail();
  const raw = await readFile(artifact.absolutePath);
  if (hash(raw) !== artifact.sha256) fail();
  return raw;
}
export async function loadApproved(path, approvedDigest) {
  sha(approvedDigest);
  const raw = await readPinned({ name: 'descriptor', absolutePath: path, sha256: approvedDigest });
  const descriptor = JSON.parse(raw.toString('utf8'));
  if (canonical(descriptor) !== raw.toString('utf8')) fail();
  exact(descriptor, [
    'schemaVersion',
    'proofKind',
    'accountId',
    'runtimeRevision',
    'workers',
    'runnerArtifacts',
    'proxyPolicy',
  ]);
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.proofKind !== 'private-binding-closed-denial' ||
    !/^[a-f0-9]{32}$/.test(descriptor.accountId) ||
    !/^[a-f0-9]{40}$/.test(descriptor.runtimeRevision)
  )
    fail();
  if (!Array.isArray(descriptor.workers) || descriptor.workers.length !== 5) fail();
  for (const [i, worker] of descriptor.workers.entries()) {
    exact(worker, [
      'name',
      'versionId',
      'entrypoints',
      'configurationSha256',
      'sourceBundleSha256',
      'provenanceReceiptSha256',
    ]);
    const role = ['authority', 'delivery', 'github', 'ingress', 'reconciliation'][i];
    if (
      worker.name !== names[i] ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(worker.versionId) ||
      canonical(worker.entrypoints) !== canonical(entries[role])
    )
      fail();
    for (const key of ['configurationSha256', 'sourceBundleSha256', 'provenanceReceiptSha256'])
      sha(worker[key]);
  }
  const policy = exact(descriptor.proxyPolicy, [
    'capabilityScopeSha256',
    'temporaryResourceInventorySha256',
    'revocationProcedureSha256',
    'maximumLifetimeSeconds',
  ]);
  for (const key of [
    'capabilityScopeSha256',
    'temporaryResourceInventorySha256',
    'revocationProcedureSha256',
  ])
    sha(policy[key]);
  if (
    !Number.isSafeInteger(policy.maximumLifetimeSeconds) ||
    policy.maximumLifetimeSeconds < 1 ||
    policy.maximumLifetimeSeconds > 60
  )
    fail();
  const expected = [
    'oracle',
    'transport',
    ...names.flatMap(name => [`bundle-${name}`, `provenance-${name}`]),
  ].sort();
  if (
    !Array.isArray(descriptor.runnerArtifacts) ||
    canonical(descriptor.runnerArtifacts.map(a => a.name)) !== canonical(expected)
  )
    fail();
  const files = new Map();
  for (const artifact of descriptor.runnerArtifacts)
    files.set(artifact.name, await readPinned(artifact));
  for (const worker of descriptor.workers) {
    if (
      hash(files.get(`bundle-${worker.name}`)) !== worker.sourceBundleSha256 ||
      hash(files.get(`provenance-${worker.name}`)) !== worker.provenanceReceiptSha256
    )
      fail();
    const receipt = JSON.parse(files.get(`provenance-${worker.name}`).toString('utf8'));
    if (
      canonical(receipt) !==
      canonical({
        schemaVersion: 1,
        accountId: descriptor.accountId,
        worker: worker.name,
        versionId: worker.versionId,
        sourceRevision: descriptor.runtimeRevision,
        bundleSha256: worker.sourceBundleSha256,
      })
    )
      fail();
  }
  // Import bytes already verified, so later file replacement cannot change executed modules.
  // Adapters must be self-contained: data URLs do not resolve relative dependencies.
  const modules = {};
  for (const name of ['oracle', 'transport'])
    modules[name] = await import(
      'data:text/javascript;base64,' + files.get(name).toString('base64')
    );
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(descriptor);
  return { descriptor, modules };
}
