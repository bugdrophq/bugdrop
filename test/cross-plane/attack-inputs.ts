import { createHash } from 'node:crypto';
import credential from '../protocol/v1/fixtures/api-key-credential.v1.json';

export const canaries = {
  content: 'private-report-content-canary-814',
  url: 'https://private-page.example/settings?secret=canary-814',
  identity: 'private-reporter-canary-814@example.test',
  header: 'private-header-canary-814',
  github: 'private-github-response-canary-814',
  submission: 'private-submission-canary-814',
} as const;

export const report = JSON.stringify({
  message: canaries.content,
  page: canaries.url,
  diagnostic: canaries.identity,
});

export function binding(requestBody = report, submissionId: string = canaries.submission) {
  return {
    submissionId,
    payloadDigest: createHash('sha256').update(requestBody).digest('base64url'),
  };
}

export function capabilityHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    Authorization: credential.authorization,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.bugdrop.submission-capability.v1+json',
    'X-BugDrop-Contract-Version': '1',
    'X-BugDrop-SDK-Version': '0.1.0',
    ...overrides,
  });
}

export const forbiddenExchangeFields = [
  'tenantId',
  'workspaceId',
  'appId',
  'applicationId',
  'destinationId',
  'installationId',
  'repository',
  'subject',
  'sub',
  'userId',
  'reporterId',
  'pseudonym',
  'email',
  'metadata',
] as const;

export const malformedSdkVersions = [
  '',
  'unknown-private-header-canary-814',
  '1',
  '1.2',
  'v1.2.3',
  'https://private-page.example/sdk',
  'Bearer private-header-canary-814',
  '1.2.3 '.repeat(100),
];

export const secretValues = [
  ...Object.values(canaries),
  credential.apiKey,
  credential.rootSecret,
  credential.authSecret,
  credential.authorization,
];
