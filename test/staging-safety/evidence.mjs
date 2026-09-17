/** Remote evidence contract. Synthetic tests of this oracle are not remote attestations. */
const fail = () => {
  throw new Error('staging_evidence_rejected');
};
const requireThat = value => {
  if (!value) fail();
};
const object = value => {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
  );
  return value;
};
const exactKeys = (value, keys) => {
  object(value);
  requireThat(Object.keys(value).sort().join('|') === [...keys].sort().join('|'));
};
const same = (left, right) => requireThat(JSON.stringify(left) === JSON.stringify(right));
const forbiddenKeys =
  /^(body|payload|rawBody|requestBody|headers|authorization|token|apiKey|authSecret|rootSecret|privateKey|subject|sub|userId|reporterId|reporter|email|pseudonym|ip|submissionId|pageUrl|issueUrl|html_url|stack|exception)$/i;

function privateBytesAbsent(value, forbiddenValues) {
  const markers = forbiddenValues.flatMap(value => {
    requireThat(typeof value === 'string' && value.length > 0);
    return [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
  });
  const seen = new WeakSet();
  function visit(item, depth = 0) {
    requireThat(depth < 32);
    if (typeof item === 'string') {
      requireThat(
        !/https?:\/\/|Bearer\s|bd_api_v1\.|bd_auth_v1\.|-----BEGIN .*PRIVATE KEY-----/i.test(item)
      );
      for (const marker of markers) requireThat(!item.includes(marker));
    } else if (item !== null && typeof item === 'object') {
      requireThat(!seen.has(item));
      seen.add(item);
      if (!Array.isArray(item)) object(item);
      for (const key of Object.getOwnPropertyNames(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        requireThat(!forbiddenKeys.test(key));
        visit(key, depth + 1);
        visit(item[key], depth + 1);
      }
      seen.delete(item);
    } else {
      requireThat(
        item === null ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
      );
    }
  }
  visit(value);
}

export function assertEvidence({ evidence, expected, forbiddenValues }) {
  requireThat(Array.isArray(forbiddenValues) && forbiddenValues.length > 0);
  privateBytesAbsent(evidence, forbiddenValues);
  exactKeys(evidence, [
    'schemaVersion',
    'environment',
    'serviceRevision',
    'deploymentDigest',
    'repositoryId',
    'runId',
    'scenario',
    'exchanges',
    'submissions',
    'attempts',
    'receipts',
    'sources',
  ]);
  requireThat(evidence.schemaVersion === 1 && evidence.environment === 'staging');
  requireThat(expected.environment === 'staging');
  requireThat(/^[0-9a-f]{40}$/.test(expected.serviceRevision));
  requireThat(/^[0-9a-f]{64}$/.test(expected.deploymentDigest));
  requireThat(/^[1-9][0-9]*$/.test(expected.repositoryId));
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      expected.runId
    )
  );
  for (const key of [
    'environment',
    'serviceRevision',
    'deploymentDigest',
    'repositoryId',
    'runId',
    'scenario',
  ]) {
    requireThat(evidence[key] === expected[key]);
  }
  requireThat(
    Array.isArray(evidence.exchanges) && evidence.exchanges.length === expected.exchangeCount
  );
  evidence.exchanges.forEach((exchange, index) => {
    exactKeys(exchange, ['sequence', 'sdkVersion', 'status']);
    requireThat(exchange.sequence === index + 1 && exchange.sdkVersion === expected.sdkVersion);
    requireThat(
      Number.isInteger(exchange.status) && exchange.status >= 200 && exchange.status <= 599
    );
    if (expected.exchangeSuccesses !== undefined) {
      requireThat(
        Array.isArray(expected.exchangeSuccesses) &&
          expected.exchangeSuccesses.length === expected.exchangeCount
      );
      requireThat(typeof expected.exchangeSuccesses[index] === 'boolean');
      requireThat(
        expected.exchangeSuccesses[index]
          ? exchange.status >= 200 && exchange.status < 300
          : exchange.status >= 400
      );
    }
  });
  requireThat(Array.isArray(evidence.submissions));
  same(
    evidence.submissions,
    expected.submissionOutcomes.map((outcome, index) => ({ sequence: index + 1, outcome }))
  );
  requireThat(Number.isInteger(expected.attempts) && expected.attempts >= 0);
  requireThat(evidence.attempts === expected.attempts);
  requireThat(Array.isArray(evidence.receipts));
  for (const receipt of evidence.receipts) {
    exactKeys(receipt, ['state', 'attempts', 'expiresAt']);
    requireThat(
      ['delivering', 'delivered', 'indeterminate', 'failed_before_delivery'].includes(receipt.state)
    );
    requireThat(receipt.attempts === 0 || receipt.attempts === 1);
    if (receipt.state === 'failed_before_delivery') requireThat(receipt.attempts === 0);
    if (receipt.state === 'delivered') requireThat(receipt.attempts === 1);
    requireThat(Number.isSafeInteger(receipt.expiresAt) && receipt.expiresAt > 0);
  }
  requireThat(
    evidence.receipts.reduce((count, receipt) => count + receipt.attempts, 0) === expected.attempts
  );
  // Each scenario is scoped to one logical report. Successful replay responses must
  // agree with the final durable row, not merely with a separate attempt counter.
  const finalState = expected.submissionOutcomes.findLast(outcome =>
    ['delivered', 'indeterminate', 'failed_before_delivery'].includes(outcome)
  );
  if (finalState !== undefined) {
    requireThat(evidence.receipts.length === 1 && evidence.receipts[0].state === finalState);
  }
  exactKeys(evidence.sources, ['deployment', 'logs', 'storage', 'analytics', 'queues', 'github']);
  for (const name of ['deployment', 'logs', 'storage', 'analytics', 'queues', 'github']) {
    const source = evidence.sources[name];
    exactKeys(source, ['status', 'provider', 'runId', 'complete', 'records']);
    requireThat(
      source.runId === expected.runId && source.complete === true && Array.isArray(source.records)
    );
    const disabled = source.status === 'disabled';
    requireThat(disabled || source.status === 'observed');
    if (disabled) {
      requireThat(['logs', 'analytics', 'queues'].includes(name));
      requireThat(source.provider === 'cloudflare-configuration');
      same(source.records, [{ bindingCount: 0, exportEnabled: false }]);
    } else {
      requireThat(source.provider === (name === 'github' ? 'github-rest' : 'cloudflare-api'));
    }
  }
  same(evidence.sources.deployment.records, [
    {
      serviceRevision: expected.serviceRevision,
      deploymentDigest: expected.deploymentDigest,
      environment: 'staging',
    },
  ]);
  same(evidence.sources.storage.records, evidence.receipts);
  const github = evidence.sources.github.records;
  requireThat(github.length === 1);
  exactKeys(github[0], ['repositoryId', 'issueCountBefore', 'issueCountAfter']);
  requireThat(github[0].repositoryId === expected.repositoryId);
  requireThat(Number.isSafeInteger(github[0].issueCountBefore) && github[0].issueCountBefore >= 0);
  requireThat(
    Number.isSafeInteger(github[0].issueCountAfter) &&
      github[0].issueCountAfter >= github[0].issueCountBefore
  );
  const created = github[0].issueCountAfter - github[0].issueCountBefore;
  requireThat(created <= expected.attempts);
  if (expected.submissionOutcomes.includes('delivered')) requireThat(created === expected.attempts);
  return true;
}
