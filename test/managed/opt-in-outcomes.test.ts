import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  outcomeCommand,
  encodeOutcome,
  decodeOutcome,
  outcomeLive,
  type OutcomeCommand,
} from '../../src/managed/opt-in/outcome-command';
import {
  dispatchOutcome,
  type OutcomeTransport,
} from '../../src/managed/opt-in/outcome-dispatcher';
import { outcomeSqlTransport } from '../../src/managed/opt-in/outcome-sql';
import { consumeOutcome, type OutcomePending } from '../../src/managed/opt-in/outcome-consumer';
import { retentionMs } from '../../src/managed/opt-in/protocol';

// Exact command from frozen SDK e263209 outcome fixture (file SHA256 a509dfcb65db411ce2aac52410d50ffca69546d0187b3a32393836d0f27eff0b).
const frozen: OutcomeCommand = {
  schemaVersion: 2,
  command: 'ingest_outcome_v2',
  arguments: [
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '33333333-3333-4333-8333-333333333333',
    '66666666-6666-4666-8666-666666666666',
    '22222222-2222-4222-8222-222222222222',
    'c'.repeat(64),
    'd'.repeat(64),
    '2027-01-15T08:00:10.000Z',
    '2027-01-15T08:00:12.000Z',
    'delivered',
    'none',
    true,
    '77777777-7777-4777-8777-777777777777',
    '0.1.0',
    '0.2.0',
    null,
    2,
  ],
};
const initial = Date.parse(frozen.arguments[8]);
const original = (): OutcomeCommand => {
  const c = structuredClone(frozen);
  c.arguments[9] = 'authorized';
  return c;
};
const receipt = (result = 'applied', eventHash = frozen.arguments[5]) =>
  new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, eventHash, result }));
const commit = (result = 'applied') => ({ committed: true, rows: [{ result }] });
function pending(command = original()) {
  let state: 'pending' | 'acknowledged' = 'pending';
  const port = {
    read: vi.fn(async () => ({ state, command: structuredClone(command) })),
    acknowledge: vi.fn(async () => {
      state = 'acknowledged';
    }),
  };
  return { port: port as unknown as OutcomePending, read: port.read, ack: port.acknowledge };
}
afterEach(() => vi.useRealTimers());

it('preserves the exact frozen17 vector and explicitly casts every SQL argument', async () => {
  expect(decodeOutcome(encodeOutcome(frozen))).toEqual(frozen);
  const execute = vi.fn(async () => commit());
  expect(
    await dispatchOutcome(
      frozen,
      outcomeSqlTransport(execute, () => initial),
      () => initial
    )
  ).toEqual({ state: 'accepted', result: 'applied' });
  expect(execute).toHaveBeenCalledTimes(1);
  const [sql, args] = execute.mock.calls[0] as unknown as [string, unknown[]];
  expect(sql).toBe(
    'SELECT private.ingest_outcome_v2(\n  $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,\n  $6::private.receipt_hash,$7::private.receipt_hash,$8::timestamptz,$9::timestamptz,\n  $10::private.delivery_state,$11::private.outcome_reason,$12::boolean,$13::uuid,\n  $14::text,$15::text,$16::text,$17::smallint) AS result'
  );
  expect(args).toEqual(frozen.arguments);
  expect(args).toHaveLength(17);
  expect(sql).not.toContain(frozen.arguments[0]);
});
it.each([13, 14, 15, 16])('preserves NULL at position %i without enrichment', async index => {
  const command = structuredClone(frozen);
  command.arguments[index] = null as never;
  const execute = vi.fn(async () => commit('duplicate'));
  expect(
    (
      await dispatchOutcome(
        command,
        outcomeSqlTransport(execute, () => initial),
        () => initial
      )
    ).state
  ).toBe('accepted');
  expect((execute.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(command.arguments);
});
it('retains four legacy NULL values and allows separately qualified protocol1 shapes', () => {
  const command = structuredClone(frozen);
  command.arguments.splice(13, 4, null, null, null, null);
  expect(decodeOutcome(encodeOutcome(command)).arguments.slice(13)).toEqual([
    null,
    null,
    null,
    null,
  ]);
  command.arguments[16] = 1;
  expect(outcomeCommand(command).arguments[16]).toBe(1);
});
it.each([
  { capability: 'PRIVATE' },
  { confirmation: 'PRIVATE' },
  { intent: 'PRIVATE' },
  { handle: 'PRIVATE' },
  { digest: 'PRIVATE' },
  { key: 'PRIVATE' },
  { userId: 'PRIVATE' },
])('rejects extra private fields %j before transport', async extra => {
  const transport = vi.fn(async () => receipt());
  expect(await dispatchOutcome({ ...frozen, ...extra }, transport, () => initial)).toEqual({
    state: 'quarantined',
  });
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  [0, 'app_public'],
  [2, '42'],
  [5, 'C'.repeat(64)],
  [7, '2027-01-15T08:00:10Z'],
  [8, '2027-01-15T08:00:09.000Z'],
  [9, 'minted'],
  [10, 'unknown'],
  [11, 'true'],
  [13, '01.0.0'],
  [14, '1.0.0-beta'],
  [15, '1000000.0.0'],
  [16, 3],
  [13, undefined],
])('rejects invalid position %i value %j', (index, value) => {
  const command = structuredClone(frozen);
  command.arguments[index as number] = value as never;
  expect(() => outcomeCommand(command)).toThrow('outcome_unavailable');
});
it('rejects duplicate fields, malformed UTF8, oversized bodies and wrong arity', () => {
  const raw = new TextDecoder().decode(encodeOutcome(frozen));
  expect(() =>
    decodeOutcome(
      new TextEncoder().encode(
        raw.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')
      )
    )
  ).toThrow();
  expect(() => decodeOutcome(new Uint8Array([255]))).toThrow();
  expect(() => decodeOutcome(new Uint8Array(2049))).toThrow();
  expect(() => outcomeCommand({ ...frozen, arguments: frozen.arguments.slice(0, 16) })).toThrow();
});
it('uses original delivery acceptance for720h, rejects rollback, and never refreshes timestamps', () => {
  const deadline = Date.parse(frozen.arguments[7]) + retentionMs;
  expect(outcomeLive(frozen, deadline - 1)).toBe(true);
  expect(outcomeLive(frozen, deadline)).toBe(false);
  expect(() => outcomeLive(frozen, initial - 1)).toThrow();
  expect(frozen.arguments.slice(7, 9)).toEqual([
    '2027-01-15T08:00:10.000Z',
    '2027-01-15T08:00:12.000Z',
  ]);
});
it.each(['expired', 'deleted'])('does not acknowledge SQL %s', async result => {
  const p = pending();
  expect(
    await consumeOutcome(
      frozen.arguments[5],
      p.port,
      outcomeSqlTransport(
        async () => commit(result),
        () => initial
      ),
      () => initial
    )
  ).toEqual({ state: result });
  expect(p.ack).not.toHaveBeenCalled();
});
it.each([
  { committed: false, rows: [{ result: 'applied' }] },
  { rows: [{ result: 'applied' }] },
  { committed: true, rows: [{ result: 'applied', secret: 'PRIVATE' }] },
  { committed: true, rows: [{ result: 'applied' }, { result: 'duplicate' }] },
  { committed: true, rows: [{ result: 'ok' }] },
  'applied',
  null,
])('does not acknowledge malformed or uncommitted SQL result %j', async result => {
  const p = pending();
  expect(
    await consumeOutcome(
      frozen.arguments[5],
      p.port,
      outcomeSqlTransport(
        async () => result,
        () => initial
      ),
      () => initial
    )
  ).toEqual({ state: 'pending' });
  expect(p.ack).not.toHaveBeenCalled();
});
it.each(['23514', '23503'])('quarantines SQL constraint %s with a redacted result', async code => {
  const p = pending();
  expect(
    await consumeOutcome(
      frozen.arguments[5],
      p.port,
      outcomeSqlTransport(
        async () => {
          throw Object.assign(new Error('PRIVATE SQL'), { code });
        },
        () => initial
      ),
      () => initial
    )
  ).toEqual({ state: 'quarantined' });
  expect(p.ack).not.toHaveBeenCalled();
});
it('keeps pending for absent transport, missing P5 source or unavailable SQL', async () => {
  const p = pending();
  expect(await consumeOutcome(frozen.arguments[5], p.port, undefined, () => initial)).toEqual({
    state: 'pending',
  });
  const transport = outcomeSqlTransport(
    async () => {
      throw Error('PRIVATE password');
    },
    () => initial
  );
  expect(await consumeOutcome(frozen.arguments[5], p.port, transport, () => initial)).toEqual({
    state: 'pending',
  });
  p.read.mockRejectedValueOnce(Error('PRIVATE missing'));
  expect(await consumeOutcome(frozen.arguments[5], p.port, transport, () => initial)).toEqual({
    state: 'pending',
  });
  expect(p.ack).not.toHaveBeenCalled();
});
it.each([
  receipt('applied', 'e'.repeat(64)),
  receipt('unknown'),
  new Uint8Array(257),
  new TextEncoder().encode('{"secret":"PRIVATE"}'),
])('rejects malformed/wrong-event transport result', async raw => {
  const p = pending();
  expect(
    await consumeOutcome(
      frozen.arguments[5],
      p.port,
      async () => raw,
      () => initial
    )
  ).toEqual({ state: 'pending' });
  expect(p.ack).not.toHaveBeenCalled();
});
it('rejects later outcomes at the P5 consumer despite accepting frozen generic transport vectors', async () => {
  const p = pending(frozen),
    transport = vi.fn(async () => receipt());
  expect(await consumeOutcome(frozen.arguments[5], p.port, transport, () => initial)).toEqual({
    state: 'quarantined',
  });
  expect(transport).not.toHaveBeenCalled();
});
it('refuses changed command after confirmed SQL without acknowledging another tuple', async () => {
  const p = pending(),
    changed = original();
  changed.arguments[13] = null;
  p.read
    .mockResolvedValueOnce({ state: 'pending', command: original() })
    .mockResolvedValueOnce({ state: 'pending', command: changed });
  expect(
    await consumeOutcome(
      frozen.arguments[5],
      p.port,
      async () => receipt(),
      () => initial
    )
  ).toEqual({ state: 'quarantined' });
  expect(p.ack).not.toHaveBeenCalled();
});
it('seals timeout before late committed reply and ignores aborted late SQL', async () => {
  vi.useFakeTimers();
  const p = pending();
  let resolve!: (value: unknown) => void;
  const execute = vi.fn(
    () =>
      new Promise<unknown>(r => {
        resolve = r;
      })
  );
  const task = consumeOutcome(
    frozen.arguments[5],
    p.port,
    outcomeSqlTransport(execute, () => initial),
    () => initial
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(await task).toEqual({ state: 'pending' });
  expect(execute).toHaveBeenCalledTimes(1);
  resolve(commit());
  await vi.advanceTimersByTimeAsync(0);
  expect(p.ack).not.toHaveBeenCalled();
});
it('bounds stalled P5 read and prevents dispatch after late read completion', async () => {
  vi.useFakeTimers();
  const p = pending(),
    transport = vi.fn(async () => receipt());
  let release!: (value: { state: 'pending'; command: OutcomeCommand }) => void;
  p.read.mockImplementationOnce(
    () =>
      new Promise(r => {
        release = r;
      })
  );
  const task = consumeOutcome(frozen.arguments[5], p.port, transport, () => initial);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await task).toEqual({ state: 'pending' });
  release({ state: 'pending', command: original() });
  await vi.advanceTimersByTimeAsync(0);
  expect(transport).not.toHaveBeenCalled();
});
it('never starts SQL when already aborted and respects cancellation during send', async () => {
  const controller = new AbortController();
  controller.abort();
  const p = pending(),
    send = vi.fn(async () => receipt());
  expect(
    await consumeOutcome(frozen.arguments[5], p.port, send, () => initial, controller.signal)
  ).toEqual({ state: 'pending' });
  expect(send).not.toHaveBeenCalled();
});
it('does not acknowledge expiration during SQL wait', async () => {
  let time = initial;
  const p = pending();
  const transport: OutcomeTransport = async () => {
    time = Date.parse(frozen.arguments[7]) + retentionMs;
    return receipt();
  };
  expect(await consumeOutcome(frozen.arguments[5], p.port, transport, () => time)).toEqual({
    state: 'expired',
  });
  expect(p.ack).not.toHaveBeenCalled();
});

let directory: string, runtime: Miniflare, script: string;
let reached: () => void, release: () => void, gate: Promise<void>;
let outbound = 0;
async function boot() {
  runtime = new Miniflare({
    host: 'outcomes.bugdrop.localhost',
    modules: true,
    script,
    compatibilityDate: '2026-06-10',
    durableObjects: {
      SOURCE: { className: 'Source', useSQLite: true },
      DEST: { className: 'Destination', useSQLite: true },
    },
    durableObjectsPersist: join(directory, 'state'),
    log: new Log(LogLevel.NONE),
    outboundService: () => {
      outbound++;
      return new Response(null, { status: 403 });
    },
    serviceBindings: {
      GATE: async () => {
        reached();
        await gate;
        return new Response('ok');
      },
    },
  });
  await runtime.ready;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bugdrop-p6-'));
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
  import { DurableObject } from 'cloudflare:workers';
  import { AdmissionStore } from './src/managed/opt-in/admission-store.ts';
  import { PendingWork } from './src/managed/opt-in/pending-work.ts';
  import { consumeOutcome } from './src/managed/opt-in/outcome-consumer.ts';
  import { outcomeSqlTransport } from './src/managed/opt-in/outcome-sql.ts';
  export class Destination extends DurableObject {
    constructor(ctx,env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS receipts (event TEXT PRIMARY KEY, body TEXT NOT NULL)');}
    async fetch(request){
      if(request.method==='GET') return Response.json(this.ctx.storage.sql.exec('SELECT * FROM receipts').toArray());
      const command=await request.json(),event=command[5],body=JSON.stringify(command);
      const result=this.ctx.storage.transactionSync(()=>{
        const rows=this.ctx.storage.sql.exec('SELECT * FROM receipts').toArray();
        for(const r of rows){const old=JSON.parse(r.body);if((r.event===event && r.body!==body) || (old[1]===command[1] && old[6]===command[6] && JSON.stringify(old.slice(13))!==JSON.stringify(command.slice(13))))return 'conflict';}
        if(rows.some(r=>r.event===event))return 'duplicate';
        this.ctx.storage.sql.exec('INSERT INTO receipts VALUES(?,?)',event,body);return 'applied';
      });await this.ctx.storage.sync();return Response.json(result);
    }
  }
  export class Source extends DurableObject {
    constructor(ctx,env){super(ctx,env);this.time=${initial};this.store=new AdmissionStore(ctx.storage,()=>this.time);this.pending=new PendingWork(this.store,()=>this.time);}
    async fetch(request){
      const path=new URL(request.url).pathname, input=request.method==='POST'?await request.json():{};
      const dest=this.env.DEST.get(this.env.DEST.idFromName(this.ctx.id.toString()));
      if(path==='/seed'){
        const command=input.command, a=command.arguments;
        // Synthetic admitted P5 fixture; issuance correctness is exercised by the P5 runtime suite.
        const row={handle:'private-handle',epoch:'fixture',state:'admitted',reservedAt:${initial}-12000,retentionDeadline:input.deadline??${initial}-12000+${retentionMs},
          intent:{attemptId:'private-attempt',submissionId:'private-submission'},scope:{},intentDigest:'PRIVATE_DIGEST',authorityIdentity:'PRIVATE_AUTHORITY',signatureKnown:true,
          pending:{state:'pending',event:a[5],command}};
        this.ctx.storage.sql.exec('INSERT INTO opt_in_admission VALUES(?,?,?,?,?,?,?,?)',row.handle,a[4],'private-attempt',a[1],a[2],'private-submission',row.retentionDeadline,JSON.stringify(row));
        await this.ctx.storage.sync();return Response.json({ok:true});
      }
      if(path==='/time'){this.time=input.now;return Response.json({ok:true});}
      if(path==='/purge'){this.store.purge();await this.ctx.storage.sync();return Response.json({ok:true});}
      if(path==='/inspect')return Response.json({source:this.ctx.storage.sql.exec('SELECT body,deadline FROM opt_in_admission').toArray(),destination:await(await dest.fetch('http://sql.outcomes.bugdrop.localhost/')).json()});
      if(path==='/tamper'){const r=JSON.parse(this.ctx.storage.sql.exec('SELECT body FROM opt_in_admission').one().body);r.pending.command=input.command;r.pending.event=input.command.arguments[5];this.ctx.storage.sql.exec('UPDATE opt_in_admission SET body=?',JSON.stringify(r));await this.ctx.storage.sync();return Response.json({ok:true});}
      if(path==='/consume'){
        const transport=outcomeSqlTransport(async(sql,parameters,signal)=>{
          if(input.mode==='unavailable')throw Error('PRIVATE SQL unavailable');
          const result=await(await dest.fetch('http://sql.outcomes.bugdrop.localhost/',{method:'POST',body:JSON.stringify(parameters)})).json();
          if(result==='conflict')throw Object.assign(Error('PRIVATE conflict'),{code:'23514'});
          if(input.mode==='lost'){await this.env.GATE.fetch('http://gate.outcomes.bugdrop.localhost/');throw Error('PRIVATE unknown commit');}
          if(input.mode==='unknown')throw Error('PRIVATE unknown commit');
          if(input.mode==='malformed')return {committed:true,rows:[{result,private:'PRIVATE'}]};
          return {committed:true,rows:[{result}]};
        },()=>this.time);
        const port={read:e=>this.pending.read(e),acknowledge:async(e,r)=>{if(input.mode==='ack-failure')throw Error('PRIVATE ack');await this.pending.acknowledge(e,r);}};
        return Response.json(await consumeOutcome(input.event,port,transport,()=>this.time));
      }
      return new Response(null,{status:404});
    }
  }
  export default {fetch(request,env){const url=new URL(request.url);const parts=url.pathname.split('/');const id=parts[1];url.pathname='/'+parts.slice(2).join('/');return env.SOURCE.get(env.SOURCE.idFromName(id)).fetch(new Request(url,request));}};
  `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    external: ['cloudflare:workers'],
    logLevel: 'silent',
  });
  script = result.outputFiles[0].text;
  await boot();
});
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function call(id: string, path: string, body?: unknown) {
  const response = await runtime.dispatchFetch(
    `http://outcomes.bugdrop.localhost/${id}/${path}`,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
async function seed(command = original(), deadline?: number) {
  const id = randomUUID();
  await call(id, 'seed', { command, deadline });
  return id;
}
async function inspect(id: string) {
  return (await call(id, 'inspect')) as unknown as {
    source: { body: string; deadline: number }[];
    destination: { event: string; body: string }[];
  };
}
it('actual workerd concurrent consumers retain one original telemetry identity and durable P5 acknowledgement', async () => {
  const id = await seed();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call(id, 'consume', { event: frozen.arguments[5] }))
  );
  expect(results.every(r => r.state === 'acknowledged')).toBe(true);
  const evidence = await inspect(id);
  expect(evidence.destination).toHaveLength(1);
  expect(JSON.parse(evidence.destination[0].body)).toEqual(original().arguments);
  expect(JSON.parse(evidence.source[0].body).pending.state).toBe('acknowledged');
  expect(evidence.source[0].deadline).toBe(initial - 12000 + retentionMs);
  expect(outbound).toBe(0);
});
it.each(['unknown', 'malformed', 'ack-failure'])(
  'actual workerd retries %s after restart without changing identity or clocks',
  async mode => {
    const id = await seed();
    expect(await call(id, 'consume', { event: frozen.arguments[5], mode })).toEqual({
      state: 'pending',
    });
    const before = await inspect(id);
    expect(before.destination).toHaveLength(1);
    expect(JSON.parse(before.source[0].body).pending.state).toBe('pending');
    await runtime.dispose();
    await boot();
    expect(await call(id, 'consume', { event: frozen.arguments[5] })).toEqual({
      state: 'acknowledged',
    });
    const after = await inspect(id);
    expect(after.destination).toEqual(before.destination);
    expect(JSON.parse(after.source[0].body).pending.command).toEqual(original());
    expect(outbound).toBe(0);
  }
);
it('actual workerd hard restart after durable SQL acceptance but before reply/ack replays telemetry only', async () => {
  const id = await seed();
  const entered = new Promise<void>(r => {
    reached = r;
  });
  gate = new Promise<void>(r => {
    release = r;
  });
  const interrupted = runtime
    .dispatchFetch(`http://outcomes.bugdrop.localhost/${id}/consume`, {
      method: 'POST',
      body: JSON.stringify({ event: frozen.arguments[5], mode: 'lost' }),
    })
    .then(r => r.text())
    .catch(() => 'disconnected');
  await entered;
  const evidence = await inspect(id);
  expect(evidence.destination).toHaveLength(1);
  expect(JSON.parse(evidence.source[0].body).pending.state).toBe('pending');
  await runtime.dispose();
  release();
  await interrupted;
  await boot();
  expect(await call(id, 'consume', { event: frozen.arguments[5] })).toEqual({
    state: 'acknowledged',
  });
  expect((await inspect(id)).destination).toEqual(evidence.destination);
  expect(outbound).toBe(0);
});
it('actual workerd unavailable SQL leaves original event pending without destination rows', async () => {
  const id = await seed();
  expect(await call(id, 'consume', { event: frozen.arguments[5], mode: 'unavailable' })).toEqual({
    state: 'pending',
  });
  const e = await inspect(id);
  expect(e.destination).toEqual([]);
  expect(JSON.parse(e.source[0].body).pending.command).toEqual(original());
});
it('actual P5 expiry before physical purge prevents dispatch and never fabricates fresh custody', async () => {
  const deadline = initial + 100;
  const id = await seed(original(), deadline);
  await call(id, 'time', { now: deadline });
  expect(await call(id, 'consume', { event: frozen.arguments[5] })).toEqual({ state: 'pending' });
  expect((await inspect(id)).source).toHaveLength(1);
  expect((await inspect(id)).destination).toEqual([]);
  await call(id, 'purge', {});
  expect((await inspect(id)).source).toEqual([]);
  expect(await call(id, 'consume', { event: frozen.arguments[5] })).toEqual({ state: 'pending' });
});
it('actual delivery expiry is independent of later P5 custody and does not send SQL', async () => {
  const deadline = Date.parse(frozen.arguments[7]) + retentionMs;
  const id = await seed(original(), deadline + 1000);
  await call(id, 'time', { now: deadline });
  expect(await call(id, 'consume', { event: frozen.arguments[5] })).toEqual({ state: 'expired' });
  expect((await inspect(id)).destination).toEqual([]);
});
it('P6 imports have no GitHub delivery path, event generator, credential or route integration', async () => {
  const sources = await Promise.all(
    ['command', 'dispatcher', 'consumer', 'sql'].map(n =>
      readFile(`src/managed/opt-in/outcome-${n}.ts`, 'utf8')
    )
  );
  const text = sources.join('\n');
  expect(text).not.toMatch(/randomUUID|https?:\/\/|\.fetch\(|console\.|process\.env|env\./);
  expect(text).not.toMatch(/import .*['"].*(?:github|delivery|admission-store|verifier)['"]/);
  expect(createHash('sha256').update(JSON.stringify(frozen)).digest('hex')).toBe(
    'edf7ce7f99500189ca2a13ef9ff98ed31a9c24b3de9acbaea1a63ee45535beb0'
  );
});

it.each(['same-event', 'new-event'])(
  'actual SQL fixture rejects changed immutable tuple on %s without ack',
  async variant => {
    const id = await seed();
    expect(await call(id, 'consume', { event: frozen.arguments[5], mode: 'unknown' })).toEqual({
      state: 'pending',
    });
    const before = await inspect(id),
      changed = original();
    changed.arguments[13] = null;
    if (variant === 'new-event') changed.arguments[5] = 'e'.repeat(64);
    // Test-only corruption at the private source boundary; production P5 does not permit this mutation.
    await call(id, 'tamper', { command: changed });
    expect(await call(id, 'consume', { event: changed.arguments[5] })).toEqual({
      state: 'quarantined',
    });
    expect((await inspect(id)).destination).toEqual(before.destination);
    expect(JSON.parse((await inspect(id)).source[0].body).pending.state).toBe('pending');
  }
);
it('rejects a changed event parameter before any telemetry dispatch', async () => {
  const p = pending(),
    send = vi.fn(async () => receipt());
  expect(await consumeOutcome('e'.repeat(64), p.port, send, () => initial)).toEqual({
    state: 'quarantined',
  });
  expect(send).not.toHaveBeenCalled();
});
it('already acknowledged duplicate delivery sends no SQL, and ack failure retries identical command', async () => {
  const p = pending(),
    bodies: string[] = [];
  const send: OutcomeTransport = async body => {
    bodies.push(new TextDecoder().decode(body));
    return receipt(bodies.length === 1 ? 'applied' : 'duplicate');
  };
  p.ack.mockRejectedValueOnce(Error('PRIVATE lost ack'));
  expect(await consumeOutcome(frozen.arguments[5], p.port, send, () => initial)).toEqual({
    state: 'pending',
  });
  expect(await consumeOutcome(frozen.arguments[5], p.port, send, () => initial)).toEqual({
    state: 'acknowledged',
  });
  expect(await consumeOutcome(frozen.arguments[5], p.port, send, () => initial)).toEqual({
    state: 'acknowledged',
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
});
it('bounds a stalled acknowledgement without restarting delivery or generating a new event', async () => {
  vi.useFakeTimers();
  const p = pending(),
    send = vi.fn(async () => receipt());
  p.ack.mockImplementationOnce(() => new Promise<void>(() => {}));
  const task = consumeOutcome(frozen.arguments[5], p.port, send, () => initial);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await task).toEqual({ state: 'pending' });
  expect(send).toHaveBeenCalledTimes(1);
});
