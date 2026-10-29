import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CAPABILITY_WRANGLER_VERSION,
  CloudflareAdapterError,
  createWranglerPlan,
  executeWrangler,
  parseDeploymentStatus,
  parseDeploymentList,
  parseVersionList,
  parseEnvironmentTarget,
  parseVersionView,
  reconcileDeployment,
  verifyRollback,
} from '../../scripts/release/cloudflare-adapter.mjs';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/release/cloudflare');
const SHA = '1'.repeat(40);

async function fixture(name: string) {
  return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8'));
}

function config(name = 'bugdrop') {
  return Buffer.from(
    [
      'name = "root-forbidden"',
      '[env.production]',
      `name = "${name}"`,
      'workers_dev = true',
      '[env.production.assets]',
      'directory = "public"',
    ].join('\n')
  );
}

function lock(version = CAPABILITY_WRANGLER_VERSION) {
  return Buffer.from(JSON.stringify({ packages: { 'node_modules/wrangler': { version } } }));
}

function plan(overrides: Record<string, unknown> = {}) {
  return createWranglerPlan({
    controllerRoot: '/trusted/controller',
    candidateRoot: '/approved/candidate',
    controllerConfig: '/trusted/controller/wrangler.toml',
    candidateEntrypoint: '/approved/candidate/src/index.ts',
    candidateAssets: '/approved/candidate/public',
    controllerConfigBytes: config(),
    controllerLockBytes: lock(),
    environment: 'production',
    expectedTarget: 'bugdrop',
    targetSha: SHA,
    ...overrides,
  });
}

describe('controller-owned Cloudflare command plan', () => {
  it('accepts the repository lockfile as the release controller', async () => {
    const controllerLockBytes = await readFile(
      resolve(import.meta.dirname, '../../package-lock.json')
    );
    expect(plan({ controllerLockBytes }).wranglerVersion).toBe(CAPABILITY_WRANGLER_VERSION);
  });

  it('pins the named environment and omits the unsafe name override', () => {
    const result = plan();
    expect(result).toMatchObject({
      target: 'bugdrop',
      environment: 'production',
      wranglerVersion: CAPABILITY_WRANGLER_VERSION,
    });
    expect(result.deploy.executable).toBe('/trusted/controller/node_modules/.bin/wrangler');
    expect(result.deploy.args).toEqual([
      'deploy',
      '/approved/candidate/src/index.ts',
      '--config',
      '/trusted/controller/wrangler.toml',
      '--env',
      'production',
      '--assets',
      '/approved/candidate/public',
      '--var',
      `BUILD_SHA:${SHA}`,
    ]);
    for (const command of [result.status, result.deployments, result.versions, result.deploy]) {
      expect(command.args).not.toContain('--name');
    }
    expect(result.rollback('baseline-version', 'restore exact baseline').args).toEqual([
      'rollback',
      'baseline-version',
      '--config',
      '/trusted/controller/wrangler.toml',
      '--env',
      'production',
      '--message',
      'restore exact baseline',
      '--yes',
    ]);
  });

  it.each([
    ['wrong target', { controllerConfigBytes: config('other-worker') }],
    ['wrong environment', { environment: 'staging' }],
    ['wrong Wrangler', { controllerLockBytes: lock('4.99.0') }],
    ['controller escape', { controllerConfig: '/untrusted/wrangler.toml' }],
    ['candidate source escape', { candidateEntrypoint: '/trusted/controller/src/index.ts' }],
    ['candidate asset escape', { candidateAssets: '/trusted/controller/public' }],
    ['invalid SHA', { targetSha: 'main' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => plan(overrides)).toThrow(CloudflareAdapterError);
  });

  it('rejects missing, duplicate, and unsafe environment names', () => {
    expect(() =>
      parseEnvironmentTarget('[env.production]\nworkers_dev=true', 'production', 'bugdrop')
    ).toThrow('exactly one name');
    expect(() =>
      parseEnvironmentTarget(
        '[env.production]\nname="bugdrop"\nname="bugdrop"',
        'production',
        'bugdrop'
      )
    ).toThrow('exactly one name');
    expect(() =>
      parseEnvironmentTarget('[env.production]\nname=target_from_input', 'production', 'bugdrop')
    ).toThrow('unsafe');
  });

  it('pins the preview target for the non-production capability drill', () => {
    const result = plan({
      controllerConfigBytes: Buffer.from('[env.preview]\nname="bugdrop-preview"\n'),
      environment: 'preview',
      expectedTarget: 'bugdrop-preview',
    });
    expect(result).toMatchObject({ environment: 'preview', target: 'bugdrop-preview' });
    expect(result.deploy.args).toContain('preview');
    expect(result.deploy.args).not.toContain('--name');
  });
});

describe('authoritative Cloudflare observations', () => {
  it('normalizes the sole fully active deployment', async () => {
    expect(parseDeploymentStatus(await fixture('status-active'))).toEqual({
      deploymentId: 'deployment-current',
      versionId: 'version-current',
      createdOn: '2026-08-03T12:00:00.000Z',
      source: 'wrangler',
      strategy: 'percentage',
    });
  });

  it('normalizes bounded deployment and version lists', async () => {
    const deployment = await fixture('status-active');
    expect(parseDeploymentList([deployment])).toEqual([parseDeploymentStatus(deployment)]);
    expect(
      parseVersionList([
        {
          id: 'version-current',
          metadata: { created_on: '2026-08-03T12:00:00Z', source: 'wrangler' },
        },
      ])
    ).toEqual([
      {
        versionId: 'version-current',
        createdOn: '2026-08-03T12:00:00Z',
        source: 'wrangler',
      },
    ]);
  });

  it.each([[], Array.from({ length: 101 }, () => ({}))])(
    'rejects empty or unbounded deployment lists',
    value => {
      expect(() => parseDeploymentList(value)).toThrow(CloudflareAdapterError);
    }
  );

  it.each([
    ['split traffic', async () => fixture('status-split')],
    ['empty traffic', async () => ({ ...(await fixture('status-active')), versions: [] })],
    [
      'multiple full versions',
      async () => {
        const value = await fixture('status-active');
        value.versions.push({ version_id: 'second-version', percentage: 100 });
        return value;
      },
    ],
    ['malformed JSON', async () => '{'],
  ])('rejects %s', async (_name, value) => {
    const response = await value();
    expect(() => parseDeploymentStatus(response)).toThrow(CloudflareAdapterError);
  });

  it('normalizes only the candidate identity and required asset metadata', async () => {
    const response = await fixture('version-current');
    response.resources.bindings.push({
      name: 'SECRET_BINDING',
      type: 'secret_text',
      text: 'must-not-escape',
    });
    const result = parseVersionView(response, 'version-current');
    expect(result).toEqual({
      versionId: 'version-current',
      createdOn: '2026-08-03T12:00:00.000Z',
      source: 'wrangler',
      scriptEtag: 'script-etag-current',
      buildSha: SHA,
      assets: { rawRunWorkerFirst: true, serveDirectly: false },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
  });

  it('rejects a version response for a different deployment', async () => {
    const response = await fixture('version-current');
    expect(() => parseVersionView(response, 'other-version')).toThrow(CloudflareAdapterError);
  });

  it('rejects missing static asset metadata', async () => {
    const response = await fixture('version-current');
    response.resources.bindings = response.resources.bindings.filter(
      (binding: { name: string }) => binding.name !== 'ASSETS'
    );
    expect(() => parseVersionView(response, 'version-current')).toThrow(CloudflareAdapterError);
  });

  it('rejects a malformed candidate build identity', async () => {
    const response = await fixture('version-current');
    response.resources.bindings.find(
      (binding: { name: string }) => binding.name === 'BUILD_SHA'
    ).text = 'main';
    expect(() => parseVersionView(response, 'version-current')).toThrow(CloudflareAdapterError);
  });
});

describe('response-loss and rollback decisions', () => {
  const before = { versionId: 'version-before' };
  const after = { versionId: 'version-current' };
  const version = { versionId: 'version-current', buildSha: SHA };
  const live = { sourceVerified: true, assetVerified: true, buildSha: SHA };

  it('accepts a candidate proven after an unknown deploy response', () => {
    expect(
      reconcileDeployment({
        commandStatus: 'unknown',
        before,
        after,
        version,
        expectedBuildSha: SHA,
        live,
      })
    ).toEqual({ status: 'candidate-active', versionId: 'version-current' });
  });

  it.each([
    ['missing inspection', { after: null }],
    ['wrong version metadata', { version: { ...version, versionId: 'other' } }],
    ['wrong live SHA', { live: { ...live, buildSha: '2'.repeat(40) } }],
    ['missing asset proof', { live: { ...live, assetVerified: false } }],
  ])('fails closed for %s', (_name, change) => {
    expect(
      reconcileDeployment({
        commandStatus: 'unknown',
        before,
        after,
        version,
        expectedBuildSha: SHA,
        live,
        ...change,
      })
    ).toMatchObject({ status: 'ambiguous-critical' });
  });

  it('requires exact source and asset identity after rollback', () => {
    const input = {
      baseline: {
        versionId: 'version-before',
        scriptEtag: 'etag-before',
        sourceIdentity: 'source-before',
        assetIdentity: 'asset-before',
      },
      after: { versionId: 'version-before' },
      version: { scriptEtag: 'etag-before' },
      live: { sourceIdentity: 'source-before', assetIdentity: 'asset-before' },
    };
    expect(verifyRollback(input)).toEqual({ status: 'verified' });
    expect(
      verifyRollback({ ...input, live: { ...input.live, assetIdentity: 'asset-after' } })
    ).toEqual({ status: 'mismatch', fields: ['assetIdentity'] });
  });

  it('spawns the locked plan without a shell and does not expose raw output', () => {
    const command = plan().status;
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ secret: 'raw-value' }),
      stderr: 'credential-bearing diagnostic',
    }));
    expect(
      executeWrangler(
        command,
        value => ({ observed: JSON.parse(value).secret === 'raw-value' }),
        spawn
      )
    ).toEqual({ status: 'succeeded', value: { observed: true } });
    expect(spawn).toHaveBeenCalledWith(
      command.executable,
      command.args,
      expect.objectContaining({ cwd: command.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });
});
