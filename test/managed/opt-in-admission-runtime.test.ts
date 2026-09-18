import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto, randomBytes } from 'node:crypto';
import type { AdmissionRow } from '../../src/managed/opt-in/admission-store';
import type { Capability } from '../../src/managed/opt-in/protocol';
import type { PendingCommand } from '../../src/managed/opt-in/pending-work';
interface Probe {
  ok: boolean;
  error?: string;
  rows: AdmissionRow[];
  history: unknown[];
  alarm: number;
  evidence: { R: number; S: number | string; U: number; A: number }[];
  capability: Capability;
  command: PendingCommand;
  state: string;
}

let directory: string;
let runtime: Miniflare;
let script: string;
let bindings: Record<string, string>;
let name: string;
let stage = '';
let reached: () => void = () => {};
let release: () => void = () => {};
let paused: Promise<void>;
let entered: Promise<void>;
let counts = { capability: 0, confirmation: 0 };
let candidate: { schemaVersion: 1; token: string; expiresAt: string } | undefined;
const initial = 1800000000000;
async function boot() {
  runtime = new Miniflare({
    host: 'admission.bugdrop.localhost',
    modules: true,
    script,
    compatibilityDate: '2026-06-10',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { AUTH: { className: 'StagingAuthorization', useSQLite: true } },
    durableObjectsPersist: join(directory, 'state'),
    bindings,
    log: new Log(LogLevel.NONE),
    outboundService: () => new Response(null, { status: 403 }),
    serviceBindings: {
      TEST_GATE: async request => {
        const data = (await request.json()) as {
          stage: string;
          message?: string;
          signature?: string;
        };
        if (data.stage === 'capability') {
          counts.capability++;
          const claims = JSON.parse(
            Buffer.from(data.message!.split('.')[1], 'base64url').toString()
          );
          candidate = {
            schemaVersion: 1,
            token: data.message + '.' + data.signature,
            expiresAt: new Date(claims.exp * 1000).toISOString(),
          };
        }
        if (data.stage === 'confirmation') counts.confirmation++;
        if (data.stage === stage) {
          reached();
          await paused;
        }
        return new Response('ok');
      },
    },
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bugdrop-p5-'));
  const keys = [];
  for (const purpose of ['capability', 'confirmation']) {
    const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    keys.push({
      purpose,
      publicKey: await webcrypto.subtle.exportKey('jwk', key.publicKey),
      privateKey: await webcrypto.subtle.exportKey('jwk', key.privateKey),
    });
  }
  bindings = {
    TEST_KEYS: JSON.stringify(keys),
    TEST_SECRET: randomBytes(32).toString('base64url'),
  };
  const bundled = await build({
    stdin: {
      contents: `
    import { StagingAuthorization as Base } from './src/managed/staging/authorization.ts';
    import { Observation } from './src/managed/staging/observation.ts';
    import { Admission } from './src/managed/opt-in/admission.ts';
    import { AdmissionStore } from './src/managed/opt-in/admission-store.ts';
    import { PendingWork, scheduleAlarm } from './src/managed/opt-in/pending-work.ts';
    import { verifySubmission, identity } from './src/managed/opt-in/verifier.ts';
    import { hex,intentDigest,utf8,encode,bytes,retentionMs } from './src/managed/opt-in/protocol.ts';
    export class StagingAuthorization extends Base {
      constructor(ctx,env) {
        super(ctx,env); this.time=${initial}; this.available=true; this.active=true; this.failure=''; this.syncs=0;
        const storage=new Proxy(ctx.storage,{get:(target,key)=> {
          if(key==='transactionSync') return fn=>target.transactionSync(()=> {const result=fn();const rows=target.sql.exec('SELECT body FROM opt_in_admission').toArray().map(r=>JSON.parse(r.body));
            if(this.failure==='reserve-write' || (this.failure==='admit-write' && rows.some(r=>r.state==='admitted')) || (this.failure==='known-write' && rows.some(r=>r.signatureKnown))) {this.failure='';throw Error('PRIVATE_WRITE_FAILURE');}return result;});
          if(key==='setAlarm') return async deadline=> {if(this.failure==='alarm') throw Error('PRIVATE_ALARM_FAILURE');await target.setAlarm(deadline);};
          if(key==='sync') return async()=> {
            this.syncs++; const n=this.syncs;
            if(this.failure==='sync-before-'+n) throw Error('PRIVATE_STORAGE_FAILURE');
            await target.sync();
            await this.gate('sync-'+n);
            if(this.failure==='sync-after-'+n) throw Error('PRIVATE_STORAGE_FAILURE');
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        this.ledger=new AdmissionStore(storage,()=>this.time); this.optInStore=this.ledger;
        this.observation=new Observation(storage,()=>this.time,()=>scheduleAlarm(storage));
        this.pending=new PendingWork(this.ledger,()=>this.time);
        this.ctx.blockConcurrencyWhile(async()=> {
          const keys=[];
          for(const k of JSON.parse(env.TEST_KEYS)) keys.push({kid:k.purpose==='capability'?'cap-v2-test':'confirmation-test',purpose:k.purpose+'-v2',publicKey:k.publicKey,
            signingKey:await crypto.subtle.importKey('jwk',k.privateKey,{name:'ECDSA',namedCurve:'P-256'},false,['sign']),notBefore:${initial}-100000,verifyUntil:${initial}+10000000});
          const catalog={schemaVersion:1,normalizationVersion:1,server:['0.1.0'],browser:['0.2.0'],widget:[]};
          this.authority={publicationId:'synthetic-publication-1',lifecycleVersion:1,observedAt:this.time,active:true,protocolMode:2,
            scope:{tenantId:'11111111-1111-4111-8111-111111111111',applicationId:'22222222-2222-4222-8222-222222222222',destinationId:'33333333-3333-4333-8333-333333333333',
              credentialId:'44444444-4444-4444-8444-444444444444',installationGeneration:'55555555-5555-4555-8555-555555555555',providerInstallationId:'42',githubAppId:'7',
              publicApplicationId:'app_test',keyId:'ICEiIyQlJicoKSorLC0uLw',endpoint:'https://issuance.example.test/v2/submission-capabilities',origin:'https://customer.example.test',deploymentDigest:'a'.repeat(64)},
            catalog,catalogDigest:await hex('bugdrop:version-catalog:v1\\0',JSON.stringify([1,1,catalog.server,catalog.browser,[]])),capabilityKid:'cap-v2-test',confirmationKid:'confirmation-test',keys,v1PublicKeys:[],
            authenticate:async secret=>{await this.gate('authenticate'); return encode(secret)===env.TEST_SECRET;}};
          this.source=()=>this.available?{...this.authority,active:this.active,observedAt:this.stale?this.authority.observedAt:this.time}:undefined;
          this.core=new Admission(this.ledger,this.source,()=>this.time,async(key,message)=> {
            const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,message);
            await env.TEST_GATE.fetch('https://gate.example.test/',{method:'POST',body:JSON.stringify({stage:key===keys[0].signingKey?'capability':'confirmation',message:new TextDecoder().decode(message),signature:encode(signature)})});
            return signature;
          });
        });
      }
      gate(stage){return this.env.TEST_GATE.fetch('https://gate.example.test/',{method:'POST',body:JSON.stringify({stage})});}
      async fetch(request) {
        const path=new URL(request.url).pathname, body=await request.json();
        if(path==='/control') {
          if(body.advance) this.time+=body.advance;
          if(body.available!==undefined) this.available=body.available;
          if(body.active!==undefined) this.active=body.active;
          if(body.stale!==undefined) this.stale=body.stale;
          if(body.scope) Object.assign(this.authority.scope,body.scope);
          if(body.reorderScope) this.authority.scope=Object.fromEntries(Object.entries(this.authority.scope).reverse());
          if(body.publication) this.authority.publicationId=body.publication;
          if(body.mode) this.authority.protocolMode=body.mode;
          if(body.revoke) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO revocation VALUES(1)');
          if(body.expireKey) this.authority.keys[body.expireKey==='capability'?0:1].verifyUntil=this.time;
          if(body.failure!==undefined) this.failure=body.failure;
          if(body.capacity) this.ledger.capacity=body.capacity;
          if(body.historyFull) for(let i=0;i<128;i++) this.ctx.storage.sql.exec('INSERT INTO opt_in_history VALUES(?,?,?,?)','catalog',String(i).padStart(64,'0'),this.time+2592300000,'{}');
          return Response.json({ok:true});
        }
        if(path==='/state') return Response.json({
          rows:this.ctx.storage.sql.exec('SELECT body FROM opt_in_admission').toArray().map(r=>JSON.parse(r.body)),
          history:this.ctx.storage.sql.exec('SELECT * FROM opt_in_history').toArray(),alarm:await this.ctx.storage.getAlarm(),
          evidence:this.ctx.storage.sql.exec('SELECT handle FROM opt_in_admission').toArray().map(r=>this.ledger.evidence(r.handle)??null)});
        if(path==='/alarm') {await this.alarm();return Response.json({ok:true});}
        if(path==='/lease') {await this.observation.persist({expiresAt:this.time+body.duration,closed:true});return Response.json({ok:true});}
        if(path==='/issue') {
          const s=this.authority.scope;
          const i={attemptId:body.attempt??crypto.randomUUID(),issuedAt:body.issuedAt??this.time,expiresAt:(body.issuedAt??this.time)+60000,
            submissionId:body.submission??'submission',payloadDigest:encode(await crypto.subtle.digest('SHA-256',utf8('feedback'))),
            applicationId:s.publicApplicationId,credentialId:s.credentialId,keyId:s.keyId,installationGeneration:s.installationGeneration,endpoint:s.endpoint,
            deploymentDigest:s.deploymentDigest,catalogDigest:this.authority.catalogDigest,origin:s.origin,serverSdkVersion:'0.1.0',browserSdkVersion:'0.2.0',
            normalizedVersions:{sdkVersion:'0.1.0',browserSdkVersion:'0.2.0',widgetVersion:null,protocolVersion:2},...body.intent};
          const key=await crypto.subtle.importKey('raw',bytes(this.env.TEST_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
          const mac=encode(await crypto.subtle.sign('HMAC',key,utf8('bugdrop:intent-request:v2\\0POST\\0'+i.endpoint+'\\0'+await intentDigest(i))));
          const input={raw:utf8(body.raw??JSON.stringify({schemaVersion:2,intent:i})),authorization:body.authorization??'Bearer bd_auth_v2.'+s.keyId+'.'+this.env.TEST_SECRET,mac:body.mac??mac,serverVersion:'0.1.0'};
          const originalUUID=crypto.randomUUID;
          if(body.handleCollision) crypto.randomUUID=()=>body.handleCollision;
          try {return Response.json(await this.core.issue(input));} finally {crypto.randomUUID=originalUUID;}
        }
        if(path==='/verify') {
          try { const result=await verifySubmission(body.capability,{submissionId:body.submission??'submission',payloadDigest:encode(await crypto.subtle.digest('SHA-256',utf8('feedback'))),origin:body.origin??this.authority.scope.origin},utf8(body.raw??'feedback'),this.ledger,this.source,()=>this.time);return Response.json({ok:true,result}); }
          catch{return Response.json({ok:false});}
        }
        if(path==='/join') {
          try {
            const row=this.ledger.read(body.handle);
            const delivery={scope:row.scope,authorityIdentity:row.authorityIdentity,submissionId:row.intent.submissionId,payloadDigest:row.intent.payloadDigest,
              eventHash:'b'.repeat(64),submissionHash:'c'.repeat(64),acceptedAt:new Date(this.time).toISOString(),occurredAt:new Date(this.time).toISOString(),
              state:'authorized',reason:'none',isTest:true,correlationId:'66666666-6666-4666-8666-666666666666',...body.patch};
            return Response.json({ok:true,command:await this.pending.join(body.handle,async()=>body.missing?undefined:delivery)});
          } catch{return Response.json({ok:false});}
        }
        if(path==='/pending') {
          try {if(body.ack) await this.pending.acknowledge(body.event,{eventHash:body.event,accepted:true});return Response.json({ok:true,...await this.pending.read(body.event)});}catch{return Response.json({ok:false});}
        }
        return super.fetch(request);
      }
    }
    export default {fetch(request,env){const u=new URL(request.url);return env.AUTH.get(env.AUTH.idFromName(u.searchParams.get('object'))).fetch(request);}}
  `,
      resolveDir: process.cwd(),
      sourcefile: 'p5-test-worker.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    external: ['cloudflare:workers'],
    logLevel: 'silent',
  });
  script = bundled.outputFiles[0].text;
  await boot();
});
afterAll(async () => {
  release();
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  name = crypto.randomUUID();
  stage = '';
  counts = { capability: 0, confirmation: 0 };
  candidate = undefined;
});
async function call(path: string, body: unknown = {}) {
  const r = await (
    await runtime.getWorker()
  ).fetch('https://admission.example.test' + path + '?object=' + name, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return r.json() as Promise<Probe>; // Test-only introspection of private synthetic state.
}
function pause(at: string) {
  stage = at;
  paused = new Promise(r => {
    release = r;
  });
  entered = new Promise(r => {
    reached = r;
  });
}
async function restart() {
  await runtime.dispose();
  await boot();
}

it('missing private publication fails closed with R=S=A=0', async () => {
  await call('/control', { available: false });
  expect(await call('/issue')).toEqual({ ok: false, error: 'temporarily_unavailable' });
  expect((await call('/state')).rows).toEqual([]);
  expect(counts).toEqual({ capability: 0, confirmation: 0 });
});
it('commits one permit, signed result and marker, and verifies only through the original ledger', async () => {
  const result = await call('/issue');
  expect(result.ok).toBe(true);
  const state = await call('/state');
  expect(state.evidence).toEqual([{ R: 1, S: 1, U: 0, A: 1 }]);
  expect(state.rows[0]).toMatchObject({
    state: 'admitted',
    pending: { state: 'awaiting-delivery' },
    reservedAt: initial,
    retentionDeadline: initial + 2592000000,
  });
  expect(counts).toEqual({ capability: 1, confirmation: 1 });
  expect((await call('/verify', { capability: result.capability })).ok).toBe(true);
  const stored = JSON.stringify(state);
  expect(stored).not.toContain(result.capability.token);
  expect(stored).not.toContain(bindings.TEST_SECRET);
  expect(stored).not.toContain('signingKey');
  expect(stored).not.toContain('"d":');
});
it.each([
  { intent: { serverSdkVersion: '01.0.0' } },
  {
    intent: {
      normalizedVersions: {
        sdkVersion: null,
        browserSdkVersion: '0.2.0',
        widgetVersion: null,
        protocolVersion: 2,
      },
    },
  },
  { intent: { catalogDigest: '0'.repeat(64) } },
  { intent: { installationGeneration: '77777777-7777-4777-8777-777777777777' } },
  { mac: 'A'.repeat(43) },
  { authorization: 'Bearer bd_auth_v1.invalid.invalid' },
  { issuedAt: initial - 60000 },
  { raw: '{"schemaVersion":2,"schemaVersion":2}' },
])('rejects invalid intent before reserving or signing: %j', async input => {
  expect((await call('/issue', input)).ok).toBe(false);
  expect((await call('/state')).rows).toEqual([]);
  expect(counts.capability).toBe(0);
});
it('serializes concurrent attempts and returns no token for identical retry or changed submission attempt', async () => {
  const attempt = crypto.randomUUID();
  pause('capability');
  const first = call('/issue', { attempt });
  await entered;
  expect(await call('/issue', { attempt })).toEqual({ ok: false, error: 'attempt_already_seen' });
  expect(await call('/issue')).toEqual({ ok: false, error: 'binding_conflict' });
  expect((await call('/verify', { capability: candidate })).ok).toBe(false);
  release();
  expect((await first).ok).toBe(true);
  expect(counts.capability).toBe(1);
  expect(await call('/issue', { attempt })).toEqual({ ok: false, error: 'attempt_already_seen' });
});
it.each(['authenticate', 'sync-1', 'capability', 'confirmation', 'sync-2'])(
  'revocation at %s blocks release without erasing A/S',
  async at => {
    pause(at);
    const result = call('/issue');
    await entered;
    await call('/control', { active: false });
    release();
    expect((await result).ok).toBe(false);
    const state = await call('/state');
    if (at === 'authenticate') {
      expect(state.rows).toEqual([]);
      expect(counts.capability).toBe(0);
    } else {
      expect(state.evidence[0].A).toBe(at === 'sync-2' ? 1 : 0);
      expect((await call('/verify', { capability: candidate })).ok).toBe(false);
    }
  }
);
it.each([
  { advance: 60000 },
  { scope: { installationGeneration: '77777777-7777-4777-8777-777777777777' } },
  { publication: 'replacement' },
  { expireKey: 'confirmation' },
])('rechecks after signer await: %j', async change => {
  pause('capability');
  const result = call('/issue');
  await entered;
  await call('/control', change);
  release();
  expect((await result).ok).toBe(false);
  expect((await call('/state')).evidence).toEqual([{ R: 1, S: 1, U: 0, A: 0 }]);
});
it('capacity fails before signing, never evicting live admission', async () => {
  await call('/control', { capacity: 1 });
  expect((await call('/issue')).ok).toBe(true);
  expect((await call('/issue', { submission: 'other' })).ok).toBe(false);
  expect(counts.capability).toBe(1);
  expect((await call('/state')).rows).toHaveLength(1);
});
it('reply loss after durable commit preserves historical A and prevents re-signing after restart', async () => {
  const attempt = crypto.randomUUID();
  await call('/control', { failure: 'sync-after-2' });
  expect((await call('/issue', { attempt })).ok).toBe(false);
  expect((await call('/state')).evidence[0].A).toBe(1);
  await restart();
  expect(await call('/issue', { attempt })).toEqual({ ok: false, error: 'attempt_already_seen' });
  expect(counts.capability).toBe(1);
  expect((await call('/state')).evidence[0].A).toBe(1);
});
it('one immutable join event retries unchanged and ack survives restart', async () => {
  expect((await call('/issue')).ok).toBe(true);
  const state = await call('/state');
  const handle = state.rows[0].handle;
  expect((await call('/join', { handle, missing: true })).ok).toBe(false);
  const joined = await call('/join', { handle });
  expect(joined.ok).toBe(true);
  expect(joined.command.arguments).toHaveLength(17);
  expect(joined.command.arguments.slice(13)).toEqual(['0.1.0', '0.2.0', null, 2]);
  expect(await call('/join', { handle })).toEqual(joined);
  expect((await call('/join', { handle, patch: { eventHash: 'd'.repeat(64) } })).ok).toBe(false);
  const event = 'b'.repeat(64);
  expect((await call('/pending', { event })).command).toEqual(joined.command);
  expect((await call('/pending', { event, ack: true })).state).toBe('acknowledged');
  await restart();
  expect((await call('/pending', { event })).state).toBe('acknowledged');
  expect(await call('/join', { handle })).toEqual(joined);
  expect((await call('/pending', { event })).state).toBe('acknowledged');
});
it('read-time expiry blocks admission evidence and pending work before physical purge', async () => {
  await call('/issue');
  const state = await call('/state');
  await call('/join', { handle: state.rows[0].handle });
  await call('/control', { advance: 2592000000 });
  expect((await call('/pending', { event: 'b'.repeat(64) })).ok).toBe(false);
  expect((await call('/state')).evidence).toEqual([null]);
  await call('/alarm');
  expect((await call('/state')).rows).toEqual([]);
  expect((await call('/issue', { issuedAt: initial })).error).toBe('attempt_expired');
});
it.each(['sync-1', 'capability', 'confirmation', 'sync-2'])(
  'hard restart at %s never re-signs and preserves uncertainty',
  async at => {
    const attempt = crypto.randomUUID();
    pause(at);
    const abandoned = call('/issue', { attempt }).catch(() => undefined);
    await entered;
    const preCrashCandidate = candidate;
    await runtime.dispose();
    release();
    await boot();
    await abandoned;
    const recovered = await call('/state');
    expect(recovered.rows).toHaveLength(1);
    expect(recovered.rows[0].state).toBe(at === 'sync-2' ? 'admitted' : 'failed-unconfirmed');
    expect(recovered.evidence[0]).toEqual({
      R: 1,
      S: ['confirmation', 'sync-2'].includes(at) ? 1 : 'UNKNOWN',
      U: ['confirmation', 'sync-2'].includes(at) ? 0 : 1,
      A: at === 'sync-2' ? 1 : 0,
    });
    expect(await call('/issue', { attempt })).toEqual({ ok: false, error: 'attempt_already_seen' });
    expect(counts.capability).toBe(at === 'sync-1' ? 0 : 1);
    if (preCrashCandidate)
      expect((await call('/verify', { capability: preCrashCandidate })).ok).toBe(at === 'sync-2');
  }
);
it.each(['alarm', 'sync-before-1', 'sync-after-1'])(
  'storage %s failure spends no replacement permit and never signs',
  async failure => {
    const attempt = crypto.randomUUID();
    await call('/control', { failure });
    expect((await call('/issue', { attempt })).ok).toBe(false);
    expect(counts.capability).toBe(0);
    await call('/control', { failure: '' });
    expect(await call('/issue', { attempt })).toEqual({ ok: false, error: 'attempt_already_seen' });
    expect((await call('/state')).evidence).toEqual([{ R: 1, S: 'UNKNOWN', U: 1, A: 0 }]);
  }
);
it('seals success at the shared deadline while late completion can only improve S', async () => {
  pause('capability');
  const result = call('/issue');
  await entered;
  const answer = await result;
  expect(answer.ok).toBe(false);
  expect((await call('/state')).evidence).toEqual([{ R: 1, S: 'UNKNOWN', U: 1, A: 0 }]);
  release();
  for (let i = 0; i < 20; i++) {
    const state = await call('/state');
    if (state.evidence[0].S === 1) break;
    await new Promise(r => setTimeout(r, 10));
  }
  expect((await call('/state')).evidence).toEqual([{ R: 1, S: 1, U: 0, A: 0 }]);
  expect((await call('/verify', { capability: candidate })).ok).toBe(false);
  expect(counts.confirmation).toBe(0);
}, 12000);
it.each([
  { raw: 'changed feedback' },
  { submission: 'other' },
  { origin: 'https://other.example.test' },
])('rejects mismatched submitted binding after admission: %j', async change => {
  const result = await call('/issue');
  expect(result.ok).toBe(true);
  expect((await call('/verify', { capability: result.capability, ...change })).ok).toBe(false);
});
it('purges history only after its extra five-minute verification margin', async () => {
  await call('/issue');
  const state = await call('/state');
  expect(state.history).toHaveLength(3);
  expect(state.alarm).toBe(initial + 2592000000);
  await call('/control', { advance: 2592000000 });
  await call('/alarm');
  expect((await call('/state')).history).toHaveLength(3);
  await call('/control', { advance: 300000 });
  await call('/alarm');
  expect((await call('/state')).history).toEqual([]);
  expect((await call('/state')).alarm).toBeNull();
});
it('existing permanent uninstall latch blocks admission and verification even if private snapshot is active', async () => {
  const result = await call('/issue');
  await call('/control', { revoke: true });
  expect((await call('/verify', { capability: result.capability })).ok).toBe(false);
  expect((await call('/issue', { submission: 'other' })).ok).toBe(false);
  expect(counts.capability).toBe(1);
  expect((await call('/state')).evidence[0].A).toBe(1);
});
it('one existing DO alarm always schedules the earliest observation or P5 expiry', async () => {
  await call('/issue');
  await call('/lease', { duration: 900000 });
  expect((await call('/state')).alarm).toBe(initial + 900000);
  await call('/control', { advance: 900000 });
  await call('/alarm');
  expect((await call('/state')).alarm).toBe(initial + 2592000000);
  await call('/control', { advance: 2592000000 - 900000 - 1000 });
  await call('/lease', { duration: 900000 });
  expect((await call('/state')).alarm).toBe(initial + 2592000000);
  await call('/control', { advance: 1000 });
  await call('/alarm');
  expect((await call('/state')).rows).toEqual([]);
  expect((await call('/state')).alarm).toBe(initial + 2592000000 + 300000);
});
it('reservation transaction rollback leaves R=S=A=0', async () => {
  await call('/control', { failure: 'reserve-write' });
  expect((await call('/issue')).ok).toBe(false);
  expect((await call('/state')).rows).toEqual([]);
  expect(counts.capability).toBe(0);
});
it.each(['known-write', 'admit-write'])(
  'rollback at %s cannot authorize a signed candidate',
  async failure => {
    await call('/control', { failure });
    expect((await call('/issue')).ok).toBe(false);
    expect((await call('/state')).evidence[0]).toEqual({
      R: 1,
      S: failure === 'known-write' ? 'UNKNOWN' : 1,
      U: failure === 'known-write' ? 1 : 0,
      A: 0,
    });
    expect((await call('/verify', { capability: candidate })).ok).toBe(false);
    expect(counts.capability).toBe(1);
  }
);
it('retained catalog capacity blocks new admission without evicting live history', async () => {
  await call('/control', { historyFull: true });
  expect((await call('/issue')).ok).toBe(false);
  expect((await call('/state')).history).toHaveLength(128);
  expect((await call('/state')).rows).toEqual([]);
  expect(counts.capability).toBe(0);
});
it('V1 private credential mode cannot be relabeled into a V2 admission', async () => {
  await call('/control', { mode: 1 });
  expect((await call('/issue')).ok).toBe(false);
  expect((await call('/state')).rows).toEqual([]);
  expect(counts.capability).toBe(0);
});
it.each([
  [{ typ: 'bugdrop-local-capability-v1' }, {}],
  [{ alg: 'HS256' }, {}],
  [{ extra: true }, {}],
  [{}, { protocolVersion: 1 }],
  [{}, { iss: 'bugdrop-managed-production-v2' }],
  [{}, { aud: 'bugdrop-managed-local-ingress-v2' }],
  [{}, { publicApplicationId: 'app_other' }],
  [{}, { jti: '77777777-7777-4777-8777-777777777777' }],
  [{}, { extra: true }],
  [{}, { iat: initial / 1000 + 1 }],
  [{}, { exp: initial / 1000 + 301 }],
])(
  'authenticated V2 verifier rejects signed incompatible claims %j / %j',
  async (headerPatch, payloadPatch) => {
    const result = await call('/issue');
    expect(result.ok).toBe(true);
    const parts = result.capability.token.split('.');
    const header = { ...JSON.parse(Buffer.from(parts[0], 'base64url').toString()), ...headerPatch };
    const payload = {
      ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
      ...payloadPatch,
    };
    const message =
      Buffer.from(JSON.stringify(header)).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(payload)).toString('base64url');
    const key = await webcrypto.subtle.importKey(
      'jwk',
      JSON.parse(bindings.TEST_KEYS)[0].privateKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const signature = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(message)
    );
    const capability = {
      ...result.capability,
      token: message + '.' + Buffer.from(signature).toString('base64url'),
    };
    expect((await call('/verify', { capability })).ok).toBe(false);
  }
);

it('rejects backward reservation clock before signing rather than clamping confirmation time', async () => {
  pause('sync-1');
  const result = call('/issue');
  await entered;
  await call('/control', { advance: -1 });
  release();
  expect((await result).ok).toBe(false);
  expect(counts.capability).toBe(0);
  expect((await call('/state')).evidence[0].A).toBe(0);
});
it('equivalent reordered original scope remains verifiable and joinable', async () => {
  const result = await call('/issue');
  const row = (await call('/state')).rows[0];
  await call('/control', { reorderScope: true });
  expect((await call('/verify', { capability: result.capability })).ok).toBe(true);
  expect(
    (
      await call('/join', {
        handle: row.handle,
        patch: { scope: Object.fromEntries(Object.entries(row.scope).reverse()) },
      })
    ).ok
  ).toBe(true);
});
it('random handle collision fails closed without replacement or overwriting original evidence', async () => {
  await call('/issue');
  const original = (await call('/state')).rows[0];
  expect((await call('/issue', { submission: 'other', handleCollision: original.handle })).ok).toBe(
    false
  );
  expect((await call('/state')).rows).toEqual([original]);
  expect(counts.capability).toBe(1);
});
it('catalog-normalized unknown browser claim stays null through the original delivery join', async () => {
  expect(
    (
      await call('/issue', {
        intent: {
          browserSdkVersion: '99.0.0',
          normalizedVersions: {
            sdkVersion: '0.1.0',
            browserSdkVersion: null,
            widgetVersion: null,
            protocolVersion: 2,
          },
        },
      })
    ).ok
  ).toBe(true);
  const row = (await call('/state')).rows[0];
  expect((await call('/join', { handle: row.handle })).command.arguments.slice(13)).toEqual([
    '0.1.0',
    null,
    null,
    2,
  ]);
});
it('delayed original delivery keeps its own acceptance time while P5 expires at original reservation', async () => {
  await call('/issue');
  const row = (await call('/state')).rows[0];
  await call('/control', { advance: 240000 });
  const joined = await call('/join', { handle: row.handle });
  expect(joined.ok).toBe(true);
  expect(joined.command.arguments[7]).toBe(new Date(initial + 240000).toISOString());
  expect((await call('/state')).rows[0].retentionDeadline).toBe(initial + 2592000000);
  await call('/control', { advance: 1000 });
  expect((await call('/join', { handle: row.handle })).ok).toBe(false);
  expect((await call('/pending', { event: 'b'.repeat(64) })).command).toEqual(joined.command);
});
it('canonical non-default HTTPS ports are valid original configuration in the isolated core', async () => {
  await call('/control', {
    scope: {
      origin: 'https://customer.example.test:8443',
      endpoint: 'https://issuance.example.test:8443/v2/submission-capabilities',
    },
  });
  const result = await call('/issue');
  expect(result.ok).toBe(true);
  expect((await call('/verify', { capability: result.capability })).ok).toBe(true);
});
it.each([{ authorization: 'Bearer bd_auth_v2.ICEiIyQlJicoKSorLC0uLw.AA' }, { mac: '!' }])(
  'malformed authentication bytes report authentication failure %j',
  async input => {
    expect(await call('/issue', input)).toEqual({ ok: false, error: 'authentication_failed' });
    expect(counts.capability).toBe(0);
    expect((await call('/state')).rows).toEqual([]);
  }
);
