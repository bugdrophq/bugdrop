import { describe, expect, it } from 'vitest';
import { createBugDropAuthTokenForTest, verifyBugDropAuthToken } from '../../src/lib/authToken';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';
import response from '../protocol/v1/fixtures/capability-response.v1.json';

// Deliberately synthetic current-public fixture, never a configured credential.
const secret = 'current-public-cross-plane-test-only-fixture';
const options = { secret, repo: 'fixture-owner/fixture-repo', now: 1000 };

describe('current public token authority is independent of managed credentials', () => {
  it('preserves its existing valid current-public token behavior', async () => {
    const claims = {
      sub: 'synthetic-public-contract-fixture',
      repo: options.repo,
      iat: 990,
      exp: 1100,
      jti: 'synthetic-token-id',
    };
    const token = await createBugDropAuthTokenForTest(claims, secret);
    await expect(verifyBugDropAuthToken(token, options)).resolves.toEqual(claims);
  });

  it.each([credential.apiKey, credential.authorization, response.token])(
    'does not treat managed credential/token material as current-public authority',
    async token => {
      await expect(verifyBugDropAuthToken(token, options)).rejects.toThrow();
    }
  );
});
