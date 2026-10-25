import { describe, expect, it, vi } from 'vitest';

import {
  CloudflareClientError,
  createPreviewCloudflareClient,
  createProductionCloudflareClient,
} from '../../scripts/release/cloudflare-client.mjs';

const SHA = '1'.repeat(40);

function input(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'account_12345678',
    apiToken: 'token_1234567890123456',
    baseEnv: { PATH: '/trusted/bin' },
    controllerRoot: '/trusted/controller',
    candidateRoot: '/approved/candidate',
    controllerConfig: '/trusted/controller/wrangler.toml',
    candidateEntrypoint: '/approved/candidate/src/index.ts',
    candidateAssets: '/approved/candidate/public',
    controllerConfigBytes: Buffer.from('[env.production]\nname="bugdrop"\n'),
    controllerLockBytes: Buffer.from(
      JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.151.1' } } })
    ),
    targetSha: SHA,
    ...overrides,
  };
}

describe('production Cloudflare client', () => {
  it('injects credentials into no-shell commands without returning them', () => {
    const spawn = vi.fn((_executable, args: string[], options) => ({
      status: 0,
      stdout: args.includes('status')
        ? JSON.stringify({
            id: 'deployment-current',
            created_on: '2026-08-03T12:00:00Z',
            source: 'wrangler',
            strategy: 'percentage',
            versions: [{ version_id: 'version-current', percentage: 100 }],
          })
        : '',
      stderr: 'credential-bearing diagnostic',
      options,
    }));
    const client = createProductionCloudflareClient({ ...input(), spawn });
    expect(client).toMatchObject({
      environment: 'production',
      target: 'bugdrop',
      wranglerVersion: '4.151.1',
    });
    expect(client.inspectStatus()).toEqual({
      status: 'succeeded',
      value: expect.objectContaining({ versionId: 'version-current' }),
    });
    expect(client.deploy()).toEqual({ status: 'succeeded' });
    for (const [, args, options] of spawn.mock.calls) {
      expect(args).toContain('production');
      expect(args).not.toContain('--name');
      expect(options).toMatchObject({
        shell: false,
        env: {
          PATH: '/trusted/bin',
          CLOUDFLARE_ACCOUNT_ID: 'account_12345678',
          CLOUDFLARE_API_TOKEN: 'token_1234567890123456',
        },
      });
    }
    expect(JSON.stringify(client.inspectStatus())).not.toContain('token_');
  });

  it('strips GitHub and notification credentials from every Wrangler child', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const cloudflare = createProductionCloudflareClient({
      ...input({
        baseEnv: {
          PATH: '/trusted/bin',
          BUGDROP_GITHUB_TOKEN: 'github_secret_123456',
          DISCORD_RELEASE_WEBHOOK_URL: 'discord_secret_123456',
          GITHUB_TOKEN: 'implicit_secret_123456',
        },
      }),
      spawn,
    });
    cloudflare.deploy();
    const childEnv = spawn.mock.calls[0][2].env;
    expect(childEnv).toMatchObject({
      PATH: '/trusted/bin',
      CLOUDFLARE_ACCOUNT_ID: 'account_12345678',
      CLOUDFLARE_API_TOKEN: 'token_1234567890123456',
    });
    expect(childEnv).not.toHaveProperty('BUGDROP_GITHUB_TOKEN');
    expect(childEnv).not.toHaveProperty('DISCORD_RELEASE_WEBHOOK_URL');
    expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('normalizes version inspection and mutation command status', () => {
    const spawn = vi.fn((_executable, args: string[]) => ({
      status: 0,
      stdout: args.includes('view')
        ? JSON.stringify({
            id: 'version-current',
            metadata: { created_on: '2026-08-03T12:00:00Z', source: 'wrangler' },
            resources: {
              bindings: [
                { name: 'ASSETS', type: 'assets' },
                { name: 'BUILD_SHA', type: 'plain_text', text: SHA },
              ],
              script: { etag: 'etag-current' },
              script_runtime: {
                assets: { raw_run_worker_first: true, serve_directly: false },
              },
            },
          })
        : '',
      stderr: '',
    }));
    const client = createProductionCloudflareClient({ ...input(), spawn });
    expect(client.inspectVersion('version-current')).toMatchObject({
      status: 'succeeded',
      value: { versionId: 'version-current', buildSha: SHA },
    });
    expect(client.rollback('version-current', 'restore exact baseline')).toEqual({
      status: 'succeeded',
    });
  });

  it.each([
    ['missing token', { apiToken: '' }],
    ['missing account', { accountId: '' }],
  ])('rejects %s', (_name, change) => {
    expect(() => createProductionCloudflareClient(input(change))).toThrow(CloudflareClientError);
  });

  it('rejects a caller-selected target even when caller values agree', () => {
    expect(() =>
      createProductionCloudflareClient(
        input({
          expectedTarget: 'other',
          controllerConfigBytes: Buffer.from('[env.production]\nname="other"'),
        })
      )
    ).toThrow('TARGET_MISMATCH');
  });

  it('overrides a caller-selected environment with production', () => {
    expect(createProductionCloudflareClient(input({ environment: 'preview' })).environment).toBe(
      'production'
    );
  });

  it('uses the same locked client boundary for the preview capability target', () => {
    const client = createPreviewCloudflareClient(
      input({ controllerConfigBytes: Buffer.from('[env.preview]\nname="bugdrop-preview"\n') })
    );
    expect(client).toMatchObject({ environment: 'preview', target: 'bugdrop-preview' });
  });
});
