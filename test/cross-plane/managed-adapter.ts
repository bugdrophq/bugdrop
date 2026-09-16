import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Binding {
  submissionId: string;
  payloadDigest: string;
}
export interface Capability {
  schemaVersion: 1;
  token: string;
  expiresAt: string;
}
export interface Outcome {
  schemaVersion: 1;
  outcome: 'delivered' | 'delivering' | 'indeterminate' | 'failed_before_delivery' | 'rejected';
}
export interface Evidence {
  attempts: number;
  outcomes: unknown[];
  submissionResponses: string[];
  evidenceRequests: Array<{
    body: string;
    headers: Record<string, string>;
    unexpectedHeaders: boolean;
    unexpectedUrl: boolean;
  }>;
  receipts: unknown[];
  logs: unknown[];
  sdkVersions: unknown[];
  networkRequests: unknown[];
  fakeGithubAttempts: unknown[];
  capabilities: { queues: string; analytics: string; logs: string; outbound: string };
}
export interface ManagedAdapter {
  endpoint: string;
  origin: string;
  submit(input: {
    capability: Capability;
    binding: Binding;
    requestBody: string | Uint8Array;
    origin?: string;
  }): Promise<Outcome>;
  advanceClock(ms: number): Promise<void>;
  refreshAuthorizationState(): Promise<void>;
  expireAuthorizationState(): Promise<void>;
  revoke(options?: {
    scope: 'credential' | 'application' | 'installation' | 'tenant';
  }): Promise<void>;
  setDeliveryMode(
    mode: 'delivered' | 'indeterminate' | 'timeout' | 'hold',
    options?: { canary?: string }
  ): Promise<void>;
  releaseDelivery(): Promise<void>;
  restart(): Promise<void>;
  evidence(): Promise<Evidence>;
  uninstall(options?: {
    validSignature?: boolean;
    installationId?: number;
    action?: string;
    event?: string;
    tamperBody?: boolean;
  }): Promise<unknown>;
  replaceAuthorizationContext(context: {
    tenantId?: string;
    applicationId?: string;
    destinationId?: string;
  }): Promise<void>;
  probeCapture(input: {
    submissionResponse?: unknown;
    sdkReport?: string;
    sdkHeaders?: Record<string, string>;
    sdkUrl?: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export function managedRoot(): string {
  return resolve(process.env.BUGDROP_MANAGED_TEST_ROOT ?? '.');
}

export async function startManaged(): Promise<ManagedAdapter> {
  const files = [
    'api-key-credential',
    'origin',
    'submission-binding',
    'capability-response',
    'capability-validation',
    'widget-public-api',
  ];
  const fixtures = Object.fromEntries(
    files.map(name => {
      const filename = `${name}.v1.json`;
      return [
        filename,
        JSON.parse(
          readFileSync(new URL(`../protocol/v1/fixtures/${filename}`, import.meta.url), 'utf8')
        ),
      ];
    })
  );
  // Explicit override permits testing the implementation worker's checkout before its PR lands.
  // Default CI always uses this repository's real adapter; a missing adapter is an error, never a skip.
  const path = resolve(managedRoot(), 'managed/local/adapter.mjs');
  const module = await import(/* @vite-ignore */ pathToFileURL(path).href);
  return module.start({ fixtures }) as Promise<ManagedAdapter>;
}
