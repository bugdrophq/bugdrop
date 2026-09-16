import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { start } from '../../managed/local/adapter.mjs';
const fixtures = Object.fromEntries(
  readdirSync('test/protocol/v1/fixtures')
    .filter(n => n.endsWith('.v1.json'))
    .map(n => [n, JSON.parse(readFileSync(`test/protocol/v1/fixtures/${n}`, 'utf8'))])
);
const vector = fixtures['submission-binding.v1.json'];
let service: Awaited<ReturnType<typeof start>>;
beforeEach(async () => {
  service = await start({ fixtures });
}, 30000);
afterEach(async () => {
  await service?.close();
}, 30000);
async function mint() {
  const reply = await fetch(service.endpoint, {
    method: 'POST',
    headers: {
      Authorization: fixtures['api-key-credential.v1.json'].authorization,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
      'X-BugDrop-Contract-Version': '1',
      'X-BugDrop-SDK-Version': '0.1.0',
    },
    body: JSON.stringify({ schemaVersion: 1, ...vector.bound, origin: service.origin }),
  });
  return { status: reply.status, capability: await reply.json() };
}
const submit = (capability: unknown) =>
  service.submit({ capability, binding: vector.bound, requestBody: vector.requestBody });
describe.sequential('real managed Workers and durable SQLite receipt', () => {
  it('admits only one concurrent attempt and replays durable result across restart', async () => {
    const c = await mint();
    expect(c.status).toBe(200);
    const results = await Promise.all(Array.from({ length: 12 }, () => submit(c.capability)));
    expect(results.every(r => ['delivered', 'delivering'].includes(r.outcome))).toBe(true);
    await service.restart();
    expect((await submit(c.capability)).outcome).toBe('delivered');
    expect((await service.evidence()).attempts).toBe(1);
  }, 30000);
  it.each(['timeout', 'indeterminate'])(
    'never retries %s and excludes fake response canaries',
    async mode => {
      service.setDeliveryMode(mode, { canary: 'PRIVATE_GITHUB_TOKEN_CONTENT' });
      const c = await mint();
      expect((await submit(c.capability)).outcome).toBe('indeterminate');
      const remint = await mint();
      await service.restart();
      expect((await submit(remint.capability)).outcome).toBe('indeterminate');
      const evidence = await service.evidence();
      expect(evidence.attempts).toBe(1);
      for (const forbidden of [
        'PRIVATE_GITHUB_TOKEN_CONTENT',
        vector.requestBody,
        vector.bound.submissionId,
        c.capability.token,
        fixtures['api-key-credential.v1.json'].apiKey,
      ])
        expect(JSON.stringify(evidence)).not.toContain(forbidden);
      expect(evidence.networkRequests).toEqual([]);
    },
    30000
  );
  it('recovers a live delivery crash without calling fake GitHub twice', async () => {
    service.setDeliveryMode('hold');
    const c = await mint();
    const attempt = submit(c.capability);
    await expect.poll(async () => (await service.evidence()).attempts).toBe(1);
    expect((await service.inspectReceipt(vector.bound)).state).toBe('delivering');
    await service.restart();
    await attempt;
    expect((await submit(c.capability)).outcome).toBe('indeterminate');
    expect((await service.evidence()).attempts).toBe(1);
  }, 30000);
  it('rejects stale projection and signed uninstall forgery before accepting verified deletion', async () => {
    const c = await mint();
    service.expireAuthorizationState();
    expect((await mint()).status).toBe(403);
    expect((await submit(c.capability)).outcome).toBe('rejected');
    service.refreshAuthorizationState();
    for (const options of [
      { validSignature: false },
      { tamperBody: true },
      { installationId: 43 },
      { event: 'push' },
      { action: 'created' },
    ])
      expect(await service.uninstall(options)).toEqual({ accepted: false });
    expect((await mint()).status).toBe(200);
    expect(await service.uninstall()).toEqual({ accepted: true });
    await service.restart();
    expect((await mint()).status).toBe(403);
    expect((await submit(c.capability)).outcome).toBe('rejected');
    expect((await service.evidence()).attempts).toBe(0);
  }, 30000);
  it('allows key overlap but rejects retired signing keys and expired capabilities', async () => {
    const c = await mint();
    await service.rotateSigningKey();
    expect((await submit(c.capability)).outcome).toBe('delivered');
    await service.rotateSigningKey({ retirePrevious: true });
    expect((await submit(c.capability)).outcome).toBe('rejected');
    const fresh = await mint();
    service.advanceClock(300_001);
    expect((await submit(fresh.capability)).outcome).toBe('rejected');
    expect((await service.evidence()).attempts).toBe(1);
  }, 30000);
});
