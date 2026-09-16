import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { managedRoot } from './managed-adapter';
import { binding, capabilityHeaders, report, secretValues } from './attack-inputs';
import type { Binding, Capability, ManagedAdapter } from './managed-adapter';
import { assertContentFree } from './privacy';

export async function exchange(
  service: ManagedAdapter,
  overrides: Record<string, unknown> = {},
  headers = capabilityHeaders()
): Promise<Response> {
  return fetch(service.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ schemaVersion: 1, ...binding(), origin: service.origin, ...overrides }),
  });
}

export async function mint(
  service: ManagedAdapter,
  bound: Binding = binding()
): Promise<Capability> {
  const response = await exchange(service, { ...bound });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const capability = (await response.json()) as Capability;
  expect(capability.schemaVersion).toBe(1);
  expect(typeof capability.token).toBe('string');
  expect(capability.token.length).toBeGreaterThan(0);
  return capability;
}

export function submission(
  capability: Capability,
  requestBody = report,
  bound = binding(requestBody)
) {
  return { capability, binding: bound, requestBody };
}

export async function assertPrivate(service: ManagedAdapter, tokens: string[] = []) {
  const evidence = await service.evidence();
  for (const sink of [
    'outcomes',
    'submissionResponses',
    'evidenceRequests',
    'receipts',
    'logs',
    'sdkVersions',
    'networkRequests',
    'fakeGithubAttempts',
  ] as const) {
    expect(Array.isArray(evidence[sink]), `Missing observed sink: ${sink}`).toBe(true);
  }
  expect(evidence.networkRequests).toEqual([]);
  expect(evidence.fakeGithubAttempts).toHaveLength(evidence.attempts);
  expect(evidence.capabilities).toEqual({
    queues: 'absent-no-binding',
    analytics: 'absent-no-binding',
    logs: 'captured',
    outbound: 'denied-and-captured',
  });
  for (const role of ['ingress', 'delivery']) {
    const config = JSON.parse(
      readFileSync(resolve(managedRoot(), `managed/local/${role}.json`), 'utf8')
    );
    expect(config).not.toHaveProperty('queues');
    expect(config).not.toHaveProperty('analytics_engine_datasets');
    expect(config.observability).toEqual({ enabled: false });
  }
  const { submissionResponses, evidenceRequests, ...retained } = evidence;
  for (const text of submissionResponses) {
    const response = JSON.parse(text);
    assertContentFree(response, [...secretValues, ...tokens]);
    expect(Object.keys(response).sort()).toEqual(['outcome', 'schemaVersion']);
    expect(response.schemaVersion).toBe(1);
    expect([
      'delivered',
      'delivering',
      'indeterminate',
      'failed_before_delivery',
      'rejected',
    ]).toContain(response.outcome);
  }
  for (const request of evidenceRequests) {
    // This is the test observer's envelope, not persisted telemetry. Permit only
    // the fixed SDK-version body and generated transport headers, never caller headers.
    expect(request.body).toBe('0.1.0');
    expect(request.unexpectedHeaders).toBe(false);
    expect(request.unexpectedUrl).toBe(false);
    expect(request.headers).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
      'content-length': '5',
      host: 'evidence.bugdrop.localhost',
    });
  }
  assertContentFree(retained, [...secretValues, ...tokens]);
  return evidence;
}
