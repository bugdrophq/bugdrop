import { describe, expect, it } from 'vitest';
import { assertEvidence } from './evidence.mjs';

// Explicit synthetic oracle input; no provider observation is claimed by these unit tests.
const expected = {
  environment: 'staging',
  serviceRevision: 'a'.repeat(40),
  deploymentDigest: 'b'.repeat(64),
  repositoryId: '404',
  runId: 'ad51c858-77ce-4ba2-b806-8fbf07924ace',
  scenario: 'duplicate',
  sdkVersion: '0.1.0',
  exchangeCount: 1,
  submissionOutcomes: ['delivered', 'delivered'],
  attempts: 1,
};
const forbiddenValues = ['synthetic-private-canary', 'private-submission-id'];
function fixture() {
  const receipt = { state: 'delivered', attempts: 1, expiresAt: 1_800_000_000_000 };
  const observed = (provider: string, records: unknown[]) => ({
    status: 'observed',
    provider,
    runId: expected.runId,
    complete: true,
    records,
  });
  const disabled = () => ({
    ...observed('cloudflare-configuration', [{ bindingCount: 0, exportEnabled: false }]),
    status: 'disabled',
  });
  return {
    schemaVersion: 1,
    environment: expected.environment,
    serviceRevision: expected.serviceRevision,
    deploymentDigest: expected.deploymentDigest,
    repositoryId: expected.repositoryId,
    runId: expected.runId,
    scenario: expected.scenario,
    exchanges: [{ sequence: 1, sdkVersion: '0.1.0', status: 200 }],
    submissions: [
      { sequence: 1, outcome: 'delivered' },
      { sequence: 2, outcome: 'delivered' },
    ],
    attempts: 1,
    receipts: [receipt],
    sources: {
      deployment: observed('cloudflare-api', [
        {
          serviceRevision: expected.serviceRevision,
          deploymentDigest: expected.deploymentDigest,
          environment: 'staging',
        },
      ]),
      logs: observed('cloudflare-api', []),
      storage: observed('cloudflare-api', [receipt]),
      analytics: disabled(),
      queues: disabled(),
      github: observed('github-rest', [
        { repositoryId: '404', issueCountBefore: 0, issueCountAfter: 1 },
      ]),
    },
  };
}
describe('remote evidence oracle mutations (synthetic, not remote proof)', () => {
  it.each(['', 'garbage', '0.1.1', 'https://private.invalid'])(
    'rejects unsupported SDK pin %s',
    sdkVersion => {
      const evidence = fixture();
      evidence.exchanges[0].sdkVersion = sdkVersion;
      expect(() =>
        assertEvidence({ evidence, expected: { ...expected, sdkVersion }, forbiddenValues })
      ).toThrow('staging_evidence_rejected');
    }
  );
  it.each(['failed_before_delivery', 'indeterminate', 'delivering'])(
    'rejects durable %s contradicting delivered replay responses',
    state => {
      const evidence = fixture();
      evidence.receipts[0].state = state;
      expect(() => assertEvidence({ evidence, expected, forbiddenValues })).toThrow(
        'staging_evidence_rejected'
      );
    }
  );
  it('accepts the exact complete contract', () => {
    expect(assertEvidence({ evidence: fixture(), expected, forbiddenValues })).toBe(true);
  });
  it('rejects a failed exchange when the scenario requires successful issuance', () => {
    const evidence = fixture();
    evidence.exchanges[0].status = 503;
    expect(() =>
      assertEvidence({
        evidence,
        expected: { ...expected, exchangeSuccesses: [true] },
        forbiddenValues,
      })
    ).toThrow('staging_evidence_rejected');
  });
  it.each(['logs', 'storage', 'analytics', 'queues'] as const)(
    'rejects private bytes in %s',
    sink => {
      const evidence = fixture();
      evidence.sources[sink].records.push({ leaked: forbiddenValues[0] });
      expect(() => assertEvidence({ evidence, expected, forbiddenValues })).toThrow(
        'staging_evidence_rejected'
      );
    }
  );
  it.each(['deployment', 'logs', 'storage', 'analytics', 'queues', 'github'] as const)(
    'rejects missing or incomplete %s',
    sink => {
      const evidence = fixture();
      evidence.sources[sink].complete = false;
      expect(() => assertEvidence({ evidence, expected, forbiddenValues })).toThrow(
        'staging_evidence_rejected'
      );
    }
  );
  it.each(['revision', 'digest', 'repository', 'run', 'count', 'order', 'attempts', 'github'])(
    'rejects mismatched %s evidence',
    field => {
      const evidence = fixture();
      if (field === 'revision') evidence.serviceRevision = 'c'.repeat(40);
      if (field === 'digest') evidence.deploymentDigest = 'd'.repeat(64);
      if (field === 'repository') evidence.repositoryId = '999';
      if (field === 'run') evidence.runId = 'ad51c858-77ce-4ba2-b806-8fbf07924ac0';
      if (field === 'count')
        evidence.exchanges.push({ sequence: 2, sdkVersion: '0.1.0', status: 200 });
      if (field === 'order') evidence.submissions[0].sequence = 2;
      if (field === 'attempts') evidence.attempts++;
      if (field === 'github')
        evidence.sources.github.records = [
          { repositoryId: '404', issueCountBefore: 0, issueCountAfter: 2 },
        ];
      expect(() => assertEvidence({ evidence, expected, forbiddenValues })).toThrow(
        'staging_evidence_rejected'
      );
    }
  );
  it('does not expose rejected evidence in errors', () => {
    const evidence = fixture();
    evidence.sources.logs.records.push({ secret: forbiddenValues[0] });
    try {
      assertEvidence({ evidence, expected, forbiddenValues });
    } catch (error) {
      expect(String(error)).toBe('Error: staging_evidence_rejected');
    }
  });
});
