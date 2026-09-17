import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubUninstall } from '../../src/managed/github-staging/webhook';
import { config, installation } from './github-staging-fixtures';

const secret = 'synthetic-staging-webhook-secret-32-bytes';
function signed(body: unknown = { action: 'deleted', installation }, event = 'installation') {
  const raw = JSON.stringify(body);
  return new Request('https://staging.example/github/staging/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
  });
}
describe('signed staging uninstall authority', () => {
  it('verifies exact bytes and matching installation identity', async () => {
    expect(await verifyGitHubUninstall(signed(), config, secret)).toBe(true);
  });
  it('still revokes after permissions, selection, or suspension changed', async () => {
    expect(
      await verifyGitHubUninstall(
        signed({
          action: 'deleted',
          installation: {
            ...installation,
            permissions: {},
            repository_selection: 'all',
            suspended_at: 'now',
          },
        }),
        config,
        secret
      )
    ).toBe(true);
  });
  it.each(['installation', 'app', 'account', 'action', 'event', 'signature', 'body'])(
    'rejects %s substitution',
    async target => {
      const value = structuredClone(installation);
      if (target === 'installation') value.id++;
      if (target === 'app') value.app_id++;
      if (target === 'account') value.account.id++;
      let req = signed(
        { action: target === 'action' ? 'created' : 'deleted', installation: value },
        target === 'event' ? 'push' : 'installation'
      );
      if (target === 'signature')
        req.headers.set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`);
      if (target === 'body') req = new Request(req, { body: `${await req.text()} ` });
      expect(await verifyGitHubUninstall(req, config, secret)).toBe(false);
    }
  );
  it('fails closed without staging approval or a strong configured secret', async () => {
    expect(await verifyGitHubUninstall(signed(), { ...config, enabled: false }, secret)).toBe(
      false
    );
    expect(await verifyGitHubUninstall(signed(), config, '')).toBe(false);
  });
});
