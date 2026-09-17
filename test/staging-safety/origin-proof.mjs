const check = value => {
  if (!value) throw new Error('staging_origin_proof_rejected');
};
const exact = (value, fields) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).sort().join('|') === [...fields].sort().join('|'));
};
function counter(value, target) {
  exact(value, ['runId', 'scenario', 'applicationId', 'count', 'complete', 'exclusive']);
  check(
    value.runId === target.runId &&
      value.scenario === 'origin-aliases' &&
      value.applicationId === target.applicationId
  );
  check(
    value.complete === true &&
      value.exclusive === true &&
      Number.isSafeInteger(value.count) &&
      value.count >= 0
  );
  // Copy immediately: a collector must not mutate an earlier snapshot in place.
  return Object.freeze({ ...value });
}
export async function proveOrigins(service, target, binding, mint) {
  check(typeof service.readExchangeCount === 'function');
  const url = new URL(target.origin);
  const aliases = [
    target.origin.replace(url.hostname, `${url.hostname}.`),
    `https://${url.hostname}:443`,
    target.origin.replace(url.hostname, url.hostname.toUpperCase()),
    `${target.origin}/`,
  ].filter(alias => alias !== target.origin);
  const checks = [];
  let lastCount = 1; // The configured-origin baseline issued exactly once.
  async function httpDenied(origin) {
    const before = counter(await service.readExchangeCount(), target);
    check(before.count === lastCount);
    check((await mint(origin, false)) === null);
    const after = counter(await service.readExchangeCount(), target);
    check(after.count === before.count + 1);
    return { outcome: 'http_denied', networkAttempts: 1, before, after };
  }
  for (const alias of aliases) {
    let proof;
    if (typeof service.rejectInvalidOrigin === 'function') {
      const value = await service.rejectInvalidOrigin({ binding, origin: alias });
      exact(value, ['outcome', 'networkAttempts', 'before', 'after']);
      const before = counter(value.before, target),
        after = counter(value.after, target);
      check(value.outcome === 'client_validation_rejected' && value.networkAttempts === 0);
      check(before.count === lastCount && after.count === before.count);
      proof = { outcome: value.outcome, networkAttempts: 0, before, after };
    } else proof = await httpDenied(alias);
    checks.push({ index: checks.length, ...proof });
    lastCount = proof.after.count;
  }
  const wrong =
    target.origin === 'https://wrong-origin.invalid'
      ? 'https://other-origin.invalid'
      : 'https://wrong-origin.invalid';
  const proof = await httpDenied(wrong);
  checks.push({ index: checks.length, ...proof });
  return checks;
}
