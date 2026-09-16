import { binding, bytes, keys, record, reject, type Binding } from './protocol';

// Harness-private transport. SDK V1 does not yet specify the hosted submission HTTP transport.
export interface LocalSubmission {
  token: string;
  origin: string;
  binding: Binding;
  body: string;
}
export function submission(value: unknown): LocalSubmission {
  const r = record(value);
  keys(r, ['token', 'origin', 'binding', 'body']);
  const b = record(r.binding);
  keys(b, ['submissionId', 'payloadDigest']);
  if (typeof r.token !== 'string' || typeof r.origin !== 'string' || typeof r.body !== 'string')
    return reject();
  bytes(r.body);
  return { token: r.token, origin: r.origin, binding: binding(b), body: r.body };
}
