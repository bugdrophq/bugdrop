import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/routes/api';
import { createBugDropAuthTokenForTest } from '../src/lib/authToken';
import type { Env } from '../src/types';

const github = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  getInstallationAccess: vi.fn(),
  createIssue: vi.fn(),
  uploadScreenshotAsAsset: vi.fn(),
  uploadAttachmentAsAsset: vi.fn(),
  isRepoPublic: vi.fn(),
}));
vi.mock('../src/lib/github', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/github')>()),
  ...github,
}));

const env: Env = {
  GITHUB_APP_ID: 'test-app',
  GITHUB_PRIVATE_KEY: 'test-key',
  ENVIRONMENT: 'test',
  ALLOWED_ORIGINS: '*',
  GITHUB_APP_NAME: 'test-app',
  MAX_SCREENSHOT_SIZE_MB: '5',
  ASSETS: {} as Fetcher,
};
const metadata = {
  url: 'https://example.test/report',
  userAgent: 'test',
  viewport: { width: 1024, height: 768 },
  timestamp: '2026-09-10T12:00:00Z',
};
const legacy = {
  repo: 'testowner/testrepo',
  title: 'A report',
  metadata,
  screenshot:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  attachments: [
    {
      name: 'report.pdf',
      type: 'application/pdf',
      size: 8,
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=',
    },
  ],
};
const structured = {
  kind: 'bugdrop.variant-submission',
  schemaVersion: 1,
  repo: 'testowner/testrepo',
  variantId: 'report',
  submissionId: 'policy-report-1',
  issue: {
    title: 'A report',
    classification: 'bug',
    sections: [{ heading: 'Problem', value: 'Broken' }],
  },
  metadata,
};
const secret = 'repository-policy-test-secret-at-least-32-bytes';
function submit(payload: unknown, bindings: Env, token?: string) {
  return api.request(
    'http://bugdrop.localhost/feedback',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    },
    bindings
  );
}
function expectNoGitHub() {
  for (const call of Object.values(github)) expect(call).not.toHaveBeenCalled();
}
async function signedToken(repo: string) {
  const now = Math.floor(Date.now() / 1000);
  return createBugDropAuthTokenForTest(
    { sub: 'tester', repo, iat: now, exp: now + 300, jti: 'policy-test' },
    secret
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  github.getInstallationToken.mockResolvedValue('token');
  github.getInstallationAccess.mockResolvedValue({ token: 'token', installationId: 123 });
  github.createIssue.mockResolvedValue({
    number: 42,
    html_url: 'https://github.com/testowner/testrepo/issues/42',
  });
  github.isRepoPublic.mockResolvedValue(true);
  github.uploadScreenshotAsAsset.mockResolvedValue('https://example.test/screenshot.png');
  github.uploadAttachmentAsAsset.mockResolvedValue('https://example.test/report.pdf');
});

describe('repository policy installation checks', () => {
  it.each([undefined, 'true'])('denies before GitHub or check auth (%s)', async required => {
    const response = await api.request(
      'http://bugdrop.localhost/check/blocked/repo',
      {},
      {
        ...env,
        ALLOWED_REPOSITORIES: 'approved/repo',
        AUTH_TOKEN_SECRET: secret,
        AUTH_TOKEN_REQUIRED_FOR_CHECK: required,
      }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
    expectNoGitHub();
  });
  it.each([undefined, '', ' \n ', '*', ' TESTOWNER/TESTREPO '])(
    'allows compatible setting %j',
    async config => {
      const response = await api.request(
        'http://bugdrop.localhost/check/testowner/testrepo',
        {},
        { ...env, ALLOWED_REPOSITORIES: config }
      );
      expect(response.status).toBe(200);
      expect(github.getInstallationToken).toHaveBeenCalledWith(
        expect.anything(),
        'testowner',
        'testrepo'
      );
    }
  );
  it('retains auth for an allowed installation check', async () => {
    const response = await api.request(
      'http://bugdrop.localhost/check/testowner/testrepo',
      {},
      {
        ...env,
        ALLOWED_REPOSITORIES: 'testowner/testrepo',
        AUTH_TOKEN_SECRET: secret,
        AUTH_TOKEN_REQUIRED_FOR_CHECK: 'true',
      }
    );
    expect(response.status).toBe(401);
    expectNoGitHub();
  });
});

for (const [format, payload] of Object.entries({ legacy, structured })) {
  describe(`${format} repository policy`, () => {
    it('denies before all GitHub operations', async () => {
      const response = await submit(payload, { ...env, ALLOWED_REPOSITORIES: 'approved/repo' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
      expectNoGitHub();
    });
    it.each([undefined, '', ' \n ', '*', ' TESTOWNER/TESTREPO '])(
      'allows compatible setting %j',
      async config => {
        const response = await submit(payload, { ...env, ALLOWED_REPOSITORIES: config });
        expect(response.status).toBe(200);
        expect(github.getInstallationAccess).toHaveBeenCalledWith(
          expect.anything(),
          'testowner',
          'testrepo'
        );
        expect(github.createIssue).toHaveBeenCalledOnce();
      }
    );
    it.each([
      ['valid', '0', 403, true],
      ['missing', '0', 401, false],
      ['invalid', '0', 401, false],
      ['valid', '50', 429, false],
    ] as const)(
      'production auth %s, repo quota %s yields %i',
      async (auth, count, status, repoWritten) => {
        const kv = {
          get: vi.fn(async (key: string) => (key.startsWith('repo:') ? count : '0')),
          put: vi.fn().mockResolvedValue(undefined),
        };
        const token =
          auth === 'valid'
            ? await signedToken(payload.repo)
            : auth === 'invalid'
              ? 'invalid-token'
              : undefined;
        const response = await submit(
          payload,
          {
            ...env,
            ENVIRONMENT: 'production',
            ALLOWED_REPOSITORIES: 'approved/repo',
            AUTH_TOKEN_SECRET: secret,
            RATE_LIMIT: kv as unknown as KVNamespace,
          },
          token
        );
        expect(response.status).toBe(status);
        if (status === 403)
          expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
        expect(kv.put.mock.calls.some(([key]) => key.startsWith('repo:'))).toBe(repoWritten);
        expectNoGitHub();
      }
    );
    it('allows an authenticated target without changing token claim spelling', async () => {
      const response = await submit(
        payload,
        {
          ...env,
          ALLOWED_REPOSITORIES: 'TESTOWNER/TESTREPO',
          AUTH_TOKEN_SECRET: secret,
        },
        await signedToken(payload.repo)
      );
      expect(response.status).toBe(200);
      expect(github.createIssue).toHaveBeenCalledOnce();
    });
    it('preserves malformed repo validation', async () => {
      const response = await submit(
        { ...payload, repo: 'invalidformat' },
        { ...env, ALLOWED_REPOSITORIES: 'approved/repo' }
      );
      expect(response.status).toBe(400);
      expectNoGitHub();
    });
  });
}

describe('legacy repository format', () => {
  it('rejects an allowlisted repository with extra path segments before GitHub access', async () => {
    const malformedRepo = 'testowner/testrepo/extra';
    const response = await submit(
      { ...legacy, repo: malformedRepo },
      { ...env, ALLOWED_REPOSITORIES: malformedRepo }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid repo format. Expected: owner/repo' });
    expectNoGitHub();
  });
});
