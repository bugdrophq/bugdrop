import { Buffer } from 'node:buffer';
import { json, readBounded, record, utf8 } from '../local/protocol';
import { installationIdentity, stagingConfig } from './config';

/** True authorizes a durable revocation latch only; it never reactivates an installation. */
export async function verifyGitHubUninstall(
  request: Request,
  configuration: unknown,
  webhookSecret: string
): Promise<boolean> {
  try {
    const config = stagingConfig(configuration);
    const signature = request.headers.get('X-Hub-Signature-256') ?? '';
    if (
      request.method !== 'POST' ||
      request.headers.get('X-GitHub-Event') !== 'installation' ||
      !/^sha256=[0-9a-f]{64}$/.test(signature) ||
      utf8(webhookSecret).length < 32
    )
      return false;
    const raw = await readBounded(request);
    const key = await crypto.subtle.importKey(
      'raw',
      utf8(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        key,
        new Uint8Array(Buffer.from(signature.slice(7), 'hex')),
        raw
      ))
    )
      return false;
    const payload = record(json(raw));
    if (payload.action !== 'deleted') return false;
    installationIdentity(payload.installation, config);
    return true;
  } catch {
    return false;
  }
}
