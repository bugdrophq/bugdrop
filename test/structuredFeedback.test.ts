import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, StructuredFeedbackPayload } from '../src/types';
import { createBugDropAuthTokenForTest } from '../src/lib/authToken';

const mockGetInstallationToken = vi.fn();
const mockCreateIssue = vi.fn();
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
  getInstallationToken: (...arguments_: unknown[]) => mockGetInstallationToken(...arguments_),
  getInstallationAccess: async (...arguments_: unknown[]) => {
    const token = await mockGetInstallationToken(...arguments_);
    return token ? { token, installationId: 123456 } : null;
  },
  createIssue: (...arguments_: unknown[]) => mockCreateIssue(...arguments_),
  isRepoPublic: (...arguments_: unknown[]) => mockIsRepoPublic(...arguments_),
  uploadScreenshotAsAsset: vi.fn(),
  uploadAttachmentAsAsset: vi.fn(),
  GitHubLabelError: TestGitHubLabelError,
}));

const validPayload: StructuredFeedbackPayload = {
  kind: 'bugdrop.variant-submission',
  schemaVersion: 1,
  repo: 'testowner/testrepo',
  variantId: 'export-review',
  submissionId: 'submission-1234',
  issue: {
    title: '  Export   review — 5/5  ',
    classification: 'feedback',
    sections: [
      { heading: 'Rating', value: '5/5 *great*' },
      { heading: 'Comment', value: 'Fast and predictable.', format: 'quote' },
      { heading: 'Optional', value: '   ' },
    ],
  },
  metadata: {
    url: 'https://example.test/export?token=secret#private',
    userAgent: 'FrozenAgent/1.0',
    viewport: { width: 1280, height: 720 },
    timestamp: '2026-08-02T12:34:56.000Z',
    appVersion: '1.2.3|desktop',
    browser: { name: 'Chrome', version: '126.0' },
    os: { name: 'macOS', version: '14.5' },
    devicePixelRatio: 2,
    language: 'en-US',
  },
};

const expectedBody = `## Rating

5/5 \\*great\\*

## Comment

> Fast and predictable.

<details>
<summary>System Info</summary>

| Property | Value |
|----------|-------|
| **App Version** | \`1.2.3\\|desktop\` |
| **Browser** | Chrome 126.0 |
| **OS** | macOS 14.5 |
| **Viewport** | 1280×720 @2x |
| **Language** | en-US |
| **Page** | https://example.test/export |
| **Timestamp** | 2026-08-02T12:34:56.000Z |

</details>

<!-- bugdrop-submission: submission-1234 -->

---
*Submitted via [BugDrop](https://github.com/bugdrophq/bugdrop)*`;

describe('structured feedback Worker contract', () => {
  let app: Hono;
  const env: Env = {
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_PRIVATE_KEY: 'test-private-key',
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: '*',
    GITHUB_APP_NAME: 'test-bugdrop-app',
    MAX_SCREENSHOT_SIZE_MB: '5',
    ASSETS: {} as Fetcher,
  };

  beforeEach(async () => {
    mockGetInstallationToken.mockReset().mockResolvedValue('test-token');
    mockCreateIssue.mockReset().mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/testowner/testrepo/issues/42',
    });
    mockIsRepoPublic.mockReset().mockResolvedValue(true);
    const { default: api } = await import('../src/routes/api');
    app = api;
  });

  async function submit(payload: unknown, overrideEnv: Env = env) {
    const request = new Request('http://localhost/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return app.fetch(request, overrideEnv);
  }

  it('creates one Issue from a normalized field-agnostic draft', async () => {
    const response = await submit(validPayload);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      issueNumber: 42,
      issueUrl: 'https://github.com/testowner/testrepo/issues/42',
      isPublic: true,
    });
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'test-token',
      'testowner',
      'testrepo',
      'Export review — 5/5',
      expectedBody,
      ['bugdrop']
    );
    expect(mockGetInstallationToken).toHaveBeenCalledOnce();
  });

  it('queues one anonymous counter increment after a valid structured Issue result', async () => {
    const counterFetch = vi.fn().mockResolvedValue(Response.json({ total: 3117 }));
    const counterId = {} as DurableObjectId;
    const waitUntil = vi.fn();
    const counterEnv = {
      ...env,
      FEEDBACK_COUNTER: {
        idFromName: vi.fn().mockReturnValue(counterId),
        get: vi.fn().mockReturnValue({ fetch: counterFetch }),
      } as unknown as DurableObjectNamespace,
    };
    const request = new Request('http://localhost/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });

    const response = await app.fetch(request, counterEnv, {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0][0] as Promise<void>);
    expect(counterFetch).toHaveBeenCalledOnce();
  });

  it('omits App Version when metadata does not provide one', async () => {
    const payload = structuredClone(validPayload);
    delete payload.metadata.appVersion;

    const response = await submit(payload);
    const body = mockCreateIssue.mock.calls[0][4] as string;

    expect(response.status).toBe(200);
    expect(body).not.toContain('App Version');
  });

  it('formats a hypothetical contributor field as generic sections without a Worker branch', async () => {
    const payload = structuredClone(validPayload);
    payload.variantId = 'contributor-priority-matrix';
    payload.issue = {
      title: 'Contributor extension proof',
      classification: 'feature',
      sections: [
        { heading: 'Matrix selection', value: 'high-impact / low-effort', format: 'text' },
        { heading: 'Contributor rationale', value: 'Ship the generic contract.', format: 'quote' },
        { heading: 'Machine value', value: 'priority:p1', format: 'code' },
      ],
    };

    const response = await submit(payload);
    const body = mockCreateIssue.mock.calls[0][4] as string;

    expect(response.status).toBe(200);
    expect(mockCreateIssue).toHaveBeenCalledOnce();
    expect(body).toContain('## Matrix selection\n\nhigh-impact / low-effort');
    expect(body).toContain('## Contributor rationale\n\n> Ship the generic contract.');
    expect(body).toContain('## Machine value\n\n```\npriority:p1\n```');
    expect(body).toContain('<!-- bugdrop-submission: submission-1234 -->');
  });

  it('shares the existing auth-token boundary before GitHub access', async () => {
    const protectedEnv = {
      ...env,
      AUTH_TOKEN_SECRET: 'structured-secret-with-at-least-32-bytes',
    };

    const response = await submit(validPayload, protectedEnv);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'BugDrop auth token required' });
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it('accepts a structured submission with a repo-bound existing auth token', async () => {
    const protectedEnv = {
      ...env,
      AUTH_TOKEN_SECRET: 'structured-secret-with-at-least-32-bytes',
    };
    const now = Math.floor(Date.now() / 1000);
    const token = await createBugDropAuthTokenForTest(
      {
        sub: 'structured-user',
        repo: validPayload.repo,
        iat: now,
        exp: now + 300,
        jti: 'structured-jti',
      },
      protectedEnv.AUTH_TOKEN_SECRET
    );
    const request = new Request('http://localhost/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(validPayload),
    });

    const response = await app.fetch(request, protectedEnv);

    expect(response.status).toBe(200);
    expect(mockCreateIssue).toHaveBeenCalledOnce();
  });

  it('resolves custom labels only from server-owned repo and variant configuration', async () => {
    const response = await submit(validPayload, {
      ...env,
      VARIANT_LABELS: JSON.stringify({
        'testowner/testrepo': { 'export-review': ['feedback', 'rating', 'feedback'] },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateIssue.mock.calls[0][5]).toEqual(['feedback', 'rating', 'bugdrop']);
    expect(await response.json()).not.toHaveProperty('labelMappingWarnings');
  });

  it('falls back to classification labels and surfaces unknown configured variants', async () => {
    const payload = structuredClone(validPayload);
    payload.issue.classification = 'feature';
    const response = await submit(payload, {
      ...env,
      VARIANT_LABELS: JSON.stringify({
        'testowner/testrepo': { 'another-variant': ['triage'] },
      }),
    });
    const body = mockCreateIssue.mock.calls[0][4] as string;
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreateIssue.mock.calls[0][5]).toEqual(['enhancement', 'bugdrop']);
    expect(body).toContain('## Label mapping warning');
    expect(result.labelMappingWarnings).toHaveLength(1);
  });

  it('retries a GitHub label rejection once with safe classification defaults', async () => {
    mockCreateIssue
      .mockRejectedValueOnce(new TestGitHubLabelError('invalid labels'))
      .mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/testowner/testrepo/issues/42',
      });
    const payload = structuredClone(validPayload);
    payload.issue.classification = 'bug';
    const response = await submit(payload, {
      ...env,
      VARIANT_LABELS: JSON.stringify({
        'testowner/testrepo': { 'export-review': ['custom-label'] },
      }),
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    expect(mockCreateIssue.mock.calls[0][5]).toEqual(['custom-label', 'bugdrop']);
    expect(mockCreateIssue.mock.calls[1][5]).toEqual(['bug', 'bugdrop']);
    expect(mockCreateIssue.mock.calls[1][4]).toContain('GitHub rejected configured labels');
    expect(result.labelMappingWarnings).toHaveLength(1);
  });

  it.each([
    ['unsupported schema', { ...validPayload, schemaVersion: 2 }],
    ['raw labels', { ...validPayload, labels: ['privileged'] }],
    ['label set', { ...validPayload, issue: { ...validPayload.issue, labelSet: 'admin' } }],
    ['evidence', { ...validPayload, screenshot: 'data:image/png;base64,AAAA' }],
    [
      'duplicate headings',
      {
        ...validPayload,
        issue: {
          ...validPayload.issue,
          sections: [
            { heading: 'Same', value: 'one' },
            { heading: 'same', value: 'two' },
          ],
        },
      },
    ],
    [
      'nested section value',
      {
        ...validPayload,
        issue: {
          ...validPayload.issue,
          sections: [{ heading: 'Nested', value: { unsafe: true } }],
        },
      },
    ],
    [
      'invalid metadata',
      {
        ...validPayload,
        metadata: { ...validPayload.metadata, viewport: { width: NaN, height: 1 } },
      },
    ],
    [
      'oversized app version',
      {
        ...validPayload,
        metadata: { ...validPayload.metadata, appVersion: 'v'.repeat(129) },
      },
    ],
    [
      'app version with control characters',
      {
        ...validPayload,
        metadata: { ...validPayload.metadata, appVersion: '1.2.3\nforged' },
      },
    ],
  ])('rejects %s before any GitHub call', async (_name, payload) => {
    const response = await submit(payload);

    expect(response.status).toBe(400);
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('enforces the complete 32 KB payload bound independently of per-section bounds', async () => {
    const payload = structuredClone(validPayload);
    payload.issue.sections = Array.from({ length: 7 }, (_, index) => ({
      heading: `Section ${index}`,
      value: 'x'.repeat(5_000),
      format: 'text' as const,
    }));

    const response = await submit(payload);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.error).toContain('32768 bytes');
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it('rejects escaped output beyond GitHub body limits before Issue creation', async () => {
    const payload = structuredClone(validPayload);
    payload.issue.sections = Array.from({ length: 6 }, (_, index) => ({
      heading: `${'#'.repeat(100)}${index}`,
      value: '*'.repeat(4_400),
      format: 'text' as const,
    }));
    payload.metadata.url = `https://example.test/${'é'.repeat(1_900)}`;
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(32 * 1_024);

    const response = await submit(payload);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.error).toContain('65536 characters after formatting');
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('uses a fence longer than user backticks and never emits empty optional sections', async () => {
    const payload = structuredClone(validPayload);
    payload.issue.sections = [
      { heading: 'Code', value: 'before ``` after', format: 'code' },
      { heading: 'Empty', value: '\n\t' },
    ];

    const response = await submit(payload);
    const body = mockCreateIssue.mock.calls[0][4] as string;

    expect(response.status).toBe(200);
    expect(body).toContain('````\nbefore ``` after\n````');
    expect(body).not.toContain('## Empty');
  });

  it('does not report success for a non-canonical GitHub Issue result', async () => {
    mockCreateIssue.mockResolvedValue({
      number: 0,
      html_url: 'https://attacker.test/not-an-issue',
    });

    const response = await submit(validPayload);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'GitHub returned an invalid Issue result' });
  });
});
