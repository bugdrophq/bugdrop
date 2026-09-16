import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canaries } from './attack-inputs';
import { startManaged, type ManagedAdapter } from './managed-adapter';
import { assertPrivate } from './managed-requests';

let service: ManagedAdapter;
beforeEach(async () => {
  service = await startManaged();
}, 60_000);
afterEach(async () => {
  await service?.close();
}, 60_000);

describe.sequential('actual adapter observer detects poisoned emissions before filtering', () => {
  it('keeps extra Worker response fields visible to the privacy oracle', async () => {
    const poisoned = { schemaVersion: 1, outcome: 'delivered', token: canaries.header };
    await service.probeCapture({ submissionResponse: poisoned });
    const evidence = await service.evidence();
    expect(evidence.submissionResponses).toContain(JSON.stringify(poisoned));
    await expect(assertPrivate(service)).rejects.toThrow();
  }, 60_000);

  it('keeps non-allowlisted SDK emissions visible to the privacy oracle', async () => {
    await service.probeCapture({ sdkReport: canaries.identity });
    const evidence = await service.evidence();
    expect(evidence.evidenceRequests.map(request => request.body)).toContain(canaries.identity);
    await expect(assertPrivate(service)).rejects.toThrow();
  }, 60_000);

  it.each(['header', 'url'] as const)(
    'detects SDK %s leakage even when the emitted version is valid',
    async sink => {
      await service.probeCapture({
        sdkReport: '0.1.0',
        sdkHeaders: {
          'content-type': 'text/plain;charset=UTF-8',
          'content-length': '5',
          host: 'evidence.bugdrop.localhost',
          ...(sink === 'header' ? { authorization: `Bearer ${canaries.header}` } : {}),
        },
        ...(sink === 'url'
          ? {
              sdkUrl: `http://evidence.bugdrop.localhost/sdk?url=${encodeURIComponent(canaries.url)}`,
            }
          : {}),
      });
      const evidence = await service.evidence();
      expect(evidence.evidenceRequests).toHaveLength(1);
      expect(evidence.evidenceRequests[0].body).toBe('0.1.0');
      expect(
        evidence.evidenceRequests[0][sink === 'header' ? 'unexpectedHeaders' : 'unexpectedUrl']
      ).toBe(true);
      await expect(assertPrivate(service)).rejects.toThrow();
    },
    60_000
  );
});
