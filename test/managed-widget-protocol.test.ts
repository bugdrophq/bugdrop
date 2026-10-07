import { describe, expect, it } from 'vitest';
import {
  parseOutcome,
  snapshotBody,
  submissionEndpoint,
  type Feedback,
} from '../src/widget/managed/protocol';
const receiptId = '10000000-0000-4000-8000-000000000001';
const feedback: Feedback = { schemaVersion: 1, title: 'Hello', description: 'Description' };

describe('managed feedback and public response protocol', () => {
  it('accepts exact confirmed and ambiguous responses with matching HTTP statuses', () => {
    expect(parseOutcome({ schemaVersion: 1, status: 'delivered', receiptId }, 200)).toEqual({
      status: 'delivered',
      receiptId,
    });
    expect(parseOutcome({ schemaVersion: 1, status: 'indeterminate', receiptId }, 409)).toEqual({
      status: 'indeterminate',
      receiptId,
    });
  });
  it.each([
    [null, 200],
    [{ schemaVersion: 1, status: 'delivered', receiptId }, 201],
    [{ schemaVersion: 1, status: 'delivered', receiptId }, 409],
    [{ schemaVersion: 1, status: 'indeterminate', receiptId }, 200],
    [{ schemaVersion: 2, status: 'delivered', receiptId }, 200],
    [{ schemaVersion: 1, status: 'delivered', receiptId: 'not-uuid' }, 200],
    [{ schemaVersion: 1, status: 'delivered', receiptId: receiptId + '\n' }, 200],
    [{ schemaVersion: 1, status: 'delivered', receiptId, url: 'private' }, 200],
    [{ schemaVersion: 1, outcome: 'delivered' }, 200],
    [{ schemaVersion: 1, error: { code: 'unknown', retryable: false } }, 400],
    [{ schemaVersion: 1, error: { code: 'forbidden', retryable: true } }, 403],
    [{ schemaVersion: 1, error: { code: 'forbidden', retryable: false, message: 'secret' } }, 403],
  ])('never reports unproven success %#', (body, status) => {
    expect(parseOutcome(body, status as number)).toEqual({ status: 'indeterminate' });
  });
  it.each([
    ['invalid_request', 400, false],
    ['invalid_capability', 401, false],
    ['forbidden', 403, false],
    ['replay_detected', 409, false],
    ['payload_too_large', 413, false],
    ['rate_limited', 429, true],
    ['authority_unavailable', 503, true],
    ['delivery_unavailable', 503, true],
    ['internal_error', 500, true],
  ])('accepts only exact HTTP and retryable mapping for %s', (code, status, retryable) => {
    const body = { schemaVersion: 1, error: { code, retryable } };
    expect(parseOutcome(body, status as number)).toEqual({ status: 'rejected', code });
    expect(parseOutcome(body, 200)).toEqual({ status: 'indeterminate' });
    expect(
      parseOutcome({ ...body, error: { code, retryable: !retryable } }, status as number)
    ).toEqual({ status: 'indeterminate' });
  });
  it('preserves UTF-8 body content including combining text, CRLF and tabs', () => {
    const value = { ...feedback, title: ' Cafe\u0301 😀 ', description: '\tline\r\nnext' };
    expect(new TextDecoder().decode(snapshotBody(value))).toBe(JSON.stringify(value));
    expect(() => snapshotBody({ ...feedback, title: '😀'.repeat(64) })).not.toThrow();
    expect(() => snapshotBody({ ...feedback, description: '😀'.repeat(4096) })).not.toThrow();
  });
  it.each([
    { title: '' },
    { title: ' ' },
    { title: 'x\n' },
    { title: '😀'.repeat(65) },
    { title: '\ud800' },
    { title: 'x\x7f' },
    { description: '\t\r\n' },
    { description: '\udfff' },
    { description: 'x\x00' },
    { description: '😀'.repeat(4097) },
    { category: ['bug'] },
    { category: undefined },
    { attachments: [] },
    { labels: [] },
    { repositoryId: '1' },
    { schemaVersion: 2 },
  ])('rejects invalid or privileged feedback %#', override => {
    expect(() => snapshotBody({ ...feedback, ...override } as Feedback)).toThrow(
      'Invalid feedback'
    );
  });
  it.each([
    'https://example.test/v1/submissions',
    'http://widget.localhost:1234/v1/submissions',
    'http://localhost:1234/v1/submissions',
    'http://127.0.0.1/v1/submissions',
    'http://[::1]/v1/submissions',
  ])('accepts explicit endpoint %s', endpoint => {
    expect(submissionEndpoint(endpoint)).toBe(endpoint);
  });
  it.each([
    'http://example.test/v1/submissions',
    'https://user:pass@example.test/v1/submissions',
    'https://example.test/v1/submissions?',
    'https://example.test/v1/submissions#',
    'https://example.test/legacy',
    '/v1/submissions',
    'https://example.test/v1/submissions?secret=value',
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(() => submissionEndpoint(endpoint)).toThrow('Invalid submission endpoint');
  });
});
