import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ProductionStateError,
  classifyDeploymentObservation,
  createRecoveryEvidence,
  createWorkerProvenance,
  inspectProductionState,
  normalizeProductionState,
  verifyProductionBaseline,
} from '../../scripts/release/production-state.mjs';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/release/production-state');
const ROOT = resolve(import.meta.dirname, '../..');
const SHA = '1'.repeat(40);
const PLAN_ID = `sha256:${'2'.repeat(64)}`;

async function fixture(name: string) {
  return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8'));
}

function controllerLock(wrangler = '4.98.0') {
  return Buffer.from(
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/wrangler': { version: wrangler },
        'node_modules/esbuild': { version: '0.28.0' },
      },
    })
  );
}

function provenance(overrides: Record<string, unknown> = {}) {
  return createWorkerProvenance({
    targetSha: SHA,
    releasePlanIdentity: PLAN_ID,
    candidateFiles: [
      { path: 'src/index.ts', bytes: Buffer.from('export default {};') },
      { path: 'src/routes/api.ts', bytes: Buffer.from('export const api = {};') },
    ],
    candidateLockBytes: Buffer.from('{"lockfileVersion":3}'),
    controllerLockBytes: controllerLock(),
    controllerConfigBytes: Buffer.from('[env.production]\nname="bugdrop"\n'),
    entrypoint: 'src/index.ts',
    moduleRoot: 'node_modules',
    environment: 'production',
    ...overrides,
  });
}

describe('Worker provenance', () => {
  it('derives the deploy toolchain from this controller checkout lockfile', async () => {
    const [controllerLockBytes, controllerConfigBytes, entrypointBytes] = await Promise.all([
      readFile(join(ROOT, 'package-lock.json')),
      readFile(join(ROOT, 'wrangler.toml')),
      readFile(join(ROOT, 'src/index.ts')),
    ]);
    const result = createWorkerProvenance({
      targetSha: SHA,
      releasePlanIdentity: PLAN_ID,
      candidateFiles: [{ path: 'src/index.ts', bytes: entrypointBytes }],
      candidateLockBytes: controllerLockBytes,
      controllerLockBytes,
      controllerConfigBytes,
      entrypoint: 'src/index.ts',
      moduleRoot: 'node_modules',
      environment: 'production',
    });
    expect(result.toolchain).toEqual({ esbuild: '0.28.1', wrangler: '4.151.1' });
  });

  it('pins controller tools and produces a path-independent staging identity', () => {
    const first = provenance();
    const reordered = provenance({
      candidateFiles: [
        { path: 'src/routes/api.ts', bytes: Buffer.from('export const api = {};') },
        { path: 'src/index.ts', bytes: Buffer.from('export default {};') },
      ],
    });
    expect(first).toMatchObject({
      environment: 'production',
      targetSha: SHA,
      toolchain: { esbuild: '0.28.0', wrangler: '4.98.0' },
      workerIntegrityClaim: 'source-lock-tool-config-live-sha',
      deploymentVariables: { BUILD_SHA: SHA, ENVIRONMENT: 'production' },
    });
    expect(reordered).toEqual(first);
  });

  it.each([
    ['source', { candidateFiles: [{ path: 'src/index.ts', bytes: Buffer.from('changed') }] }],
    ['candidate lock', { candidateLockBytes: Buffer.from('{"changed":true}') }],
    ['controller config', { controllerConfigBytes: Buffer.from('[env.production]\nname="other"') }],
    ['toolchain', { controllerLockBytes: controllerLock('4.99.0') }],
  ])('changes staging identity when %s changes', (_name, change) => {
    expect(provenance(change).stagingIdentity).not.toBe(provenance().stagingIdentity);
  });

  it.each([
    ['candidate escape', { candidateFiles: [{ path: '../secret', bytes: Buffer.from('x') }] }],
    ['entry escape', { entrypoint: '../src/index.ts' }],
    ['absolute module root', { moduleRoot: '/tmp/node_modules' }],
    ['controller module root', { moduleRoot: 'controller-node_modules' }],
    ['non-production environment', { environment: 'preview' }],
  ])('rejects %s', (_name, change) => {
    expect(() => provenance(change)).toThrow(ProductionStateError);
  });
});

describe('production baseline normalization', () => {
  it('normalizes the current unidentified deployment as a truthful bootstrap baseline', async () => {
    const baseline = normalizeProductionState(await fixture('bootstrap'));
    expect(baseline.kind).toBe('bootstrap');
    expect(baseline.health).toEqual({ environment: 'development', status: 'ok' });
    expect(baseline.health).not.toHaveProperty('buildSha');
  });

  it('normalizes a future production-identified baseline', async () => {
    const baseline = normalizeProductionState(await fixture('identified'));
    expect(baseline).toMatchObject({
      kind: 'identified',
      health: { environment: 'production', buildSha: 'c'.repeat(40) },
      cloudflare: { deploymentId: 'deployment-identified', versionId: 'version-identified' },
    });
  });

  it.each([
    ['incomplete API', async () => fixture('ambiguous')],
    [
      'multiple active deployments',
      async () => {
        const state = await fixture('identified');
        state.activeDeployments.push({ ...state.activeDeployments[0], deploymentId: 'duplicate' });
        return state;
      },
    ],
    [
      'production without build SHA',
      async () => {
        const state = await fixture('identified');
        delete state.health.buildSha;
        return state;
      },
    ],
  ])('fails closed for %s', async (_name, input) => {
    expect(inspectProductionState(await input())).toMatchObject({ status: 'ambiguous' });
  });

  it('verifies the complete prior baseline rather than only a deployment ID', async () => {
    const expected = normalizeProductionState(await fixture('identified'));
    expect(verifyProductionBaseline(expected, expected)).toEqual({ status: 'verified' });
    const changed = structuredClone(expected);
    changed.assets.aliases['widget.js'] = '0'.repeat(64);
    expect(verifyProductionBaseline(expected, changed)).toMatchObject({
      status: 'mismatch',
      fields: expect.arrayContaining(['assets.aliases.widget.js']),
    });
    const incomplete = structuredClone(expected) as Record<string, unknown>;
    delete (incomplete.health as Record<string, unknown>).buildSha;
    expect(verifyProductionBaseline(expected, incomplete)).toMatchObject({
      status: 'mismatch',
      fields: expect.arrayContaining(['health.buildSha']),
    });
  });
});

describe('ambiguous mutation and recovery evidence', () => {
  it('does not assume a failed command left production unchanged', async () => {
    const before = normalizeProductionState(await fixture('bootstrap'));
    const candidate = normalizeProductionState(await fixture('identified'));
    expect(
      classifyDeploymentObservation({
        commandStatus: 'failed',
        before,
        after: candidate,
        candidate,
      })
    ).toEqual({ status: 'candidate-active' });
    expect(
      classifyDeploymentObservation({ commandStatus: 'failed', before, after: null, candidate })
    ).toMatchObject({ status: 'ambiguous-critical' });
  });

  it('emits bounded recovery evidence without claiming a rollback command', async () => {
    const before = normalizeProductionState(await fixture('bootstrap'));
    const evidence = createRecoveryEvidence({
      releasePlanIdentity: PLAN_ID,
      intendedTargetSha: SHA,
      baseline: before,
      observation: { status: 'ambiguous-critical', reason: 'inspection-unavailable' },
    });
    expect(evidence).toMatchObject({
      automaticCommandAuthorized: false,
      intendedTargetSha: SHA,
      releasePlanIdentity: PLAN_ID,
    });
  });

  it('records a partial publication outcome without authorizing cleanup or rollback commands', async () => {
    const baseline = normalizeProductionState(await fixture('bootstrap'));
    const observation = {
      status: 'partial-resumable',
      recovery: {
        automaticGitHubCleanup: false,
        automaticProductionCommandAuthorized: false,
        preservePublicationState: true,
        production: 'restore-prior-baseline',
      },
    };
    expect(
      createRecoveryEvidence({
        releasePlanIdentity: PLAN_ID,
        intendedTargetSha: SHA,
        baseline,
        observation,
      })
    ).toMatchObject({ automaticCommandAuthorized: false, observation });
  });
});
