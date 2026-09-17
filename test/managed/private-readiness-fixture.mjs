import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, hash } from '../../managed/staging/private-readiness-descriptor.mjs';
export async function fixture(mode = '') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'closed-denial-')));
  const key = randomUUID();
  const state = { calls: [], disposed: false, reads: 0 };
  globalThis[key] = state;
  const accountId = 'a'.repeat(32),
    runtimeRevision = 'b'.repeat(40);
  const configuration = {
    vars: { ENVIRONMENT: 'staging', STAGING_ENABLED: 'false' },
    secretNames: [],
    services: [],
    durableObjects: [],
    hyperdrive: [],
    workersDev: false,
    previewUrls: false,
    routes: [],
    domains: [],
    compatibilityDate: '2026-06-10',
    compatibilityFlags: [],
    observability: false,
    logpush: false,
    tailConsumers: [],
  };
  const workers = [];
  const runnerArtifacts = [];
  const observed = [];
  async function artifact(name, bytes) {
    const absolutePath = join(directory, name + '.mjs');
    await writeFile(absolutePath, bytes);
    const value = { name, absolutePath, sha256: hash(bytes) };
    runnerArtifacts.push(value);
    return value;
  }
  for (const role of ['authority', 'delivery', 'github', 'ingress', 'reconciliation']) {
    const name = `bugdrop-managed-${role}-staging`,
      versionId = randomUUID();
    const entrypoints =
      role === 'authority' ? ['StagingObservation'] : role === 'ingress' ? ['default'] : [];
    const bundle = await artifact('bundle-' + name, '// synthetic bundle ' + name);
    const provenance = await artifact(
      'provenance-' + name,
      canonical({
        schemaVersion: 1,
        accountId,
        worker: name,
        versionId,
        sourceRevision: runtimeRevision,
        bundleSha256: bundle.sha256,
      })
    );
    workers.push({
      name,
      versionId,
      entrypoints,
      configurationSha256: digest(configuration),
      sourceBundleSha256: bundle.sha256,
      provenanceReceiptSha256: provenance.sha256,
    });
    observed.push({ name, versionId, entrypoints, configuration });
  }
  const policy = {
    capabilityScopeSha256: 'c'.repeat(64),
    temporaryResourceInventorySha256: 'd'.repeat(64),
    revocationProcedureSha256: 'e'.repeat(64),
    maximumLifetimeSeconds: 60,
  };
  await artifact(
    'oracle',
    `const state=globalThis[${JSON.stringify(key)}];const mode=${JSON.stringify(mode)};
export async function inspect({nonce}) { state.reads++; const workers=${JSON.stringify(observed)};
if(mode==='drift'||(mode==='post-drift'&&state.reads>1))workers[0].versionId='bad';
if(mode==='enabled')workers[0].configuration.vars.STAGING_ENABLED='true';
return {nonce:mode==='stale'?'old':nonce, observedAt:Date.now(), accountId:${JSON.stringify(accountId)},workers}; }
export async function revocation({sessionId,nonce}) { state.revoked=true;
return {nonce,observedAt:Date.now(),sessionId,revocationProcedureSha256:'${policy.revocationProcedureSha256}',credentialProbeStatus:mode==='credential-live'?200:403,remainingResourceIds:mode==='resource-left'?['orphan']:[]}; }`
  );
  await artifact(
    'transport',
    `const state=globalThis[${JSON.stringify(key)}];const mode=${JSON.stringify(mode)};
export async function open({descriptor}){state.opened=true; if(mode==='mutate-approval')descriptor.workers[0].versionId='bad'; if(mode==='late-open')await new Promise(r=>setTimeout(r,2100)); return {id:'test-session',expiresAt:Date.now()+30000,capabilityScopeSha256:'${policy.capabilityScopeSha256}',temporaryResourceInventorySha256:'${policy.temporaryResourceInventorySha256}',
async fetch(binding,request){state.calls.push({binding,url:request.url,method:request.method,redirect:request.redirect,headers:[...request.headers],body:await request.text()});
if(mode==='throw')throw new Error('PRIVATE_CANARY');
if(mode==='late-body'){await new Promise(r=>setTimeout(r,2100));return new Response(new ReadableStream({cancel(){state.lateBodyCanceled=true;}}),{status:403});}
if(mode==='held-fetch')return new Promise(()=>{});
if(mode==='redirect')return Response.redirect('https://other.example/',302);
if(mode==='duplicate-body')return new Response('{"error":"managed_request_rejected","error":"managed_request_rejected"}',{status:403});
if(mode==='cookie')return new Response('{}',{status:403,headers:{'Set-Cookie':'PRIVATE_CANARY'}});
if(mode==='held-body')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([123]));}}),{status:403});
return new Response(mode==='oversize'?'x'.repeat(300):mode==='success'?'{}':JSON.stringify({error:'managed_request_rejected'}),{status:mode==='success'?200:403});},
async dispose(){state.disposed=true;if(mode==='dispose-failed')throw new Error('PRIVATE_CANARY');}};}`
  );
  runnerArtifacts.sort((a, b) => a.name.localeCompare(b.name));
  const descriptor = {
    schemaVersion: 1,
    proofKind: 'private-binding-closed-denial',
    accountId,
    runtimeRevision,
    workers,
    runnerArtifacts,
    proxyPolicy: policy,
  };
  const descriptorPath = join(directory, 'descriptor.json');
  await writeFile(descriptorPath, canonical(descriptor));
  return { directory, descriptor, descriptorPath, approvedDigest: digest(descriptor), state, key };
}
