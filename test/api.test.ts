import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, FeedbackPayload } from '../src/types';
import { createBugDropAuthTokenForTest } from '../src/lib/authToken';

// Mock GitHub API functions
const mockGetInstallationToken = vi.fn();
const mockCreateIssue = vi.fn();
const mockUploadScreenshotAsAsset = vi.fn();
const mockUploadAttachmentAsAsset = vi.fn();
const mockIsRepoPublic = vi.fn();

class TestGitHubLabelError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'GitHubLabelError';
    this.status = status;
  }
}

vi.mock('../src/lib/github', () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
  getInstallationAccess: async (...args: unknown[]) => {
    const token = await mockGetInstallationToken(...args);
    return token ? { token, installationId: 123456 } : null;
  },
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  uploadScreenshotAsAsset: (...args: unknown[]) => mockUploadScreenshotAsAsset(...args),
  uploadAttachmentAsAsset: (...args: unknown[]) => mockUploadAttachmentAsAsset(...args),
  isRepoPublic: (...args: unknown[]) => mockIsRepoPublic(...args),
  GitHubLabelError: TestGitHubLabelError,
}));

// Import API routes after mocking
const createApiRoutes = async () => {
  const { default: api } = await import('../src/routes/api');
  return api;
};

const legacyFixtureRoot = new URL('./fixtures/legacy-compat/', import.meta.url);
const legacyPayloads = JSON.parse(
  readFileSync(new URL('legacy-payload.json', legacyFixtureRoot), 'utf8')
) as {
  screenshotFree: FeedbackPayload;
  evidenceBearing: FeedbackPayload;
};
const legacyResponse = JSON.parse(
  readFileSync(new URL('legacy-response.json', legacyFixtureRoot), 'utf8')
) as Record<string, unknown>;
const legacyIssueBody = readFileSync(
  new URL('legacy-issue.md', legacyFixtureRoot),
  'utf8'
).trimEnd();

describe('API Routes', () => {
  const validPngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  let app: Hono;
  const mockEnv: Env = {
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_PRIVATE_KEY: 'test-private-key',
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: '*',
    GITHUB_APP_NAME: 'test-bugdrop-app',
    MAX_SCREENSHOT_SIZE_MB: '5',
    ASSETS: {} as Fetcher,
  };

  beforeEach(async () => {
    mockGetInstallationToken.mockReset();
    mockCreateIssue.mockReset();
    mockUploadScreenshotAsAsset.mockReset();
    mockUploadAttachmentAsAsset.mockReset();
    mockIsRepoPublic.mockReset();
    // Set default mock return values
    mockGetInstallationToken.mockResolvedValue('test-token');
    mockCreateIssue.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/testowner/testrepo/issues/42',
    });
    mockIsRepoPublic.mockResolvedValue(true);
    app = await createApiRoutes();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('GET /health', () => {
    it('should return status ok', async () => {
      const req = new Request('http://localhost/health');
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toMatchObject({
        status: 'ok',
        environment: 'test',
        capabilities: { appVersionMetadata: true },
      });
      expect(data.timestamp).toBeDefined();
    });

    it('should include CORS headers', async () => {
      const req = new Request('http://localhost/health');
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('should return timestamp in ISO format', async () => {
      const req = new Request('http://localhost/health');
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should expose the configured Worker build SHA', async () => {
      const buildSha = 'a'.repeat(40);
      const req = new Request('http://localhost/health');
      const res = await app.fetch(req, { ...mockEnv, BUILD_SHA: buildSha });
      const data = await res.json();

      expect(data.buildSha).toBe(buildSha);
    });

    it('should omit Worker build identity when BUILD_SHA is unconfigured or blank', async () => {
      for (const buildSha of [undefined, '', '   ']) {
        const req = new Request('http://localhost/health');
        const res = await app.fetch(req, { ...mockEnv, BUILD_SHA: buildSha });
        const data = await res.json();

        expect(data).not.toHaveProperty('buildSha');
      }
    });
  });

  describe('GET /stats/feedback-issues', () => {
    it('returns only the rounded public count with daily shared caching', async () => {
      const put = vi.fn().mockResolvedValue(undefined);
      const match = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('caches', { default: { match, put } });
      const req = new Request('http://localhost/stats/feedback-issues?nonce=ignored', {
        headers: { Origin: 'https://first.example' },
      });
      const res = await app.fetch(req, { ...mockEnv, FEEDBACK_COUNT_BASELINE: '3116' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        feedbackIssuesCreated: 3100,
        display: '3,100+',
      });
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');
      expect(match).toHaveBeenCalledOnce();
      expect(put).toHaveBeenCalledOnce();
      expect((match.mock.calls[0][0] as Request).url).toBe(
        'http://localhost/stats/feedback-issues'
      );
      const storedResponse = put.mock.calls[0][1] as Response;
      expect(storedResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();

      const cachedResponse = Response.json(
        {
          feedbackIssuesCreated: 3100,
          display: '3,100+',
        },
        {
          headers: { 'Access-Control-Allow-Origin': 'https://first.example' },
        }
      );
      match.mockResolvedValueOnce(cachedResponse);
      const cached = await app.fetch(
        new Request('http://localhost/stats/feedback-issues?another=ignored', {
          headers: { Origin: 'https://second.example' },
        }),
        mockEnv
      );
      expect(await cached.json()).toEqual({
        feedbackIssuesCreated: 3100,
        display: '3,100+',
      });
      expect(cached.headers.get('Access-Control-Allow-Origin')).toBe('https://second.example');
      expect(put).toHaveBeenCalledOnce();
    });

    it('fails closed without exposing a synthetic count when unconfigured', async () => {
      const req = new Request('http://localhost/stats/feedback-issues');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Feedback count unavailable' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('GET /check/:owner/:repo', () => {
    it('should return installed: true when app is installed', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');

      const req = new Request('http://localhost/check/testowner/testrepo');
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({
        installed: true,
        repo: 'testowner/testrepo',
        appName: 'test-bugdrop-app',
        maxScreenshotSizeBytes: 5 * 1024 * 1024,
      });
      expect(mockGetInstallationToken).toHaveBeenCalledWith(mockEnv, 'testowner', 'testrepo');
    });

    it('should return installed: false when app is not installed', async () => {
      mockGetInstallationToken.mockResolvedValue(null);

      const req = new Request('http://localhost/check/testowner/testrepo');
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({
        installed: false,
        repo: 'testowner/testrepo',
        appName: 'test-bugdrop-app',
        maxScreenshotSizeBytes: 5 * 1024 * 1024,
      });
    });

    it('should omit appName when GITHUB_APP_NAME is not set', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');

      const envWithoutAppName = { ...mockEnv, GITHUB_APP_NAME: '' };
      const req = new Request('http://localhost/check/testowner/testrepo');
      const res = await app.fetch(req, envWithoutAppName);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({
        installed: true,
        repo: 'testowner/testrepo',
        maxScreenshotSizeBytes: 5 * 1024 * 1024,
      });
      expect(data).not.toHaveProperty('appName');
    });

    it('should include CORS headers', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');

      const req = new Request('http://localhost/check/testowner/testrepo');
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('should reject tokenless check requests when check auth is required', async () => {
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'test-secret-with-at-least-32-bytes-for-hmac',
        AUTH_TOKEN_REQUIRED_FOR_CHECK: 'true',
      };
      const req = new Request('http://localhost/check/testowner/testrepo');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data).toEqual({ error: 'BugDrop auth token required' });
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
    });

    it('should accept check tokens signed by an additional configured secret', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'primary-secret-with-at-least-32-bytes',
        AUTH_TOKEN_ADDITIONAL_SECRETS: 'deckchecker-secret-with-at-least-32-bytes',
        AUTH_TOKEN_REQUIRED_FOR_CHECK: 'true',
      };
      const now = Math.floor(Date.now() / 1000);
      const token = await createBugDropAuthTokenForTest(
        {
          sub: 'user-123',
          repo: 'testowner/testrepo',
          iat: now,
          exp: now + 300,
          jti: 'jti-123',
        },
        'deckchecker-secret-with-at-least-32-bytes'
      );

      const req = new Request('http://localhost/check/testowner/testrepo', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toMatchObject({
        installed: true,
        repo: 'testowner/testrepo',
      });
      expect(mockGetInstallationToken).toHaveBeenCalledWith(env, 'testowner', 'testrepo');
    });

    it('should handle special characters in repo names', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');

      const req = new Request('http://localhost/check/test-owner/test.repo-name');
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(data.repo).toBe('test-owner/test.repo-name');
    });
  });

  describe('POST /feedback', () => {
    const validPayload: FeedbackPayload = {
      repo: 'testowner/testrepo',
      title: 'Test feedback',
      description: 'This is a test feedback',
      metadata: {
        url: 'http://localhost:3000',
        userAgent: 'Mozilla/5.0',
        viewport: { width: 1920, height: 1080 },
        timestamp: '2025-01-15T12:00:00Z',
      },
    };

    it('preserves the frozen screenshot-free legacy request and response contract', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyPayloads.screenshotFree),
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(legacyResponse);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        legacyPayloads.screenshotFree.title,
        expect.stringContaining(legacyPayloads.screenshotFree.description),
        ['enhancement', 'bugdrop']
      );
      expect(mockUploadScreenshotAsAsset).not.toHaveBeenCalled();
      expect(mockUploadAttachmentAsAsset).not.toHaveBeenCalled();
    });

    it('preserves the frozen evidence-bearing Issue body and GitHub arguments', async () => {
      mockUploadScreenshotAsAsset.mockResolvedValue('https://assets.test/screenshot.png');
      mockUploadAttachmentAsAsset.mockResolvedValue('https://assets.test/evidence.pdf');
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyPayloads.evidenceBearing),
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(legacyResponse);
      expect(mockUploadScreenshotAsAsset).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        legacyPayloads.evidenceBearing.screenshot
      );
      expect(mockUploadAttachmentAsAsset).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        legacyPayloads.evidenceBearing.attachments?.[0]
      );
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        legacyPayloads.evidenceBearing.title,
        legacyIssueBody,
        ['bug', 'bugdrop']
      );
    });

    it('does not treat an unrelated top-level schemaVersion as a variant discriminator', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...legacyPayloads.screenshotFree, schemaVersion: 2 }),
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(legacyResponse);
      expect(mockCreateIssue).toHaveBeenCalledOnce();
    });

    it('should create issue with valid payload', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({
        success: true,
        issueNumber: 42,
        issueUrl: 'https://github.com/testowner/testrepo/issues/42',
        isPublic: true,
      });
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.stringContaining('This is a test feedback'),
        ['bug', 'bugdrop']
      );
    });

    it('queues one anonymous counter increment only after GitHub creates the Issue', async () => {
      const counterFetch = vi.fn().mockResolvedValue(Response.json({ total: 3117 }));
      const counterId = {} as DurableObjectId;
      const waitUntil = vi.fn();
      const env = {
        ...mockEnv,
        FEEDBACK_COUNTER: {
          idFromName: vi.fn().mockReturnValue(counterId),
          get: vi.fn().mockReturnValue({ fetch: counterFetch }),
        } as unknown as DurableObjectNamespace,
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, env, { waitUntil } as unknown as ExecutionContext);

      expect(res.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledOnce();
      await (waitUntil.mock.calls[0][0] as Promise<void>);
      expect(counterFetch).toHaveBeenCalledOnce();
      expect(counterFetch).toHaveBeenCalledWith(
        'https://feedback-counter/increment',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringMatching(/"eventId":"[0-9a-f-]{36}"/i),
        })
      );
    });

    it('does not count feedback when GitHub Issue creation fails', async () => {
      mockCreateIssue.mockRejectedValueOnce(new Error('GitHub unavailable'));
      const counterFetch = vi.fn();
      const counterId = {} as DurableObjectId;
      const waitUntil = vi.fn();
      const env = {
        ...mockEnv,
        FEEDBACK_COUNTER: {
          idFromName: vi.fn().mockReturnValue(counterId),
          get: vi.fn().mockReturnValue({ fetch: counterFetch }),
        } as unknown as DurableObjectNamespace,
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, env, { waitUntil } as unknown as ExecutionContext);

      expect(res.status).toBe(500);
      expect(counterFetch).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it('does not count a malformed GitHub success response', async () => {
      mockCreateIssue.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/another/repo/issues/42',
      });
      const counterFetch = vi.fn();
      const waitUntil = vi.fn();
      const env = {
        ...mockEnv,
        FEEDBACK_COUNTER: {
          idFromName: vi.fn().mockReturnValue({} as DurableObjectId),
          get: vi.fn().mockReturnValue({ fetch: counterFetch }),
        } as unknown as DurableObjectNamespace,
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, env, { waitUntil } as unknown as ExecutionContext);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'GitHub returned an invalid Issue result',
        code: 'ISSUE_CREATION_FAILED',
      });
      expect(counterFetch).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it('should expose the configured Worker build SHA on successful feedback', async () => {
      const buildSha = 'a'.repeat(40);
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, { ...mockEnv, BUILD_SHA: buildSha });

      expect(res.status).toBe(200);
      expect(res.headers.get('X-BugDrop-Build-SHA')).toBe(buildSha);
    });

    it.each([
      ['invalid JSON', '{'],
      ['validation error', JSON.stringify({ ...validPayload, title: '' })],
    ])('should expose the configured Worker build SHA on %s', async (_name, body) => {
      const buildSha = 'b'.repeat(40);
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const res = await app.fetch(req, { ...mockEnv, BUILD_SHA: buildSha });

      expect(res.status).toBe(400);
      expect(res.headers.get('X-BugDrop-Build-SHA')).toBe(buildSha);
    });

    it('should expose the configured Worker build SHA on GitHub failures', async () => {
      const buildSha = 'c'.repeat(40);
      mockCreateIssue.mockRejectedValueOnce(new Error('GitHub unavailable'));
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, { ...mockEnv, BUILD_SHA: buildSha });

      expect(res.status).toBe(500);
      expect(res.headers.get('X-BugDrop-Build-SHA')).toBe(buildSha);
    });

    it('should omit Worker build identity when BUILD_SHA is unconfigured', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(res.headers.has('X-BugDrop-Build-SHA')).toBe(false);
    });

    it('should reject feedback without a bearer token when token auth is configured', async () => {
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'test-secret-with-at-least-32-bytes-for-hmac',
        AUTH_TOKEN_AUDIENCE: 'bugdrop.example.workers.dev',
        AUTH_TOKEN_ISSUER: 'app.example.com',
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.com' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data).toEqual({ error: 'BugDrop auth token required', code: 'AUTH_REQUIRED' });
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('should reject tokenless feedback before consuming repository rate limits', async () => {
      const rateLimit = {
        get: vi.fn().mockResolvedValue('0'),
        put: vi.fn().mockResolvedValue(undefined),
      };
      const env = {
        ...mockEnv,
        ENVIRONMENT: 'production',
        AUTH_TOKEN_SECRET: 'test-secret-with-at-least-32-bytes-for-hmac',
        RATE_LIMIT: rateLimit as unknown as KVNamespace,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(401);
      expect(rateLimit.put).toHaveBeenCalledWith(
        expect.stringMatching(/^ip:203\.0\.113\.10:/),
        '1',
        expect.any(Object)
      );
      expect(rateLimit.put).not.toHaveBeenCalledWith(
        expect.stringMatching(/^repo:testowner\/testrepo:/),
        expect.any(String),
        expect.any(Object)
      );
    });

    it('should parse protected feedback payload only once for successful requests', async () => {
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'test-secret-with-at-least-32-bytes-for-hmac',
        AUTH_TOKEN_AUDIENCE: 'bugdrop.example.workers.dev',
        AUTH_TOKEN_ISSUER: 'app.example.com',
      };
      const now = Math.floor(Date.now() / 1000);
      const token = await createBugDropAuthTokenForTest(
        {
          iss: 'app.example.com',
          aud: 'bugdrop.example.workers.dev',
          sub: 'user-123',
          repo: 'testowner/testrepo',
          iat: now,
          exp: now + 300,
          jti: 'jti-123',
        },
        env.AUTH_TOKEN_SECRET
      );
      const request = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(validPayload),
      });
      const jsonSpy = vi.spyOn(request, 'json');

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      expect(jsonSpy).not.toHaveBeenCalled();
    });

    it('should create issue with a valid bearer token when token auth is configured', async () => {
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'test-secret-with-at-least-32-bytes-for-hmac',
        AUTH_TOKEN_AUDIENCE: 'bugdrop.example.workers.dev',
        AUTH_TOKEN_ISSUER: 'app.example.com',
      };
      const now = Math.floor(Date.now() / 1000);
      const token = await createBugDropAuthTokenForTest(
        {
          iss: 'app.example.com',
          aud: 'bugdrop.example.workers.dev',
          sub: 'user-123',
          repo: 'testowner/testrepo',
          iat: now,
          exp: now + 300,
          jti: 'jti-123',
        },
        env.AUTH_TOKEN_SECRET
      );

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: 'https://app.example.com',
        },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toMatchObject({
        success: true,
        issueNumber: 42,
      });
      expect(mockCreateIssue).toHaveBeenCalledOnce();
    });

    it('should create issue with a bearer token signed by an additional configured secret', async () => {
      const env = {
        ...mockEnv,
        AUTH_TOKEN_SECRET: 'primary-secret-with-at-least-32-bytes',
        AUTH_TOKEN_ADDITIONAL_SECRETS:
          'other-rotating-secret-with-at-least-32-bytes, deckchecker-secret-with-at-least-32-bytes',
        AUTH_TOKEN_AUDIENCE: 'bugdrop.example.workers.dev',
        AUTH_TOKEN_ISSUER: 'app.example.com',
      };
      const now = Math.floor(Date.now() / 1000);
      const token = await createBugDropAuthTokenForTest(
        {
          iss: 'app.example.com',
          aud: 'bugdrop.example.workers.dev',
          sub: 'user-123',
          repo: 'testowner/testrepo',
          iat: now,
          exp: now + 300,
          jti: 'jti-123',
        },
        'deckchecker-secret-with-at-least-32-bytes'
      );

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toMatchObject({
        success: true,
        issueNumber: 42,
      });
      expect(mockCreateIssue).toHaveBeenCalledOnce();
    });

    it('should ignore client-provided category labels unless explicitly enabled', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payload = {
        ...validPayload,
        category: 'bug' as const,
        categoryLabels: {
          bug: 'security',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['bug', 'bugdrop']
      );
    });

    it('should create issue with server-configured category label string mapping', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          feature: 'product-feedback',
        }),
      };
      const payload = {
        ...validPayload,
        category: 'feature' as const,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, envWithLabels);

      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['product-feedback', 'bugdrop']
      );
    });

    it('should create issue with server-configured category label array mapping', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: ['defect', 'frontend', 'defect'],
        }),
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, envWithLabels);

      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['defect', 'frontend', 'bugdrop']
      );
    });

    it('should keep default labels for categories omitted from server mapping', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: 'defect',
        }),
      };
      const payload = {
        ...validPayload,
        category: 'question' as const,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await app.fetch(req, envWithLabels);

      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['question', 'bugdrop']
      );
    });

    it('should fallback to default labels and include issue warning for invalid server mapping', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: '',
        }),
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await app.fetch(req, envWithLabels);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('## Label mapping warning');
      expect(issueBody).toContain('Invalid labels for category "bug"');
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['bug', 'bugdrop']
      );
    });

    it('should warn on unknown server mapping keys', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: 'defect',
          features: 'product-feedback',
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'feature' }),
      });
      await app.fetch(req, envWithLabels);

      expect(mockCreateIssue.mock.calls[0][4]).toContain('Unknown category label mapping key');
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['enhancement', 'bugdrop']);
    });

    it('should retry with default labels and issue warning when GitHub rejects configured labels', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue
        .mockRejectedValueOnce(new TestGitHubLabelError('GitHub rejected labels'))
        .mockResolvedValueOnce({
          number: 42,
          html_url: 'https://github.com/testowner/testrepo/issues/42',
        });

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          feature: 'bad-label',
        }),
      };
      const payload = {
        ...validPayload,
        category: 'feature' as const,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, envWithLabels);

      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bad-label', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[1][5]).toEqual(['enhancement', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[1][4]).toContain('## Label mapping warning');
      expect(mockCreateIssue.mock.calls[1][4]).toContain('GitHub rejected the configured labels');
    });

    it('should surface a distinctive error when both configured and default labels fail', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue
        .mockRejectedValueOnce(new TestGitHubLabelError('GitHub rejected configured labels'))
        .mockRejectedValueOnce(new Error('rate limit exceeded on retry'));

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ feature: 'bad-label' }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'feature' }),
      });
      const res = await app.fetch(req, envWithLabels);
      const data = (await res.json()) as { error: string };

      expect(res.status).toBe(500);
      expect(data.error).toContain('configured labels');
      expect(data.error).toContain('default labels');
      expect(data.error).toContain('rate limit exceeded on retry');
      expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-label GitHub validation errors', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockRejectedValue(new Error('422 Validation Failed: title is invalid'));

      const envWithLabels = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          feature: 'product-feedback',
        }),
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'feature' }),
      });
      const res = await app.fetch(req, envWithLabels);

      expect(res.status).toBe(500);
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    });

    it('should honor client-provided category labels when ALLOW_CLIENT_CATEGORY_LABELS=true', async () => {
      const envWithOptIn = {
        ...mockEnv,
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
        categoryLabels: { bug: 'security' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, envWithOptIn);

      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.any(String),
        ['security', 'bugdrop']
      );
    });

    it('should validate client category labels shape when opt-in is enabled', async () => {
      const envWithOptIn = {
        ...mockEnv,
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
        // Array, not an object — must be rejected with a warning, defaults used.
        categoryLabels: ['security'] as unknown as Record<string, string>,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, envWithOptIn);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('## Label mapping warning');
      expect(mockCreateIssue.mock.calls[0][4]).toContain('expected an object');
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
    });

    it.each(['TRUE', 'True', '1', 'yes', ' true ', ''])(
      'should reject ALLOW_CLIENT_CATEGORY_LABELS=%j (only the literal "true" opens the gate)',
      async value => {
        const envWithLooseFlag = {
          ...mockEnv,
          ALLOW_CLIENT_CATEGORY_LABELS: value,
        };
        const payload = {
          ...validPayload,
          category: 'bug' as const,
          categoryLabels: { bug: 'security' },
        };

        const req = new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const res = await app.fetch(req, envWithLooseFlag);

        expect(res.status).toBe(200);
        expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      }
    );

    it('should prefer CATEGORY_LABELS over client categoryLabels even when ALLOW_CLIENT_CATEGORY_LABELS=true', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: 'server-defect' }),
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
        categoryLabels: { bug: 'client-injected' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['server-defect', 'bugdrop']);
    });

    it('should fail closed (use defaults, not client labels) when CATEGORY_LABELS is malformed JSON', async () => {
      // Self-hoster typo in env JSON must NOT silently delegate to the browser
      // even when ALLOW_CLIENT_CATEGORY_LABELS=true. Otherwise, a single typo
      // subverts the entire server-authoritative model.
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: '{"bug":"defect"', // missing closing brace
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
        categoryLabels: { bug: 'client-injected' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('malformed JSON');
    });

    it('should fail closed when CATEGORY_LABELS is valid JSON but not an object', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: '["bug","feature"]',
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'bug' as const,
        categoryLabels: { bug: 'client-injected' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('expected a JSON object');
    });

    it('should select labels from a per-repo CATEGORY_LABELS map', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          'testowner/testrepo': { feature: 'product-feedback' },
          'other/repo': { feature: 'wrong-feedback' },
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'feature' }),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['product-feedback', 'bugdrop']);
    });

    it('should fall back to "*" entry when repo is not in per-repo CATEGORY_LABELS map', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          'other/repo': { feature: 'specific' },
          '*': { feature: 'wildcard' },
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'feature' }),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['wildcard', 'bugdrop']);
    });

    it('should include labelMappingWarnings in the success response when warnings are present', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: 'defect',
          features: 'product-feedback', // typo — unknown key
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'bug' }),
      });
      const res = await app.fetch(req, env);
      const data = (await res.json()) as { labelMappingWarnings?: string[] };

      expect(res.status).toBe(200);
      expect(data.labelMappingWarnings).toBeDefined();
      expect(data.labelMappingWarnings?.[0]).toMatch(/Unknown category label mapping key/);
    });

    it('should omit labelMappingWarnings from the success response when there are none', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(data).not.toHaveProperty('labelMappingWarnings');
    });

    it('should warn and fall back to defaults when CATEGORY_LABELS array contains a non-string', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: ['ok', 123] }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('all labels must be strings');
    });

    it('should reject CATEGORY_LABELS arrays exceeding 5 labels', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: ['a', 'b', 'c', 'd', 'e', 'f'],
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('expected 1-5 labels');
    });

    it('should accept exactly 5 labels (boundary)', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: ['a', 'b', 'c', 'd', 'e'],
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['a', 'b', 'c', 'd', 'e', 'bugdrop']);
    });

    it('should reject CATEGORY_LABELS labels longer than 50 characters (GitHub limit)', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: 'x'.repeat(51),
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('1-50 characters');
    });

    it('should accept exactly 50-character labels (boundary)', async () => {
      const exactly50 = 'x'.repeat(50);
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: exactly50 }),
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual([exactly50, 'bugdrop']);
    });

    it('should reject labels with embedded newlines (markdown injection guard)', async () => {
      // Without the control-char guard, "foo\n## Compromised" would break out
      // of the inline-code span when rendered into the issue body markdown
      // and inject a heading into the maintainer's tracker.
      const malicious = 'foo\n\n## Compromised\n\n- evil';
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: malicious }),
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('cannot contain control characters');
      // Defensive: confirm the malicious markdown didn't slip through anywhere.
      expect(issueBody).not.toContain('## Compromised');
    });

    it('should reject labels containing NUL byte', async () => {
      const malicious = 'foo' + String.fromCharCode(0) + 'bar';
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: malicious }),
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('cannot contain control characters');
    });

    it('should reject labels containing DEL (0x7f)', async () => {
      const malicious = 'foo' + String.fromCharCode(0x7f) + 'bar';
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({ bug: malicious }),
      };
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['bug', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('cannot contain control characters');
    });

    it('should trim whitespace and reject whitespace-only labels', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          bug: '  defect  ',
          feature: '   ',
        }),
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPayload, category: 'bug' }),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['defect', 'bugdrop']);
      // The whitespace-only feature mapping must produce a length warning.
      expect(mockCreateIssue.mock.calls[0][4]).toContain('1-50 characters');
    });

    it('should ignore __proto__ and constructor keys in CATEGORY_LABELS', async () => {
      // JSON.parse sets __proto__ as an own enumerable property (not the
      // prototype), so Object.keys walks it. isFeedbackCategory then rejects
      // it, producing a warning. Pin this behavior so a future refactor to
      // for...in (which walks the prototype chain) gets caught.
      const env = {
        ...mockEnv,
        CATEGORY_LABELS:
          '{"__proto__":{"bug":"pwn"},"constructor":{"bug":"also-pwn"},"bug":"defect"}',
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['defect', 'bugdrop']);
      expect(({} as Record<string, unknown>).bug).toBeUndefined();
    });

    it('should fail closed with a warning when per-repo CATEGORY_LABELS has no match and no wildcard', async () => {
      const env = {
        ...mockEnv,
        CATEGORY_LABELS: JSON.stringify({
          'other/repo': { feature: 'specific' },
        }),
        ALLOW_CLIENT_CATEGORY_LABELS: 'true',
      };
      const payload = {
        ...validPayload,
        category: 'feature' as const,
        categoryLabels: { feature: 'client-injected' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][5]).toEqual(['enhancement', 'bugdrop']);
      expect(mockCreateIssue.mock.calls[0][4]).toContain('no mapping for');
    });

    it('should return 400 when repo is missing', async () => {
      const invalidPayload = { ...validPayload, repo: undefined };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
      expect(data.code).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('should return 400 when title is missing', async () => {
      const invalidPayload = { ...validPayload, title: undefined };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it.each([123, '', '1.2.3\nforged', 'v'.repeat(129)])(
      'should reject invalid application version metadata: %j',
      async appVersion => {
        const req = new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            metadata: { ...validPayload.metadata, appVersion },
          }),
        });
        const res = await app.fetch(req, mockEnv);
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data.error).toBe('Invalid metadata appVersion');
        expect(data.code).toBe('INVALID_APP_VERSION');
        expect(mockCreateIssue).not.toHaveBeenCalled();
      }
    );

    it('should accept submission when description is missing (optional field)', async () => {
      const payload = { ...validPayload, description: undefined };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should return 400 when repo format is invalid', async () => {
      const invalidPayload = { ...validPayload, repo: 'invalidformat' };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Invalid repo format');
      expect(data.code).toBe('INVALID_REPOSITORY');
    });

    it('should return 400 when JSON is invalid', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json{',
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe('Invalid JSON');
      expect(data.code).toBe('INVALID_JSON');
    });

    it('should return 403 when app is not installed with configurable app name', async () => {
      mockGetInstallationToken.mockResolvedValue(null);

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.error).toContain('not installed');
      expect(data.code).toBe('APP_NOT_INSTALLED');
      expect(data.installUrl).toBe('https://github.com/apps/test-bugdrop-app/installations/new');
    });

    it('keeps an actionable code and English message for a disallowed repository', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, { ...mockEnv, ALLOWED_REPOSITORIES: 'another/repo' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Repository is not allowed',
        code: 'REPOSITORY_NOT_ALLOWED',
      });
    });

    it('should upload screenshot and include URL in issue body', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      const uploadedUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.feedback/screenshots/123456.png';
      mockUploadScreenshotAsAsset.mockResolvedValue(uploadedUrl);
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithScreenshot = {
        ...validPayload,
        screenshot: validPngDataUrl,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithScreenshot),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockUploadScreenshotAsAsset).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        validPngDataUrl
      );
      expect(mockCreateIssue).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        'Test feedback',
        expect.stringContaining(uploadedUrl),
        ['bug', 'bugdrop']
      );
    });

    it('should upload selected files and include attachment links in issue body', async () => {
      const uploadedImageUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.bugdrop/uploads/photo.png';
      const uploadedPdfUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.bugdrop/uploads/notes.pdf';
      mockUploadAttachmentAsAsset
        .mockResolvedValueOnce(uploadedImageUrl)
        .mockResolvedValueOnce(uploadedPdfUrl);

      const payloadWithAttachments = {
        ...validPayload,
        attachments: [
          {
            name: 'photo.png',
            type: 'image/png',
            size: 68,
            dataUrl: validPngDataUrl,
          },
          {
            name: 'notes.pdf',
            type: 'application/pdf',
            size: 12,
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
          },
        ],
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithAttachments),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockUploadAttachmentAsAsset).toHaveBeenCalledTimes(2);
      expect(mockUploadAttachmentAsAsset).toHaveBeenNthCalledWith(
        1,
        'test-token',
        'testowner',
        'testrepo',
        expect.objectContaining({
          name: 'photo.png',
          type: 'image/png',
          dataUrl: validPngDataUrl,
        })
      );
      expect(mockUploadAttachmentAsAsset).toHaveBeenNthCalledWith(
        2,
        'test-token',
        'testowner',
        'testrepo',
        expect.objectContaining({
          name: 'notes.pdf',
          type: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
        })
      );

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('## Attachments');
      expect(issueBody).toContain(`![photo.png](${uploadedImageUrl})`);
      expect(issueBody).toContain(`[notes.pdf](${uploadedPdfUrl})`);
    });

    it('should reject unsupported uploaded file types', async () => {
      const payloadWithUnsupportedAttachment = {
        ...validPayload,
        attachments: [
          {
            name: 'archive.zip',
            type: 'application/zip',
            size: 12,
            dataUrl: 'data:application/zip;base64,UEsDBAo=',
          },
        ],
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithUnsupportedAttachment),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Unsupported file type');
      expect(data.code).toBe('UNSUPPORTED_ATTACHMENT_TYPE');
      expect(mockUploadAttachmentAsAsset).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('should reject uploaded files exceeding the size limit', async () => {
      const payloadWithLargeAttachment = {
        ...validPayload,
        attachments: [
          {
            name: 'large.png',
            type: 'image/png',
            size: 6 * 1024 * 1024,
            dataUrl: validPngDataUrl,
          },
        ],
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithLargeAttachment),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('File is too large');
      expect(data.error).toContain('exceeds 5MB limit');
      expect(data.code).toBe('ATTACHMENT_TOO_LARGE');
      expect(mockUploadAttachmentAsAsset).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('should add a selected-element screenshot caption when an element was chosen', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      const uploadedUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.feedback/screenshots/selected.png';
      mockUploadScreenshotAsAsset.mockResolvedValue(uploadedUrl);
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithSelectedElement = {
        ...validPayload,
        screenshot: validPngDataUrl,
        metadata: {
          ...validPayload.metadata,
          elementSelector: '#book-now',
          selectedElementHighlightColor: '#2563eb',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithSelectedElement),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain(`![Screenshot](${uploadedUrl})`);
      expect(issueBody).toContain(
        '_Selected element is indicated by the rounded highlight border (`#2563eb`)._'
      );
    });

    it('should render markdown-sensitive selected-element highlight metadata as inline code', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      const uploadedUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.feedback/screenshots/selected.png';
      mockUploadScreenshotAsAsset.mockResolvedValue(uploadedUrl);
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithMarkdownHighlight = {
        ...validPayload,
        screenshot: validPngDataUrl,
        metadata: {
          ...validPayload.metadata,
          elementSelector: '#book-now',
          selectedElementHighlightColor: '](https://example.com) ![x](y)',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithMarkdownHighlight),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain(
        '_Selected element is indicated by the rounded highlight border (`](https://example.com) ![x](y)`)._'
      );
    });

    it('should use screenshot when provided (annotations handled client-side)', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      const uploadedUrl =
        'https://raw.githubusercontent.com/testowner/testrepo/main/.feedback/screenshots/789.png';
      mockUploadScreenshotAsAsset.mockResolvedValue(uploadedUrl);
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithScreenshot = {
        ...validPayload,
        screenshot: validPngDataUrl,
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithScreenshot),
      });
      await app.fetch(req, mockEnv);

      expect(mockUploadScreenshotAsAsset).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        validPngDataUrl
      );
    });

    it('should include CORS headers', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('should reject screenshot exceeding size limit', async () => {
      // Create a large base64 string (> 5MB when decoded)
      // 5MB = 5 * 1024 * 1024 bytes, base64 encoding is ~4/3 ratio
      const largeScreenshot = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          screenshot: largeScreenshot,
        }),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Screenshot too large');
      expect(data.code).toBe('SCREENSHOT_TOO_LARGE');
      expect(data.error).toContain('exceeds 5MB limit');
    });

    it('should reject SVG screenshots', async () => {
      const svgScreenshot =
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          screenshot: svgScreenshot,
        }),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Expected a PNG data URL');
      expect(mockUploadScreenshotAsAsset).not.toHaveBeenCalled();
    });

    it('should reject invalid base64 screenshots', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          screenshot: 'data:image/png;base64,not valid base64',
        }),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Expected a PNG data URL');
      expect(mockUploadScreenshotAsAsset).not.toHaveBeenCalled();
    });

    it('should reject PNG data URLs with non-PNG bytes', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          screenshot: 'data:image/png;base64,SGVsbG8=',
        }),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain('Expected PNG image data');
      expect(mockUploadScreenshotAsAsset).not.toHaveBeenCalled();
    });

    it('should return 500 when GitHub API fails', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockRejectedValue(new Error('GitHub API error'));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data).toEqual({ error: 'GitHub API error', code: 'ISSUE_CREATION_FAILED' });
      expect(errorLog).toHaveBeenCalledWith('Error creating feedback:', expect.any(Error));
      errorLog.mockRestore();
    });

    it('should format issue body with metadata', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithSelector = {
        ...validPayload,
        metadata: {
          ...validPayload.metadata,
          appVersion: '  1.2.3 [download](https://attacker.test)<details>|desktop  ',
          elementSelector: '#submit-button',
          fullElementSelector: 'html > body > main > form#contact > button#submit-button',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithSelector),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('## Description');
      expect(issueBody).toContain('This is a test feedback');
      expect(issueBody).toContain('System Info');
      expect(issueBody).toContain(
        '| **App Version** | `1.2.3 [download](https://attacker.test)<details>\\|desktop` |'
      );
      expect(issueBody).toContain('http://localhost:3000');
      expect(issueBody).toContain('1920×1080');
      expect(issueBody).toContain('#submit-button');
      expect(issueBody).toContain(
        '| **Full CSS path** | `html > body > main > form#contact > button#submit-button` |'
      );
      expect(issueBody).toContain('Submitted via');
    });

    it('should include redacted console logs in the issue body when submitted', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithConsoleLogs = {
        ...validPayload,
        consoleLogs: [
          {
            level: 'error',
            message: 'Checkout failed with token=[redacted]',
            sourceUrl: 'https://example.test/app.js?token=abc123456789abcdefghijklmnopqrstuvwxyz',
            lineNumber: 12,
            columnNumber: 4,
            timestamp: '2026-06-08T10:00:00.000Z',
          },
          {
            level: 'warn',
            message: '{"token":"abc123","password":"hunter2","cookie":"sid=short"}',
            timestamp: '2026-06-08T10:00:01.000Z',
          },
        ],
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithConsoleLogs),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('<summary>Console Logs</summary>');
      expect(issueBody).toContain('[error] Checkout failed with token=[redacted]');
      expect(issueBody).toContain('https://example.test/app.js?token=[redacted]:12:4');
      expect(issueBody).toContain(
        '[warn] {"token":"[redacted]","password":"[redacted]","cookie":"[redacted]"}'
      );
      expect(issueBody).not.toContain('abc123');
      expect(issueBody).not.toContain('hunter2');
      expect(issueBody).not.toContain('sid=short');
    });

    it('should omit full CSS path row when metadata is absent', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithSelector = {
        ...validPayload,
        metadata: {
          ...validPayload.metadata,
          elementSelector: '#submit-button',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithSelector),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('| **Element** | `#submit-button` |');
      expect(issueBody).not.toContain('Full CSS path');
    });

    it('should omit selector rows when no element metadata is present', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('System Info');
      expect(issueBody).not.toContain('| **Element** |');
      expect(issueBody).not.toContain('| **Full CSS path** |');
    });

    it('should include full CSS path even when compact selector metadata is absent', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithFullSelectorOnly = {
        ...validPayload,
        metadata: {
          ...validPayload.metadata,
          fullElementSelector: 'html > body > main > button#submit-button',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithFullSelectorOnly),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).not.toContain('| **Element** |');
      expect(issueBody).toContain(
        '| **Full CSS path** | `html > body > main > button#submit-button` |'
      );
    });

    it('should preserve selector metadata when screenshot upload fails', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockUploadScreenshotAsAsset.mockRejectedValue(new Error('upload failed'));
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithScreenshotAndSelectors = {
        ...validPayload,
        screenshot: validPngDataUrl,
        metadata: {
          ...validPayload.metadata,
          elementSelector: '#submit-button',
          fullElementSelector: 'html > body > main > button#submit-button',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithScreenshotAndSelectors),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      expect(mockUploadScreenshotAsAsset).toHaveBeenCalledWith(
        'test-token',
        'testowner',
        'testrepo',
        validPngDataUrl
      );
      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).not.toContain('## Screenshot');
      expect(issueBody).toContain('| **Element** | `#submit-button` |');
      expect(issueBody).toContain(
        '| **Full CSS path** | `html > body > main > button#submit-button` |'
      );
    });

    it.each([
      [
        'button#save\\`now',
        'html > body > button#save\\`now.action\\|primary',
        '| **Element** | `` button#save\\`now `` |',
        '| **Full CSS path** | `` html > body > button#save\\`now.action\\\\|primary `` |',
      ],
      [
        'button#save\\``now',
        'html > body > button#save\\```now.action\\|primary',
        '| **Element** | ``` button#save\\``now ``` |',
        '| **Full CSS path** | ```` html > body > button#save\\```now.action\\\\|primary ```` |',
      ],
      [
        'button#save\n| **Injected** | yes |',
        'html > body\r\n## injected',
        '| **Element** | `button#save \\| **Injected** \\| yes \\|` |',
        '| **Full CSS path** | `html > body ## injected` |',
      ],
    ])(
      'should format selector metadata safely in markdown tables for %s',
      async (elementSelector, fullElementSelector, expectedElementRow, expectedFullPathRow) => {
        mockGetInstallationToken.mockResolvedValue('test-token');
        mockCreateIssue.mockResolvedValue({
          number: 42,
          html_url: 'https://github.com/testowner/testrepo/issues/42',
        });

        const payloadWithMarkdownSensitiveSelector = {
          ...validPayload,
          metadata: {
            ...validPayload.metadata,
            elementSelector,
            fullElementSelector,
          },
        };

        const req = new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadWithMarkdownSensitiveSelector),
        });
        await app.fetch(req, mockEnv);

        const issueBody = mockCreateIssue.mock.calls[0][4];
        expect(issueBody).toContain(expectedElementRow);
        expect(issueBody).toContain(expectedFullPathRow);
      }
    );

    it('should include submitter info in issue body when provided', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithSubmitter = {
        ...validPayload,
        submitter: {
          name: 'John Doe',
          email: 'john@example.com',
        },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithSubmitter),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('## Submitted by');
      expect(issueBody).toContain('**John Doe**');
      expect(issueBody).toContain('(john@example.com)');
    });

    it('preserves ordinary legacy submitter text exactly, including common punctuation', async () => {
      const submitter = {
        name: "Élodie O'Neil-Smith",
        email: 'first_last+tag@example.co.uk',
      };
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validPayload, submitter }),
        }),
        mockEnv
      );
      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      expect(mockCreateIssue.mock.calls[0][4]).toContain(
        "## Submitted by\n**Élodie O'Neil-Smith** (first_last+tag@example.co.uk)\n"
      );
    });

    it('accepts the widget-sized name and email limits', async () => {
      const submitter = { name: 'N'.repeat(100), email: `${'a'.repeat(247)}@x.test` };
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validPayload, submitter }),
        }),
        mockEnv
      );
      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    });

    it('escapes Markdown links, emphasis, and HTML-like submitter text without creating structure', async () => {
      const submitter = {
        name: '[admin](https://evil.test) www.evil.test <script> **Trusted** &lt;x&gt; &#60;y&#62;',
        email: 'a*mark@example.com',
      };
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validPayload, submitter }),
        }),
        mockEnv
      );
      expect(res.status).toBe(200);
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      const body = mockCreateIssue.mock.calls[0][4] as string;
      const submittedBy = body.split('## Submitted by\n')[1].split('\n\n')[0];
      expect(submittedBy).toContain('\\[admin\\]\\(https\\://evil.test\\)');
      expect(submittedBy).toContain('www\\.evil.test');
      expect(submittedBy).toContain('&lt;script&gt;');
      expect(submittedBy).toContain('&amp;lt;x&amp;gt;');
      expect(submittedBy).toContain('&amp;#60;y&amp;#62;');
      expect(submittedBy).toContain('\\*\\*Trusted\\*\\*');
      expect(submittedBy).toContain('a\\*mark@example.com');
      expect(submittedBy).not.toContain('[admin](https://evil.test)');
      expect(submittedBy).not.toContain('https://evil.test');
      expect(submittedBy).not.toContain('www.evil.test');
      expect(submittedBy).not.toContain('<script>');
      expect(body.match(/^## Submitted by$/gm)).toHaveLength(1);
      expect(body).not.toMatch(/^# heading$/m);
    });

    it('puts mention-bearing names in a code span while keeping ordinary names unchanged', async () => {
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            submitter: { name: '@bugdrophq', email: 'ordinary@example.com' },
          }),
        }),
        mockEnv
      );
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][4]).toContain(
        '## Submitted by\n**`@bugdrophq`** (ordinary@example.com)\n'
      );
    });

    it('uses a longer code delimiter when an untrusted mention also contains backticks', async () => {
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            submitter: { name: '@bugdrophq `tag`', email: 'ordinary@example.com' },
          }),
        }),
        mockEnv
      );
      expect(res.status).toBe(200);
      expect(mockCreateIssue.mock.calls[0][4]).toContain(
        '## Submitted by\n**`` @bugdrophq `tag` ``** (ordinary@example.com)\n'
      );
    });

    it.each([
      [{ name: 42 }, 'non-string name'],
      [{ email: ['a@example.com'] }, 'non-string email'],
      [{ name: 'a'.repeat(101) }, 'overlong name'],
      [{ email: 'a'.repeat(255) }, 'overlong email'],
      [{ email: 'invalid-address' }, 'email without at sign'],
      [{ email: 'a@@example.com' }, 'email with two at signs'],
      [{ email: 'a@bad/domain' }, 'email with slash in domain'],
      [{ email: 'a@a..b' }, 'email with empty domain label'],
      [{ name: 'a\n## Forged heading' }, 'name with line break'],
      [{ name: 'a\u0001b' }, 'name with control character'],
      [{ name: 'a\u2028b' }, 'name with Unicode line separator'],
      [{ name: 'a\u202eb' }, 'name with bidirectional override'],
      [{ email: 'a\u2066@example.com' }, 'email with bidirectional isolate'],
      [{ email: 'a@example.com\r# Forged' }, 'email with line break'],
      [['name'], 'non-object submitter'],
    ])('rejects %s (%s) before Issue creation', async (submitter, _caseName) => {
      const res = await app.fetch(
        new Request('http://localhost/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validPayload, submitter }),
        }),
        mockEnv
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid submitter name or email',
        code: 'INVALID_SUBMITTER',
      });
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('should handle submitter with only name', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const payloadWithName = {
        ...validPayload,
        submitter: { name: 'Jane Doe' },
      };

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithName),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).toContain('## Submitted by');
      expect(issueBody).toContain('**Jane Doe**');
      // Should not contain email format (email in parentheses after name)
      expect(issueBody).not.toMatch(/\*\*Jane Doe\*\*.*\(/);
    });

    it('should not include submitter section when not provided', async () => {
      mockGetInstallationToken.mockResolvedValue('test-token');
      mockCreateIssue.mockResolvedValue({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });

      const req = new Request('http://localhost/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      await app.fetch(req, mockEnv);

      const issueBody = mockCreateIssue.mock.calls[0][4];
      expect(issueBody).not.toContain('## Submitted by');
    });
  });

  describe('OPTIONS preflight requests', () => {
    it('should handle CORS preflight for /health', async () => {
      const req = new Request('http://localhost/health', {
        method: 'OPTIONS',
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    });

    it('should handle CORS preflight for /feedback', async () => {
      const req = new Request('http://localhost/feedback', {
        method: 'OPTIONS',
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });
  });
});
