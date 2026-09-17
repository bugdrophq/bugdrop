import { createHash, randomUUID } from 'node:crypto';
import { assertEvidence } from './evidence.mjs';

const check = value => {
  if (!value) throw new Error('staging_safety_failed');
};
const delivered = response => response?.schemaVersion === 1 && response.outcome === 'delivered';
const rejected = response => response?.schemaVersion === 1 && response.outcome === 'rejected';
const uncertain = response => response?.schemaVersion === 1 && response.outcome === 'indeterminate';

/** Provider actions must use real approved staging resources; absence is a hard prerequisite error. */
export async function runScenario(service, scenario, target) {
  const reportBody = JSON.stringify({
    message: `staging-content-${randomUUID()}`,
    page: `https://private.invalid/${randomUUID()}`,
    diagnostic: `staging-private-${randomUUID()}`,
  });
  const submissionId = randomUUID();
  const binding = {
    submissionId,
    payloadDigest: createHash('sha256').update(reportBody).digest('base64url'),
  };
  let exchangeCount = 0;
  const exchangeSuccesses = [];
  const outcomes = [];
  const capabilities = [];
  const mint = async (origin = target.origin, shouldSucceed = true) => {
    exchangeCount++;
    exchangeSuccesses.push(shouldSucceed);
    const capability = await service.mint({ binding, origin });
    if (shouldSucceed) {
      check(capability !== null && typeof capability === 'object' && !Array.isArray(capability));
      check(Object.keys(capability).sort().join('|') === 'expiresAt|schemaVersion|token');
      check(
        capability.schemaVersion === 1 &&
          typeof capability.token === 'string' &&
          capability.token.length > 0
      );
      check(
        typeof capability.expiresAt === 'string' && Date.parse(capability.expiresAt) > Date.now()
      );
    } else check(capability === null);
    if (capability?.token) capabilities.push(capability.token);
    return capability;
  };
  const submit = async capability => {
    const result = await service.submit({ capability, binding, reportBody, origin: target.origin });
    check(result !== null && typeof result === 'object' && !Array.isArray(result));
    check(Object.keys(result).sort().join('|') === 'outcome|schemaVersion');
    check(
      result.schemaVersion === 1 &&
        ['delivering', 'delivered', 'indeterminate', 'failed_before_delivery', 'rejected'].includes(
          result.outcome
        )
    );
    outcomes.push(result?.outcome);
    return result;
  };
  let attempts = 0;
  if (scenario === 'duplicate-concurrent') {
    const first = await mint();
    const second = await mint();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => submit(i % 2 ? first : second))
    );
    check(results.every(result => delivered(result) || result?.outcome === 'delivering'));
    check(delivered(await submit(first)));
    attempts = 1;
  } else if (scenario === 'timeout-after-dispatch') {
    await service.injectFault('timeout-after-dispatch');
    const capability = await mint();
    check(uncertain(await submit(capability)));
    await service.restart();
    check(uncertain(await submit(await mint())));
    attempts = 1;
  } else if (scenario === 'restart-after-dispatch') {
    await service.injectFault('hold-after-dispatch');
    const capability = await mint();
    const pending = submit(capability);
    await service.waitForDispatch();
    await service.restart();
    check(uncertain(await pending));
    check(uncertain(await submit(capability)));
    attempts = 1;
  } else if (scenario === 'stale-authorization') {
    const capability = await mint();
    await service.expireAuthorization();
    check(rejected(await submit(capability)));
    check((await mint(target.origin, false)) === null);
  } else if (scenario.startsWith('substitute-')) {
    const capability = await mint();
    const field = scenario.slice('substitute-'.length);
    check(['tenantId', 'applicationId', 'destinationId'].includes(field));
    await service.substituteTrustedContext(field);
    check(rejected(await submit(capability)));
  } else if (scenario === 'origin-aliases') {
    await mint();
    const url = new URL(target.origin);
    const aliases = [
      target.origin.replace(url.hostname, `${url.hostname}.`),
      `https://${url.hostname}:443`,
      `https://${url.hostname.toUpperCase()}`,
      `${target.origin}/`,
    ];
    for (const alias of aliases)
      if (alias !== target.origin) check((await mint(alias, false)) === null);
  } else if (scenario.startsWith('revoke-')) {
    const capability = await mint();
    const scope = scenario.slice('revoke-'.length);
    check(['credential', 'application', 'tenant'].includes(scope));
    await service.revoke(scope);
    await service.restart();
    check(rejected(await submit(capability)));
    check((await mint(target.origin, false)) === null);
  } else if (scenario === 'retention-deletion') {
    // Provider seeds only isolated, content-free receipts, never alters the production TTL.
    const before = await service.seedRetentionFixtures();
    check(before.expiredCount === 1 && before.unexpiredCount === 1);
    await service.runNativeRetentionAlarm();
    const after = await service.readRetentionFixtures();
    check(after.expiredCount === 0 && after.unexpiredCount === 1 && after.schemaPresent === true);
    await service.runNativeRetentionAlarm();
    const repeated = await service.readRetentionFixtures();
    check(
      repeated.expiredCount === 0 &&
        repeated.unexpiredCount === 1 &&
        repeated.schemaPresent === true
    );
  } else if (scenario === 'uninstall') {
    const capability = await mint();
    await service.uninstallApprovedInstallation();
    await service.waitForSignedUninstall();
    await service.restart();
    check(rejected(await submit(capability)));
    check((await mint(target.origin, false)) === null);
    // Edge rejection is necessary but does not prove authoritative SQL cleanup.
    // No approved durable intake/dual-ack observer contract exists in this tranche.
    throw new Error('staging_uninstall_completion_unavailable');
  } else {
    throw new Error('staging_scenario_unavailable');
  }
  const evidence = await service.evidence();
  assertEvidence({
    evidence,
    expected: {
      ...target,
      scenario,
      exchangeCount,
      exchangeSuccesses,
      submissionOutcomes: outcomes,
      attempts,
    },
    forbiddenValues: [
      reportBody,
      submissionId,
      ...Object.values(JSON.parse(reportBody)),
      ...capabilities,
      ...(await service.secretMarkers()),
    ],
  });
  return { scenario, passed: true };
}

export const scenarios = Object.freeze([
  'duplicate-concurrent',
  'timeout-after-dispatch',
  'restart-after-dispatch',
  'stale-authorization',
  'substitute-tenantId',
  'substitute-applicationId',
  'substitute-destinationId',
  'origin-aliases',
  'revoke-credential',
  'revoke-application',
  'revoke-tenant',
  'retention-deletion',
  'uninstall',
]);

export async function runRemoteSafety(provider, approvedTarget) {
  check(approvedTarget.environment === 'staging' && approvedTarget.approved === true);
  check(approvedTarget.sdkVersion === '0.1.0');
  check(/^[0-9a-f]{40}$/.test(approvedTarget.serviceRevision));
  check(/^[0-9a-f]{64}$/.test(approvedTarget.deploymentDigest));
  check(/^[1-9][0-9]*$/.test(approvedTarget.repositoryId));
  const origin = new URL(approvedTarget.origin);
  check(
    origin.protocol === 'https:' &&
      origin.origin === approvedTarget.origin &&
      !origin.hostname.endsWith('.')
  );
  // inspectTarget must be read-only and obtain authoritative deployment/repository identity.
  const observed = await provider.inspectTarget();
  for (const key of [
    'environment',
    'serviceRevision',
    'deploymentDigest',
    'repositoryId',
    'origin',
    'sdkVersion',
  ]) {
    check(observed[key] === approvedTarget[key]);
  }
  check(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      observed.runId
    )
  );
  const results = [];
  for (const scenario of scenarios) {
    const service = await provider.startScenario({ scenario, runId: observed.runId });
    try {
      results.push(
        await runScenario(service, scenario, { ...approvedTarget, runId: observed.runId })
      );
    } finally {
      await service.close();
    }
  }
  return results;
}
