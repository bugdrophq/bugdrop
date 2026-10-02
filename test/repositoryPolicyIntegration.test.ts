import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import api from '../src/routes/api';
import type { Env } from '../src/types';

// Real API and GitHub client imports: any attempted external request is a failure.
const app = new Hono<{ Bindings: Env }>().route('/api', api);
const env: Env = {
  GITHUB_APP_ID: 'test-app',
  GITHUB_PRIVATE_KEY: 'test-key',
  ENVIRONMENT: 'development',
  ALLOWED_ORIGINS: '*',
  GITHUB_APP_NAME: 'test-app',
  MAX_SCREENSHOT_SIZE_MB: '5',
  ASSETS: {} as Fetcher,
  ALLOWED_REPOSITORIES: 'approved/repo',
};
const network = vi.fn(() => {
  throw new Error('Unexpected external request');
});
const metadata = {
  url: 'https://example.test/report',
  userAgent: 'test',
  viewport: { width: 1024, height: 768 },
  timestamp: '2026-09-10T12:00:00Z',
};
const legacy = { repo: 'blocked/repo', title: 'Report', metadata };
const structured = {
  kind: 'bugdrop.variant-submission',
  schemaVersion: 1,
  repo: 'blocked/repo',
  variantId: 'report',
  submissionId: 'policy-integration-1',
  issue: {
    title: 'Report',
    classification: 'bug',
    sections: [{ heading: 'Problem', value: 'Broken' }],
  },
  metadata,
};

beforeEach(() => {
  network.mockClear();
  vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

describe('repository policy real-client integration', () => {
  it('rejects an installation check before external access', async () => {
    const response = await app.request('http://bugdrop.localhost/api/check/blocked/repo', {}, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    ['legacy', legacy],
    ['structured', structured],
  ])('rejects %s feedback before external access', async (_, payload) => {
    const response = await app.request(
      'http://bugdrop.localhost/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      env
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Repository is not allowed' });
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps invalid JSON on the validation path', async () => {
    const response = await app.request(
      'http://bugdrop.localhost/api/feedback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON' });
    expect(network).not.toHaveBeenCalled();
  });
  it('does not restrict health checks', async () => {
    const response = await app.request('http://bugdrop.localhost/api/health', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    expect(network).not.toHaveBeenCalled();
  });
});
