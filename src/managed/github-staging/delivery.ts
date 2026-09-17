import { json, readBounded, record, reject } from '../local/protocol';
import { appJwt } from './auth';
import {
  installationMatches,
  minimalPermissions,
  repositoryMatches,
  stagingConfig,
  type StagingGitHubConfig,
} from './config';

type Outcome = 'delivered' | 'indeterminate' | 'failed_before_delivery';
export interface GitHubSecrets {
  privateKey: string;
}
export type GitHubTransport = (request: Request) => Promise<Response>;
const API = 'https://api.github.com';

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) reject();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 64 * 1024) {
        await reader.cancel();
        reject();
      }
      parts.push(chunk.value);
    }
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      raw.set(part, offset);
      offset += part.length;
    }
    return json(raw);
  } finally {
    reader.releaseLock();
  }
}

async function installationToken(
  config: StagingGitHubConfig,
  secret: string,
  send: (path: string, token: string, body?: unknown) => Promise<Response>
): Promise<string> {
  const jwt = await appJwt(config.appId, secret);
  const installation = await send(`/app/installations/${config.installationId}`, jwt);
  if (installation.status !== 200) reject();
  installationMatches(await boundedJson(installation), config);
  const response = await send(`/app/installations/${config.installationId}/access_tokens`, jwt, {
    repository_ids: [config.repositoryId],
    permissions: { issues: 'write' },
  });
  if (response.status !== 201) reject();
  const result = record(await boundedJson(response));
  minimalPermissions(result.permissions);
  if (!Array.isArray(result.repositories) || result.repositories.length !== 1) reject();
  repositoryMatches(result.repositories[0], config);
  if (
    typeof result.token !== 'string' ||
    // Installation tokens are opaque; current stateless tokens include dots and exceed 520 bytes.
    !/^[\x21-\x7e]{1,8192}$/.test(result.token) ||
    typeof result.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(result.expires_at)) ||
    Date.parse(result.expires_at) <= Date.now() + 10_000
  )
    reject();
  return result.token;
}

/** Private delivery port; its caller must durably admit the receipt BEFORE invoking it. */
export async function handleGitHubDelivery(
  request: Request,
  configuration: unknown,
  secrets: GitHubSecrets,
  authorizationExpiresAt: number,
  transport: GitHubTransport = request => fetch(request)
): Promise<Response> {
  let dispatched = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const respond = (outcome: Outcome) =>
    Response.json({ outcome }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const config = stagingConfig(configuration);
    const authorized = () => {
      const now = Date.now();
      if (
        !Number.isFinite(authorizationExpiresAt) ||
        authorizationExpiresAt <= now ||
        authorizationExpiresAt > now + 30_000
      )
        reject();
    };
    authorized();
    if (
      request.method !== 'POST' ||
      new URL(request.url).pathname !== '/deliver' ||
      !secrets.privateKey
    )
      return respond('failed_before_delivery');
    const send = async (path: string, token: string, body?: unknown): Promise<Response> => {
      controller.signal.throwIfAborted();
      return transport(
        new Request(`${API}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'BugDrop-Staging-Dogfood',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    };
    const attempt = async (): Promise<Outcome> => {
      const raw = await readBounded(request, 60_000);
      record(json(raw));
      const body = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(raw);
      const token = await installationToken(config, secrets.privateKey, send);
      controller.signal.throwIfAborted();
      authorized();
      // This is the only issue-creating dispatch; never retry any result or exception.
      dispatched = true;
      const response = await send(`/repos/${config.owner}/${config.repository}/issues`, token, {
        title: 'BugDrop staging dogfood report',
        body,
      });
      // No GitHub content, URLs, issue identifiers or error bodies leave this boundary.
      void response.body?.cancel().catch(() => {});
      return response.status === 201 ? 'delivered' : 'indeterminate';
    };
    const timeout = new Promise<Outcome>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(dispatched ? 'indeterminate' : 'failed_before_delivery');
      }, 10_000);
    });
    return respond(await Promise.race([attempt(), timeout]));
  } catch {
    return respond(dispatched ? 'indeterminate' : 'failed_before_delivery');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
