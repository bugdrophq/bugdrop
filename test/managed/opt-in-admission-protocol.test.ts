import { expect, it, vi } from 'vitest';
import { Admission } from '../../src/managed/opt-in/admission';
import type { AdmissionStore } from '../../src/managed/opt-in/admission-store';
import { PendingWork, type OriginalDelivery } from '../../src/managed/opt-in/pending-work';
import { verifySubmission } from '../../src/managed/opt-in/verifier';
import {
  hex,
  parseIntent,
  intentDigest,
  capabilityDigest,
  confirmationBytes,
  strictJson,
  bytes,
  utf8,
  type Confirmation,
} from '../../src/managed/opt-in/protocol';
// Exact synthetic fixture subset from frozen SDK e263209; SHA256 68d8c9dbd0bc4c99ec32607ebebe8463cfb92716af54c711b594ce677e23c7e7.
const fixture = {
  request: {
    schemaVersion: 2,
    intent: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      issuedAt: 1800000000000,
      expiresAt: 1800000060000,
      submissionId: 'fixture-submission',
      payloadDigest: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      applicationId: 'app_fixture',
      credentialId: '22222222-2222-4222-8222-222222222222',
      keyId: 'ICEiIyQlJicoKSorLC0uLw',
      installationGeneration: '33333333-3333-4333-8333-333333333333',
      endpoint: 'https://issuance.example.test/v2/submission-capabilities',
      deploymentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      catalogDigest: 'd3ac8a92c537d29b53f4d4fe6a8a73a5358997cda02ab25b76f61fa4304e6995',
      origin: 'https://customer.example.test',
      serverSdkVersion: '0.1.0',
      browserSdkVersion: '0.2.0',
      normalizedVersions: {
        sdkVersion: '0.1.0',
        browserSdkVersion: '0.2.0',
        widgetVersion: null,
        protocolVersion: 2,
      },
    },
  },
  intentDigest: 'c3e655f1b1171a2ed53c49bf7417eb9bed4ed9bebfa8848273e4c3d29515a3c3',
  response: {
    schemaVersion: 2,
    capability: {
      schemaVersion: 1,
      token:
        'eyJhbGciOiJFUzI1NiIsImtpZCI6ImNhcC12Mi1maXh0dXJlIiwidHlwIjoiYnVnZHJvcC1tYW5hZ2VkLWNhcGFiaWxpdHktdjIifQ.eyJwcm90b2NvbFZlcnNpb24iOjIsImlzcyI6ImJ1Z2Ryb3AtbWFuYWdlZC1zdGFnaW5nLXYyIiwiYXVkIjoiYnVnZHJvcC1tYW5hZ2VkLXN0YWdpbmctaW5ncmVzcy12MiIsInB1YmxpY0FwcGxpY2F0aW9uSWQiOiJhcHBfZml4dHVyZSIsImp0aSI6Ijg4ODg4ODg4LTg4ODgtNDg4OC04ODg4LTg4ODg4ODg4ODg4OCIsImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMzAwfQ.1EdercTG-1vM0nRoVneDcfoFbu0xId_oKZjMfYInCZna6GwuRlEW_a72O4baekU-yneOUPoA7w67lAvCiftTaw',
      expiresAt: '2027-01-15T08:05:00.000Z',
    },
    confirmation: {
      schemaVersion: 2,
      kid: 'fixture-confirmation',
      intentDigest: 'c3e655f1b1171a2ed53c49bf7417eb9bed4ed9bebfa8848273e4c3d29515a3c3',
      capabilityDigest: 'a35e2871234d980498d80ff91d454ec513b603a48448e55eda189aa16f3301c7',
      reservedAt: 1800000000000,
      retentionDeadline: 1802592000000,
      admittedAt: 1800000001000,
      expiresAt: 1800000060000,
      signature:
        'Y8iloxQP-ixoCp6V4yLxjpuMDh9TfcolJLLkl-hUYGUjlbkkt7FhpXt7R2IX3c2r8gZ4ACLbRpzDV7hl4Rk7pA',
    },
  },
  confirmationPublicKey: {
    kty: 'EC',
    crv: 'P-256',
    x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
    y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
  },
} as const;

it('matches frozen intent/capability commitments and confirmation signature bytes', async () => {
  const intent = parseIntent(utf8(JSON.stringify(fixture.request)), '0.1.0');
  expect(await intentDigest(intent)).toBe(fixture.intentDigest);
  expect(await capabilityDigest(fixture.response.capability)).toBe(
    fixture.response.confirmation.capabilityDigest
  );
  const key = await crypto.subtle.importKey(
    'jwk',
    fixture.confirmationPublicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(fixture.response.confirmation.signature, 64),
      confirmationBytes(fixture.response.confirmation as Confirmation)
    )
  ).toBe(true);
});
it.each([
  '{"schemaVersion":2,"schemaVersion":2}',
  '{"schemaVersion":2,"\\u0073chemaVersion":2}',
  '{"schemaVersion":2e0}',
  '{"schemaVersion":-0}',
  '{"schemaVersion":2.0}',
  '\ufeff{}',
  '{}trailing',
  '{"a":"\\ud800"}',
  '{"a":[[[[]]]]}',
])('rejects malformed wire lexemes %s', raw => {
  expect(() => strictJson(utf8(raw))).toThrow();
});
it('rejects malformed UTF8 and bounds body before JSON parsing', () => {
  expect(() => strictJson(new Uint8Array([0xff]))).toThrow();
  expect(() => strictJson(utf8('{}' + ' '.repeat(32767)))).toThrow();
  expect(strictJson(utf8('{}' + ' '.repeat(32766)))).toEqual({});
});
it('accepts paired astral strings without normalization and hashes semantic field order', async () => {
  const raw = JSON.stringify({
    ...fixture.request,
    intent: { ...fixture.request.intent, submissionId: 'astral 🦋 e\u0301' },
  });
  const parsed = parseIntent(utf8(raw), '0.1.0');
  expect(parsed.submissionId).toBe('astral 🦋 e\u0301');
  const reversed = {
    ...fixture.request,
    intent: Object.fromEntries(Object.entries(fixture.request.intent).reverse()),
  };
  expect(await intentDigest(parseIntent(utf8(JSON.stringify(reversed)), '0.1.0'))).toBe(
    fixture.intentDigest
  );
});

it('default unpublished core cannot reserve, and unknown ledger cannot join or verify', async () => {
  const reserve = vi.fn(),
    read = vi.fn(() => undefined);
  const store = { assertUnrevoked: vi.fn(), reserve, read } as unknown as AdmissionStore;
  const result = await new Admission(store).issue({
    raw: utf8(JSON.stringify(fixture.request)),
    authorization: '',
    mac: '',
    serverVersion: '0.1.0',
  });
  expect(result).toEqual({ ok: false, error: 'temporarily_unavailable' });
  expect(reserve).not.toHaveBeenCalled();
  const delivery = vi.fn(async (): Promise<OriginalDelivery | undefined> => undefined);
  await expect(new PendingWork(store).join('missing', delivery)).rejects.toThrow();
  expect(delivery).not.toHaveBeenCalled();
  read.mockClear();
  await expect(
    verifySubmission(
      fixture.response.capability,
      { submissionId: 'test', payloadDigest: '', origin: 'https://example.test' },
      utf8(''),
      store,
      () => undefined
    )
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('matches the frozen catalog digest without treating it as production publication', async () => {
  expect(
    await hex(
      'bugdrop:version-catalog:v1\0',
      JSON.stringify([1, 1, ['0.1.0'], ['0.1.0', '0.2.0'], []])
    )
  ).toBe(fixture.request.intent.catalogDigest);
});
