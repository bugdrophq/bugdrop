import { randomUUID } from 'node:crypto';
import { canonical, digest, exact, fail, loadApproved } from './private-readiness-descriptor.mjs';

const probes = Object.freeze([
  Object.freeze({
    binding: 'ingress',
    method: 'POST',
    url: 'https://private-collector.bugdrop.localhost/v1/submission-capabilities',
  }),
  Object.freeze({
    binding: 'observer',
    method: 'POST',
    url: 'https://private-collector.bugdrop.localhost/observation/read',
  }),
]);
const bound = async (action, milliseconds = 2000, onLate = async () => {}) => {
  let expired = false;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => action(controller.signal))
        .then(value => {
          if (expired)
            void Promise.resolve()
              .then(() => onLate(value))
              .catch(() => {});
          return value;
        }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          reject(new Error('private_readiness_rejected'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};
function fresh(value, nonce) {
  if (
    value.nonce !== nonce ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt > Date.now() ||
    Date.now() - value.observedAt > 5000
  )
    fail();
}
function closed(configuration) {
  exact(configuration, [
    'vars',
    'secretNames',
    'services',
    'durableObjects',
    'hyperdrive',
    'workersDev',
    'previewUrls',
    'routes',
    'domains',
    'compatibilityDate',
    'compatibilityFlags',
    'observability',
    'logpush',
    'tailConsumers',
  ]);
  if (
    configuration.vars.ENVIRONMENT !== 'staging' ||
    configuration.vars.STAGING_ENABLED !== 'false' ||
    Object.entries(configuration.vars).some(
      ([key, value]) => key.endsWith('_ENABLED') && value !== 'false'
    ) ||
    configuration.workersDev !== false ||
    configuration.previewUrls !== false ||
    canonical(configuration.routes) !== '[]' ||
    canonical(configuration.domains) !== '[]'
  )
    fail();
}
async function inspect(oracle, descriptor) {
  const nonce = randomUUID();
  const value = await bound(signal => oracle.inspect({ nonce, signal }));
  exact(value, ['nonce', 'observedAt', 'accountId', 'workers']);
  fresh(value, nonce);
  if (
    value.accountId !== descriptor.accountId ||
    !Array.isArray(value.workers) ||
    value.workers.length !== 5
  )
    fail();
  for (const [i, actual] of value.workers.entries()) {
    exact(actual, ['name', 'versionId', 'entrypoints', 'configuration']);
    const expected = descriptor.workers[i];
    closed(actual.configuration);
    if (
      actual.name !== expected.name ||
      actual.versionId !== expected.versionId ||
      canonical(actual.entrypoints) !== canonical(expected.entrypoints) ||
      digest(actual.configuration) !== expected.configurationSha256
    )
      fail();
  }
}
async function denial(session, probe) {
  await bound(async signal => {
    const reply = await session.fetch(
      probe.binding,
      new Request(probe.url, {
        method: probe.method,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        redirect: 'manual',
        signal,
      })
    );
    if (
      signal.aborted ||
      !(reply instanceof Response) ||
      reply.status !== 403 ||
      reply.redirected ||
      reply.headers.has('Location') ||
      reply.headers.has('Set-Cookie')
    ) {
      void reply.body?.cancel().catch(() => {});
      fail();
    }
    const reader = reply.body?.getReader();
    if (!reader) fail();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const chunks = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 256) fail();
        chunks.push(part.value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body !== '{"error":"managed_request_rejected"}') fail();
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  });
}
async function cleanup(session, oracle, descriptor) {
  let rejected = false;
  try {
    await bound(signal => session.dispose({ signal }));
  } catch {
    rejected = true;
  }
  try {
    const nonce = randomUUID();
    const proof = await bound(signal =>
      oracle.revocation({ sessionId: session.id, nonce, signal })
    );
    exact(proof, [
      'nonce',
      'observedAt',
      'sessionId',
      'revocationProcedureSha256',
      'credentialProbeStatus',
      'remainingResourceIds',
    ]);
    fresh(proof, nonce);
    if (
      proof.sessionId !== session.id ||
      proof.revocationProcedureSha256 !== descriptor.proxyPolicy.revocationProcedureSha256 ||
      ![401, 403].includes(proof.credentialProbeStatus) ||
      canonical(proof.remainingResourceIds) !== '[]'
    )
      fail();
  } catch {
    rejected = true;
  }
  try {
    await inspect(oracle, descriptor);
  } catch {
    rejected = true;
  }
  if (rejected) fail();
}
/** Trusted pinned adapters are the evidence boundary. No live adapter ships here. */
export async function runClosedDenials({ descriptorPath, approvedDigest }) {
  let session;
  let oracle;
  let descriptor;
  let accepted = false;
  let failure = false;
  try {
    const loaded = await bound(() => loadApproved(descriptorPath, approvedDigest));
    descriptor = loaded.descriptor;
    oracle = loaded.modules.oracle;
    const transport = loaded.modules.transport;
    if (
      typeof oracle.inspect !== 'function' ||
      typeof oracle.revocation !== 'function' ||
      typeof transport.open !== 'function'
    )
      fail();
    await inspect(oracle, descriptor);
    // open must settle within the approved lifetime, honor abort, and revoke any late allocation.
    session = await bound(
      signal => transport.open({ descriptor, signal }),
      2000,
      late => cleanup(late, oracle, descriptor)
    );
    exact(session, [
      'id',
      'expiresAt',
      'capabilityScopeSha256',
      'temporaryResourceInventorySha256',
      'fetch',
      'dispose',
    ]);
    if (
      typeof session.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= Date.now() ||
      session.expiresAt > Date.now() + descriptor.proxyPolicy.maximumLifetimeSeconds * 1000 ||
      session.capabilityScopeSha256 !== descriptor.proxyPolicy.capabilityScopeSha256 ||
      session.temporaryResourceInventorySha256 !==
        descriptor.proxyPolicy.temporaryResourceInventorySha256 ||
      typeof session.fetch !== 'function' ||
      typeof session.dispose !== 'function'
    )
      fail();
    for (const probe of probes) {
      if (Date.now() >= session.expiresAt) fail();
      await denial(session, probe);
      if (Date.now() >= session.expiresAt) fail();
    }
    await inspect(oracle, descriptor);
    accepted = true;
  } catch {
    failure = true;
  } finally {
    if (session) {
      try {
        await cleanup(session, oracle, descriptor);
      } catch {
        failure = true;
      }
    }
  }
  if (failure || !accepted) return fail();
  return Object.freeze({
    schemaVersion: 1,
    proofKind: 'private-binding-closed-denial',
    outcome: 'closed_denials_verified',
    approvedDigest,
    probeCount: 2,
    acceptance: false,
  });
}
