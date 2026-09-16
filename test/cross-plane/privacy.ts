import { expect } from 'vitest';

// Trusted application configuration is intentionally outside this sink snapshot.
// Caller-controlled request data must never become durable receipt/telemetry data.
const forbiddenKeys = new Set([
  'body',
  'payload',
  'requestBody',
  'rawBody',
  'message',
  'title',
  'description',
  'screenshot',
  'attachments',
  'consoleLogs',
  'url',
  'page',
  'pageUrl',
  'issueUrl',
  'html_url',
  'headers',
  'authorization',
  'token',
  'apiKey',
  'authSecret',
  'rootSecret',
  'subject',
  'sub',
  'userId',
  'reporterId',
  'reporter',
  'email',
  'pseudonym',
  'ip',
  'submissionId',
  'stack',
  'exception',
]);

export function assertContentFree(value: unknown, canaries: readonly string[]): void {
  function visit(item: unknown): void {
    if (typeof item === 'string') {
      for (const canary of canaries) expect(item).not.toContain(canary);
      expect(item).not.toMatch(/https?:\/\/|Bearer |bd_api_v1\.|bd_auth_v1\./i);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      expect(item).not.toBeInstanceOf(Error);
      expect(ArrayBuffer.isView(item) || item instanceof ArrayBuffer).toBe(false);
      for (const key of Object.getOwnPropertyNames(item)) {
        const entry = (item as Record<string, unknown>)[key];
        expect(forbiddenKeys.has(key), `Forbidden sink field: ${key}`).toBe(false);
        for (const canary of canaries) expect(key).not.toContain(canary);
        visit(entry);
      }
    }
  }
  visit(value);
}
