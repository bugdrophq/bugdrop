import { createPrivateKey } from 'node:crypto';
import { encode, utf8 } from '../local/protocol';

/** GitHub-generated PKCS#1 keys are converted transiently for Web Crypto. */
export async function appJwt(appId: number, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encode(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = encode(
    utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }))
  );
  const key = createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'der' });
  const imported = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', imported, utf8(signingInput));
  return `${signingInput}.${encode(signature)}`;
}
