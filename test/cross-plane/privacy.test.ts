import { describe, expect, it } from 'vitest';
import { assertContentFree } from './privacy';

const secret = 'cross-plane-private-canary-814';
describe('privacy oracle detects poisoned evidence instead of accepting an empty proof', () => {
  it.each(['queues', 'logs', 'analytics', 'outcomes', 'receipts'])(
    'rejects canary data nested in %s',
    sink => {
      expect(() => assertContentFree({ [sink]: [{ reason: secret }] }, [secret])).toThrow();
      expect(() => assertContentFree({ [sink]: [{ [secret]: 'opaque' }] }, [secret])).toThrow();
    }
  );
  it.each(['payload', 'headers', 'token', 'reporterId', 'submissionId', 'url', 'stack'])(
    'rejects a forbidden %s field even without a known canary',
    key => expect(() => assertContentFree({ [key]: 'opaque' }, [])).toThrow()
  );
  it.each(['https://report.example/private', 'Bearer unrecognized', 'bd_api_v1.unrecognized'])(
    'rejects unanticipated sensitive string %s',
    value => expect(() => assertContentFree({ reason: value }, [])).toThrow()
  );
  it('rejects raw exception and binary evidence that JSON enumeration can miss', () => {
    expect(() => assertContentFree({ logs: [new Error(secret)] }, [secret])).toThrow();
    expect(() => assertContentFree({ queues: [Buffer.from(secret)] }, [secret])).toThrow();
    const hidden = Object.defineProperty({}, 'payload', { value: secret });
    expect(() => assertContentFree({ receipts: [hidden] }, [secret])).toThrow();
  });
  it('accepts normalized content-free evidence', () => {
    expect(() =>
      assertContentFree(
        {
          attempts: 1,
          outcomes: [{ schemaVersion: 1, outcome: 'indeterminate' }],
          receipts: [{ state: 'indeterminate', expiresAt: 1234, commitment: 'opaque' }],
          queues: [],
          logs: [],
          analytics: [],
        },
        [secret]
      )
    ).not.toThrow();
  });
});
