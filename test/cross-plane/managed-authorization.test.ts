import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBugDropAuthTokenForTest, verifyBugDropAuthToken } from '../../src/lib/authToken';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';
import origins from '../protocol/v1/fixtures/origin.v1.json';
import bindings from '../protocol/v1/fixtures/submission-binding.v1.json';
import {
  binding,
  capabilityHeaders,
  canaries,
  forbiddenExchangeFields,
  malformedSdkVersions,
  report,
} from './attack-inputs';
import { startManaged, type ManagedAdapter } from './managed-adapter';
import { assertPrivate, exchange, mint, submission } from './managed-requests';
import { assertContentFree } from './privacy';

let service: ManagedAdapter;
beforeEach(async () => {
  service = await startManaged();
}, 60_000);
afterEach(async () => {
  await service?.close();
}, 60_000);

describe.sequential('real managed authorization across plane and application boundaries', () => {
  it('refuses current-public tokens, root API keys and copied app IDs as capability credentials', async () => {
    const publicToken = await createBugDropAuthTokenForTest(
      {
        sub: 'synthetic-public-fixture',
        repo: 'fixture-owner/fixture-repo',
        iat: 1000,
        exp: 2000,
        jti: 'public-token',
      },
      'synthetic-public-secret-not-configured'
    );
    for (const authorization of [
      `Bearer ${publicToken}`,
      `Bearer ${credential.apiKey}`,
      'Bearer app_mean_weasel_bugdrop_dogfood',
      ...credential.invalidAuthorizations,
    ]) {
      const result = await exchange(
        service,
        {},
        capabilityHeaders({ Authorization: authorization })
      );
      expect(result.ok).toBe(false);
      assertContentFree(await result.json(), [publicToken, credential.apiKey]);
    }
    expect((await assertPrivate(service, [publicToken])).attempts).toBe(0);
    const capability = await mint(service);
    await expect(
      verifyBugDropAuthToken(capability.token, {
        secret: 'synthetic-public-secret-not-configured',
        repo: 'fixture-owner/fixture-repo',
      })
    ).rejects.toThrow();
  }, 60_000);

  it('rejects trailing dots, aliases and unconfigured exact origins on issuance and submission', async () => {
    const capability = await mint(service);
    const attacks = [
      ...origins.invalid,
      'https://different.example',
      `${service.origin}:8443`,
      `${service.origin}.`,
      `${service.origin}:443`,
      `${service.origin}/`,
      `${service.origin}?`,
      service.origin.toUpperCase(),
    ];
    for (const origin of attacks) {
      // JSON origin bytes reach issuance unchanged; invalid header whitespace is not normalized here.
      expect((await exchange(service, { origin })).ok).toBe(false);
      expect((await service.submit({ ...submission(capability), origin })).outcome).toBe(
        'rejected'
      );
    }
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
    expect((await service.submit(submission(capability))).outcome).toBe('delivered');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(1);
  }, 60_000);

  it('refuses workspace/application/destination substitution and identity fields without reflecting them', async () => {
    for (const field of forbiddenExchangeFields) {
      const result = await exchange(service, { [field]: canaries.identity });
      expect(result.ok).toBe(false);
      assertContentFree(await result.json(), Object.values(canaries));
    }
    const capability = await mint(service);
    const tampered = { ...capability, token: `${capability.token.slice(0, -8)}tampered` };
    expect((await service.submit(submission(tampered))).outcome).toBe('rejected');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
  }, 60_000);

  it.each(['tenantId', 'applicationId', 'destinationId'] as const)(
    'rejects a valid signed capability after trusted %s substitution',
    async field => {
      const original = await mint(service);
      await service.replaceAuthorizationContext({ [field]: `other-${field}` });
      expect((await service.submit(submission(original))).outcome).toBe('rejected');
      expect((await assertPrivate(service, [original.token])).attempts).toBe(0);
      // The service is still usable; rejection must be binding-specific, not a closed stub.
      const replacement = await mint(service);
      expect((await service.submit(submission(replacement))).outcome).toBe('delivered');
      expect((await assertPrivate(service, [original.token, replacement.token])).attempts).toBe(1);
    },
    60_000
  );

  it('fails closed for missing binding and exact-body byte/digest mutations', async () => {
    for (const field of ['submissionId', 'payloadDigest']) {
      expect((await exchange(service, { [field]: undefined })).ok).toBe(false);
    }
    for (const payloadDigest of bindings.invalidPayloadDigests) {
      expect((await exchange(service, { payloadDigest })).ok).toBe(false);
    }
    const capability = await mint(service);
    const bound = binding();
    for (const requestBody of [
      `${report} `,
      `${report}\n`,
      JSON.stringify(JSON.parse(report), null, 2),
    ]) {
      expect((await service.submit(submission(capability, requestBody, bound))).outcome).toBe(
        'rejected'
      );
    }
    expect(
      (
        await service.submit(
          submission(capability, report, { ...bound, submissionId: 'different-submission' })
        )
      ).outcome
    ).toBe('rejected');
    expect((await assertPrivate(service, [capability.token])).attempts).toBe(0);
  }, 60_000);

  it('rejects malformed SDK version values without recording attacker-controlled metadata', async () => {
    const missing = capabilityHeaders();
    missing.delete('X-BugDrop-SDK-Version');
    expect((await exchange(service, {}, missing)).ok).toBe(false);
    for (const version of malformedSdkVersions) {
      const result = await exchange(
        service,
        {},
        capabilityHeaders({ 'X-BugDrop-SDK-Version': version })
      );
      expect(result.ok).toBe(false);
      assertContentFree(await result.json(), Object.values(canaries));
    }
    const capability = await mint(service);
    await service.submit(submission(capability));
    const evidence = await assertPrivate(service, [capability.token]);
    expect(evidence.sdkVersions).toContain('0.1.0');
    for (const version of malformedSdkVersions.filter(Boolean))
      expect(evidence.sdkVersions).not.toContain(version);
  }, 60_000);
});
