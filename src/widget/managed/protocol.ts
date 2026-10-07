export type Feedback = {
  schemaVersion: 1;
  title: string;
  description: string;
  category?: 'bug' | 'feature' | 'question';
};
export type Binding = Readonly<{ submissionId: string; payloadDigest: string }>;
export type TokenProvider = (binding: Binding) => string | Promise<string>;
type ErrorCode = keyof typeof errors;
export type Outcome =
  | { status: 'delivered'; receiptId: string }
  | { status: 'indeterminate'; receiptId?: string }
  | { status: 'rejected'; code: ErrorCode }
  | { status: 'authorization_failed' };

const errors = {
  invalid_request: [400, false],
  invalid_capability: [401, false],
  forbidden: [403, false],
  replay_detected: [409, false],
  payload_too_large: [413, false],
  rate_limited: [429, true],
  authority_unavailable: [503, true],
  delivery_unavailable: [503, true],
  internal_error: [500, true],
} as const;
const encoder = new TextEncoder();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function text(value: unknown, limit: number, multiline: boolean): value is string {
  if (typeof value !== 'string' || !value.trim() || /[\uD800-\uDFFF]/u.test(value)) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && (!multiline || ![9, 10, 13].includes(code)))) return false;
  }
  return encoder.encode(value).length <= limit;
}

export function snapshotBody(value: Feedback): Uint8Array {
  try {
    if (!record(value)) throw new Error();
    const category = Object.hasOwn(value, 'category');
    if (!exact(value, ['schemaVersion', 'title', 'description', ...(category ? ['category'] : [])]))
      throw new Error();
    const snapshot: Feedback = {
      schemaVersion: value.schemaVersion,
      title: value.title,
      description: value.description,
    };
    if (category) snapshot.category = value.category;
    if (
      snapshot.schemaVersion !== 1 ||
      !text(snapshot.title, 256, false) ||
      !text(snapshot.description, 16384, true) ||
      (category && !['bug', 'feature', 'question'].includes(snapshot.category as string))
    )
      throw new Error();
    const body = encoder.encode(JSON.stringify(snapshot));
    if (body.length > 65536) throw new Error();
    return body;
  } catch {
    throw new Error('Invalid feedback');
  }
}

export function submissionEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const local =
      url.hostname.endsWith('.localhost') ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.pathname !== '/v1/submissions' ||
      url.href.includes('?') ||
      url.href.includes('#') ||
      url.username ||
      url.password
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error('Invalid submission endpoint');
  }
}

export function parseOutcome(value: unknown, httpStatus: number): Outcome {
  if (!record(value) || value.schemaVersion !== 1) return { status: 'indeterminate' };
  if (exact(value, ['schemaVersion', 'status', 'receiptId'])) {
    const validId =
      typeof value.receiptId === 'string' &&
      value.receiptId.length === 36 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.receiptId
      );
    if (
      validId &&
      ((value.status === 'delivered' && httpStatus === 200) ||
        (value.status === 'indeterminate' && httpStatus === 409))
    ) {
      return { status: value.status, receiptId: value.receiptId as string };
    }
  }
  if (
    exact(value, ['schemaVersion', 'error']) &&
    record(value.error) &&
    exact(value.error, ['code', 'retryable'])
  ) {
    const { code, retryable } = value.error;
    if (typeof code === 'string' && Object.hasOwn(errors, code)) {
      const expected = errors[code as ErrorCode];
      if (httpStatus === expected[0] && retryable === expected[1])
        return { status: 'rejected', code: code as ErrorCode };
    }
  }
  return { status: 'indeterminate' };
}

export function isSubmissionToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  );
}
