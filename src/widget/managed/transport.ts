import {
  isSubmissionToken,
  parseOutcome,
  snapshotBody,
  submissionEndpoint,
  type Feedback,
  type Outcome,
  type TokenProvider,
} from './protocol';

const authorizationTimeoutMs = 10_000;
const deliveryTimeoutMs = 10_000;
const responseLimit = 2048;

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Submission timed out'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function readOutcome(response: Response, signal: AbortSignal): Promise<Outcome> {
  const contentLength = response.headers.get('content-length');
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > responseLimit)) ||
    !response.body
  )
    return { status: 'indeterminate' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      length += value.length;
      if (length > responseLimit) return { status: 'indeterminate' };
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return parseOutcome(JSON.parse(decoded), response.status);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function createSubmission(
  feedback: Feedback,
  endpoint: string,
  tokenProvider: TokenProvider
): Promise<{ submit(): Promise<Outcome> }> {
  const body = new Uint8Array(snapshotBody(feedback));
  const target = submissionEndpoint(endpoint);
  const submissionId = crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const payloadDigest = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  let pending: Promise<Outcome> | undefined;
  let delivered: Outcome | undefined;

  async function send(): Promise<Outcome> {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), authorizationTimeoutMs);
    try {
      let token: string;
      try {
        token = await bounded(
          Promise.resolve().then(() =>
            tokenProvider(Object.freeze({ submissionId, payloadDigest }))
          ),
          controller.signal
        );
        if (controller.signal.aborted || !isSubmissionToken(token))
          return { status: 'authorization_failed' };
      } catch {
        return { status: 'authorization_failed' };
      }
      // Authorization may consume most of its budget. Give delivery and body
      // reading their own bounded window without retrying either operation.
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), deliveryTimeoutMs);
      const response = await bounded(
        fetch(target, {
          method: 'POST',
          body: body.slice(),
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-BugDrop-Submission-Id': submissionId,
            Authorization: `Bearer ${token}`,
          },
        }),
        controller.signal
      );
      return await readOutcome(response, controller.signal);
    } catch {
      return { status: 'indeterminate' };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    submit() {
      if (delivered) return Promise.resolve(delivered);
      if (!pending)
        pending = send()
          .then(outcome => {
            const result = Object.freeze(outcome);
            if (result.status === 'delivered') delivered = result;
            return result;
          })
          .finally(() => {
            pending = undefined;
          });
      return pending;
    },
  };
}
