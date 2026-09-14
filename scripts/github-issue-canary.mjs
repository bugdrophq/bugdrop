#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  PREVIEW_CANARY_PROFILE,
  getCanaryProfile,
  isGitHubIssueUrlForRepository,
  validateCanarySelector,
} from './github-issue-canary-profiles.mjs';

export const CANARY_TITLE_PREFIX = PREVIEW_CANARY_PROFILE.titlePrefix;

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_LABELS = ['bug', 'bugdrop'];
const DEFAULT_AUTHOR = 'neonwatty-bugdrop[bot]';
const ATTRIBUTION_FOOTER = '*Submitted via [BugDrop](https://github.com/bugdrophq/bugdrop)*';
const LEGACY_PRODUCTION_ATTRIBUTION_FOOTER =
  '*Submitted via [BugDrop](https://github.com/mean-weasel/bugdrop)*';
const DEFAULT_CONSISTENCY_ATTEMPTS = 6;
const DEFAULT_CONSISTENCY_DELAY_MS = 2_000;
const MAX_CONSISTENCY_ATTEMPTS = 20;
const MAX_CONSISTENCY_DELAY_MS = 10_000;
const GITHUB_GET_RETRY_DELAYS_MS = [1_000, 2_000];

class GitHubRequestError extends Error {
  constructor(category, message, { retryable = false } = {}) {
    super(`${category}: ${message}`);
    this.name = 'GitHubRequestError';
    this.category = category;
    this.retryable = retryable;
  }
}

export function canaryTitle(marker, profileName = 'preview', environment = process.env) {
  requireNonempty(marker, 'marker');
  const { profile } = validateCanarySelector({
    profile: profileName,
    repo: getCanaryProfile(profileName, environment).repo,
    marker,
    environment,
  });
  return `${profile.titlePrefix} ${marker}`;
}

export async function listMatchingIssues({
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  repo,
  token,
  marker,
  prefix,
  state = marker ? 'all' : 'open',
  retrySleepImpl = sleep,
  profile = 'preview',
  profileEnvironment = process.env,
}) {
  const selector = validateCanarySelector({
    profile,
    repo,
    marker,
    prefix,
    environment: profileEnvironment,
  });
  const issues = await listRepositoryIssues({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    state,
    retrySleepImpl,
  });
  return issues.filter(candidate => {
    if (candidate.pull_request) return false;
    if (selector.marker) {
      return (
        candidate.title?.includes(selector.marker) || candidate.body?.includes(selector.marker)
      );
    }
    return candidate.title?.startsWith(selector.prefix);
  });
}

export async function verifyCanaryIssue({
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  repo,
  token,
  marker,
  expectedSha,
  result,
  expectedLabels,
  expectedAuthor,
  consistencyAttempts = DEFAULT_CONSISTENCY_ATTEMPTS,
  consistencyDelayMs = DEFAULT_CONSISTENCY_DELAY_MS,
  sleepImpl = sleep,
  retrySleepImpl = sleep,
  profile = 'preview',
  profileEnvironment = process.env,
}) {
  const target = validateCanarySelector({
    profile,
    repo,
    marker,
    expectedWorkerSha: expectedSha,
    environment: profileEnvironment,
  });
  const requiredAuthor = expectedAuthor ?? target.profile.expectedAuthor ?? DEFAULT_AUTHOR;
  const requiredLabels = expectedLabels ?? target.profile.expectedLabels ?? DEFAULT_LABELS;
  requireNonempty(expectedSha, 'expectedSha');
  const consistency = validateConsistencyOptions({
    consistencyAttempts,
    consistencyDelayMs,
    sleepImpl,
  });
  const referenceFailures = [];
  validateBrowserResultReference({
    failures: referenceFailures,
    result,
    marker,
    expectedSha,
    repo,
  });
  if (referenceFailures.length > 0) {
    throw new Error(`Browser result failed verification: ${referenceFailures.join('; ')}`);
  }

  const candidate = await getIssue({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    number: result.issueNumber,
    retrySleepImpl,
  });
  const matches = await waitForStableSingleton({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    marker,
    profile,
    profileEnvironment,
    consistency,
    retrySleepImpl,
  });
  const numbers = matches.map(candidate => candidate.number);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one non-PR Issue for marker ${marker}; found ${matches.length} (${formatNumbers(numbers)})`
    );
  }

  const canonicalUrl = candidate.html_url;
  const failures = [];
  if (matches[0].number !== candidate.number) {
    failures.push(
      `Marker listing found Issue #${matches[0].number}, not browser Issue #${candidate.number}`
    );
  }
  if (!Number.isInteger(candidate.number) || candidate.number <= 0) {
    failures.push('Issue number is not a positive integer');
  }
  if (!isGitHubIssueUrlForRepository(candidate.html_url, repo, candidate.number)) {
    failures.push('Issue URL is not canonical');
  }
  if (candidate.title !== `${target.profile.titlePrefix} ${marker}`) {
    failures.push('Issue title does not match exactly');
  }
  if (!candidate.body?.includes(`## Canary marker\n\n${marker}\n`)) {
    failures.push('Issue body lacks the exact structured Canary marker section and value');
  }
  if (!candidate.body?.includes(`<!-- bugdrop-submission: ${result.submissionId} -->`)) {
    failures.push('Issue body lacks the exact structured submission marker');
  }
  if (!candidate.body?.includes('<summary>System Info</summary>')) {
    failures.push('Issue body lacks System Info');
  }
  const hasCurrentAttribution = candidate.body?.includes(ATTRIBUTION_FOOTER);
  const hasDeployedProductionAttribution =
    profile === 'production' && candidate.body?.includes(LEGACY_PRODUCTION_ATTRIBUTION_FOOTER);
  if (!hasCurrentAttribution && !hasDeployedProductionAttribution) {
    failures.push('Issue body lacks BugDrop attribution');
  }
  if (candidate.body?.includes('## Screenshot')) failures.push('Issue contains a screenshot');
  if (candidate.state !== 'open') failures.push(`Issue state is ${candidate.state}, not open`);
  if (!sameGitHubLogin(candidate.user?.login, requiredAuthor)) {
    failures.push(`Issue author is ${candidate.user?.login ?? 'missing'}, not ${requiredAuthor}`);
  }
  const actualLabels = normalizeLabels(candidate.labels);
  if (!sameStringSet(actualLabels, requiredLabels)) {
    failures.push(
      `Issue labels are [${actualLabels.join(', ')}], not [${[...requiredLabels].sort().join(', ')}]`
    );
  }

  validateBrowserResult({ failures, result, marker, expectedSha, candidate, canonicalUrl });
  if (failures.length > 0) {
    throw new Error(
      `Canary Issue #${candidate.number} failed verification: ${failures.join('; ')}`
    );
  }
  return candidate;
}

export async function closeMatchingIssues({
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  repo,
  token,
  marker,
  prefix,
  consistencyAttempts = DEFAULT_CONSISTENCY_ATTEMPTS,
  consistencyDelayMs = DEFAULT_CONSISTENCY_DELAY_MS,
  sleepImpl = sleep,
  retrySleepImpl = sleep,
  profile = 'preview',
  profileEnvironment = process.env,
}) {
  const selector = validateCanarySelector({
    profile,
    repo,
    marker,
    prefix,
    environment: profileEnvironment,
  });
  const boundSelector = {
    marker: selector.marker,
    prefix: selector.prefix,
    profile: selector.profile.id,
    profileEnvironment,
  };
  const consistency = validateConsistencyOptions({
    consistencyAttempts,
    consistencyDelayMs,
    sleepImpl,
  });
  const matches = await waitForInitialCleanupMatches({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    ...boundSelector,
    state: marker ? 'all' : 'open',
    retrySleepImpl,
    consistency,
  });
  if (marker && matches.length === 0) {
    throw new Error(`No non-PR Issue for marker ${marker} appeared within the retry bound`);
  }
  const closedNumbers = [];
  const failures = [];

  for (const candidate of matches.filter(issue => issue.state === 'open')) {
    try {
      await closeOneIssue({
        fetchImpl,
        apiBaseUrl,
        repo,
        token,
        number: candidate.number,
        consistency,
        retrySleepImpl,
      });
      closedNumbers.push(candidate.number);
    } catch (error) {
      if (isImmediateMutationFailure(error)) throw error;
      failures.push(`#${candidate.number}: ${safeErrorMessage(error, token)}`);
    }
  }

  const finalMatches = await waitForZeroOpenMatches({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    ...boundSelector,
    state: 'open',
    retrySleepImpl,
    consistency,
  });
  const openNumbers = finalMatches
    .filter(candidate => candidate.state === 'open')
    .map(candidate => candidate.number);
  if (failures.length > 0 || openNumbers.length > 0) {
    const details = [
      ...failures,
      ...(openNumbers.length > 0
        ? [`still open after cleanup: ${formatNumbers(openNumbers)}`]
        : []),
    ];
    throw new Error(`Canary cleanup incomplete: ${details.join('; ')}`);
  }

  return {
    matchedNumbers: matches.map(candidate => candidate.number),
    closedNumbers,
    openNumbers,
  };
}

export async function observeCanaryDelivery({
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  repo,
  token,
  marker,
  expectedSha,
  result,
  attempted,
  feedbackPostObserved,
  expectedLabels,
  expectedAuthor,
  consistencyAttempts = DEFAULT_CONSISTENCY_ATTEMPTS,
  consistencyDelayMs = DEFAULT_CONSISTENCY_DELAY_MS,
  sleepImpl = sleep,
  retrySleepImpl = sleep,
  profile = 'preview',
  profileEnvironment = process.env,
  observedAt = new Date(),
}) {
  const timestamp = observedAt.toISOString();
  if (!attempted || !feedbackPostObserved) {
    return deliveryEvidence('inconclusive', 'browser_inconclusive', timestamp);
  }
  const target = validateCanarySelector({
    profile,
    repo,
    marker,
    expectedWorkerSha: expectedSha,
    environment: profileEnvironment,
  });
  requireNonempty(token, 'token');
  const consistency = validateConsistencyOptions({
    consistencyAttempts,
    consistencyDelayMs,
    sleepImpl,
  });
  const referenceFailures = [];
  validateBrowserResultReference({
    failures: referenceFailures,
    result,
    marker,
    expectedSha,
    repo,
  });
  if (referenceFailures.length > 0) {
    return deliveryEvidence('inconclusive', 'browser_inconclusive', timestamp);
  }
  try {
    const matches = await waitForStableEvidenceMatches({
      fetchImpl,
      apiBaseUrl,
      repo,
      token,
      marker,
      profile: target.profile.id,
      profileEnvironment,
      consistency,
      retrySleepImpl,
    });
    if (matches.length === 0) return deliveryEvidence('delivery_failed', 'issue_absent', timestamp);
    if (matches.length > 1) {
      return deliveryEvidence('delivery_failed', 'issue_duplicate', timestamp);
    }
    try {
      await verifyCanaryIssue({
        fetchImpl,
        apiBaseUrl,
        repo,
        token,
        marker,
        expectedSha,
        result,
        expectedLabels,
        expectedAuthor,
        consistencyAttempts,
        consistencyDelayMs,
        sleepImpl,
        retrySleepImpl,
        profile: target.profile.id,
        profileEnvironment,
      });
      return deliveryEvidence('verified', 'issue_verified', timestamp);
    } catch (error) {
      if (error instanceof GitHubRequestError) throw error;
      if (error instanceof Error && error.message.startsWith('Canary Issue #')) {
        return deliveryEvidence('delivery_failed', 'issue_contract_invalid', timestamp);
      }
      return deliveryEvidence('inconclusive', 'classification_failed', timestamp);
    }
  } catch (error) {
    return deliveryEvidence('inconclusive', githubEvidenceReason(error), timestamp);
  }
}

export async function runCli(
  argv,
  {
    fetchImpl = fetch,
    env = process.env,
    readFileImpl = readFile,
    stdout = value => process.stdout.write(`${value}\n`),
    stderr = value => process.stderr.write(`${value}\n`),
    consistencyAttempts = DEFAULT_CONSISTENCY_ATTEMPTS,
    consistencyDelayMs = DEFAULT_CONSISTENCY_DELAY_MS,
    sleepImpl = sleep,
  } = {}
) {
  const token = env.BUGDROP_CANARY_GITHUB_TOKEN;
  let profile = 'preview';
  try {
    const { command, options } = parseCliArguments(argv);
    profile = options.profile ?? 'preview';
    const selector = validateCanarySelector({
      profile,
      repo: options.repo,
      marker:
        command === 'verify' || command === 'evidence' || command === 'cleanup'
          ? options.marker
          : undefined,
      prefix: command === 'preflight' || command === 'sweep' ? options.prefix : undefined,
      environment: env,
    });
    requireNonempty(token, 'BUGDROP_CANARY_GITHUB_TOKEN');
    let output;
    if (command === 'verify') {
      requireNonempty(options.marker, '--marker');
      requireNonempty(options.resultFile, '--result-file');
      requireNonempty(options.expectedSha, '--expected-sha');
      const result = JSON.parse(await readFileImpl(options.resultFile, 'utf8'));
      const candidate = await verifyCanaryIssue({
        fetchImpl,
        repo: options.repo,
        token,
        marker: options.marker,
        expectedSha: options.expectedSha,
        result,
        profile: selector.profile.id,
        consistencyAttempts,
        consistencyDelayMs,
        sleepImpl,
        profileEnvironment: env,
      });
      output = { verified: true, issueNumber: candidate.number, issueUrl: candidate.html_url };
    } else if (command === 'evidence') {
      requireNonempty(options.marker, '--marker');
      requireNonempty(options.resultFile, '--result-file');
      requireNonempty(options.attemptFile, '--attempt-file');
      requireNonempty(options.postEvidenceFile, '--post-evidence-file');
      requireNonempty(options.evidenceFile, '--evidence-file');
      requireNonempty(options.expectedSha, '--expected-sha');
      let result;
      let attempted = false;
      let feedbackPostObserved = false;
      try {
        await readFileImpl(options.attemptFile, 'utf8');
        attempted = true;
      } catch {
        attempted = false;
      }
      try {
        await readFileImpl(options.postEvidenceFile, 'utf8');
        feedbackPostObserved = true;
      } catch {
        feedbackPostObserved = false;
      }
      try {
        result = JSON.parse(await readFileImpl(options.resultFile, 'utf8'));
      } catch {
        result = undefined;
      }
      output = await observeCanaryDelivery({
        fetchImpl,
        repo: options.repo,
        token,
        marker: options.marker,
        expectedSha: options.expectedSha,
        result,
        attempted,
        feedbackPostObserved,
        profile: selector.profile.id,
        consistencyAttempts,
        consistencyDelayMs,
        sleepImpl,
        profileEnvironment: env,
      });
      await writeFile(options.evidenceFile, `${JSON.stringify(output)}\n`, { mode: 0o600 });
    } else if (command === 'cleanup') {
      requireNonempty(options.marker, '--marker');
      output = await closeMatchingIssues({
        fetchImpl,
        repo: options.repo,
        token,
        marker: options.marker,
        profile: selector.profile.id,
        consistencyAttempts,
        consistencyDelayMs,
        sleepImpl,
        profileEnvironment: env,
      });
    } else if (command === 'preflight' || command === 'sweep') {
      requireNonempty(options.prefix, '--prefix');
      output = await closeMatchingIssues({
        fetchImpl,
        repo: options.repo,
        token,
        prefix: options.prefix,
        profile: selector.profile.id,
        consistencyAttempts,
        consistencyDelayMs,
        sleepImpl,
        profileEnvironment: env,
      });
    } else {
      throw new Error(`Unknown command: ${command || '(missing)'}`);
    }
    stdout(JSON.stringify(output));
    return 0;
  } catch (error) {
    stderr(
      profile === 'production'
        ? '[bugdrop-canary] operation_failed'
        : `[bugdrop-canary] ${safeErrorMessage(error, token)}`
    );
    return 1;
  }
}

async function listRepositoryIssues({ fetchImpl, apiBaseUrl, repo, token, state, retrySleepImpl }) {
  const { owner, name } = parseRepo(repo);
  requireNonempty(token, 'token');
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
    apiBaseUrl
  );
  if (state !== 'all' && state !== 'open') throw new Error('Issue listing state is invalid');
  url.searchParams.set('state', state);
  url.searchParams.set('per_page', '100');
  let nextUrl = url.toString();
  const issues = [];
  while (nextUrl) {
    const { response, data } = await requestJson({
      fetchImpl,
      url: nextUrl,
      token,
      retrySleepImpl,
    });
    if (!Array.isArray(data)) {
      throw new GitHubRequestError(
        'github_response_invalid',
        'GitHub Issues response was not an array'
      );
    }
    issues.push(...data);
    nextUrl = parseNextLink(response.headers.get('link'));
  }
  return issues;
}

async function closeOneIssue({
  fetchImpl,
  apiBaseUrl,
  repo,
  token,
  number,
  consistency,
  retrySleepImpl,
}) {
  let firstError;
  let firstConfirmedClosed = false;
  try {
    const result = await patchIssueClosed({ fetchImpl, apiBaseUrl, repo, token, number });
    firstConfirmedClosed = result?.state === 'closed';
  } catch (error) {
    if (!isAmbiguousMutationError(error)) throw error;
    firstError = error;
  }
  const afterFirst = await waitForClosedIssue({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    number,
    consistency,
    retrySleepImpl,
  });
  if (afterFirst.state === 'closed') return;
  if (afterFirst.state !== 'open') {
    throw new Error(
      `Close readback returned state ${afterFirst.state ?? 'missing'}${firstError ? `: ${safeErrorMessage(firstError, token)}` : ''}`
    );
  }
  if (firstConfirmedClosed) {
    throw new Error(
      'Close response reported closed but final readback stably proved the Issue open'
    );
  }

  let retryError;
  try {
    await patchIssueClosed({ fetchImpl, apiBaseUrl, repo, token, number });
  } catch (error) {
    if (!isAmbiguousMutationError(error)) throw error;
    retryError = error;
  }
  const afterRetry = await waitForClosedIssue({
    fetchImpl,
    apiBaseUrl,
    repo,
    token,
    number,
    consistency,
    retrySleepImpl,
  });
  if (afterRetry.state !== 'closed') {
    throw new Error(
      `Close retry failed and Issue remains ${afterRetry.state ?? 'unknown'}${retryError ? `: ${safeErrorMessage(retryError, token)}` : ''}`
    );
  }
}

async function waitForStableSingleton({ consistency, ...listOptions }) {
  let previousNumber;
  let lastMatches = [];
  for (let attempt = 1; attempt <= consistency.attempts; attempt += 1) {
    const matches = await listMatchingIssues(listOptions);
    lastMatches = matches;
    if (matches.length > 1) return matches;
    if (matches.length === 1 && matches[0].number === previousNumber) return matches;
    previousNumber = matches.length === 1 ? matches[0].number : undefined;
    await waitBeforeNextAttempt({ attempt, consistency });
  }
  if (lastMatches.length === 1) {
    throw new Error('Exactly-one marker discovery did not stabilize within the retry bound');
  }
  return lastMatches;
}

async function waitForStableEvidenceMatches({ consistency, ...listOptions }) {
  let previousSignature;
  let lastMatches = [];
  let sawNonempty = false;
  for (let attempt = 1; attempt <= consistency.attempts; attempt += 1) {
    const matches = await listMatchingIssues(listOptions);
    lastMatches = matches;
    if (matches.length > 0) sawNonempty = true;
    const signature = matches
      .map(candidate => candidate.number)
      .filter(Number.isInteger)
      .sort((left, right) => left - right)
      .join(',');
    if (signature && signature === previousSignature) return matches;
    previousSignature = signature;
    await waitBeforeNextAttempt({ attempt, consistency });
  }
  if (!sawNonempty) return lastMatches;
  throw new Error('Authoritative marker discovery did not stabilize within the retry bound');
}

async function waitForInitialCleanupMatches({ consistency, marker, prefix, ...listOptions }) {
  let matches = [];
  for (let attempt = 1; attempt <= consistency.attempts; attempt += 1) {
    matches = await listMatchingIssues({ ...listOptions, marker, prefix });
    if (matches.length > 0 || prefix) return matches;
    await waitBeforeNextAttempt({ attempt, consistency });
  }
  return matches;
}

async function waitForZeroOpenMatches({ consistency, ...listOptions }) {
  let matches = [];
  let consecutiveZeroOpenObservations = 0;
  for (let attempt = 1; attempt <= consistency.attempts; attempt += 1) {
    matches = await listMatchingIssues(listOptions);
    if (matches.every(candidate => candidate.state !== 'open')) {
      consecutiveZeroOpenObservations += 1;
      if (consecutiveZeroOpenObservations >= 2) return matches;
    } else {
      consecutiveZeroOpenObservations = 0;
    }
    await waitBeforeNextAttempt({ attempt, consistency });
  }
  if (matches.every(candidate => candidate.state !== 'open')) {
    throw new Error('Zero-open discovery did not stabilize within the retry bound');
  }
  return matches;
}

async function waitForClosedIssue({ consistency, ...issueOptions }) {
  let candidate;
  for (let attempt = 1; attempt <= consistency.attempts; attempt += 1) {
    candidate = await getIssue(issueOptions);
    if (candidate.state !== 'open') return candidate;
    await waitBeforeNextAttempt({ attempt, consistency });
  }
  return candidate;
}

async function waitBeforeNextAttempt({ attempt, consistency }) {
  if (attempt < consistency.attempts) await consistency.sleep(consistency.delayMs);
}

async function patchIssueClosed({ fetchImpl, apiBaseUrl, repo, token, number }) {
  return (
    await requestJson({
      fetchImpl,
      url: issueApiUrl(apiBaseUrl, repo, number),
      token,
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'not_planned' },
    })
  ).data;
}

async function getIssue({ fetchImpl, apiBaseUrl, repo, token, number, retrySleepImpl }) {
  return (
    await requestJson({
      fetchImpl,
      url: issueApiUrl(apiBaseUrl, repo, number),
      token,
      retrySleepImpl,
    })
  ).data;
}

async function requestJson({
  fetchImpl,
  url,
  token,
  method = 'GET',
  body,
  retrySleepImpl = sleep,
}) {
  if (method !== 'GET') return requestJsonOnce({ fetchImpl, url, token, method, body });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestJsonOnce({ fetchImpl, url, token, method, body });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || !error.retryable || attempt === 2) throw error;
      await retrySleepImpl(GITHUB_GET_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new GitHubRequestError('github_request_failed', 'GitHub GET retry bound exhausted');
}

async function requestJsonOnce({ fetchImpl, url, token, method = 'GET', body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new GitHubRequestError('github_network', `GitHub ${method} request failed [REDACTED]`, {
      retryable: method === 'GET',
    });
  }
  if (!response.ok) {
    throw githubResponseError(response, method);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new GitHubRequestError(
      'github_network',
      `GitHub ${method} response body failed [REDACTED]`,
      { retryable: method === 'GET' }
    );
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new GitHubRequestError(
        'github_response_invalid',
        `GitHub ${method} returned invalid JSON`
      );
    }
  }
  return { response, data };
}

function githubResponseError(response, method) {
  const status = response.status;
  if ((status === 403 || status === 429) && isRateLimited(response)) {
    return new GitHubRequestError('github_rate_limited', `GitHub ${method} was rate limited`);
  }
  if (status === 401 || status === 403) {
    return new GitHubRequestError(
      'github_auth',
      `GitHub ${method} authorization failed [REDACTED]`
    );
  }
  if ([500, 502, 503, 504].includes(status)) {
    return new GitHubRequestError('github_5xx', `GitHub ${method} returned ${status}`, {
      retryable: method === 'GET',
    });
  }
  return new GitHubRequestError('github_request_failed', `GitHub ${method} returned ${status}`);
}

function isRateLimited(response) {
  return (
    response.status === 429 ||
    response.headers.get('x-ratelimit-remaining') === '0' ||
    Boolean(response.headers.get('retry-after'))
  );
}

function isAmbiguousMutationError(error) {
  return (
    error instanceof GitHubRequestError &&
    ['github_network', 'github_5xx', 'github_response_invalid'].includes(error.category)
  );
}

function isImmediateMutationFailure(error) {
  return (
    error instanceof GitHubRequestError &&
    ['github_rate_limited', 'github_auth', 'github_request_failed'].includes(error.category)
  );
}

function validateBrowserResult({ failures, result, marker, expectedSha, candidate, canonicalUrl }) {
  if (!result || typeof result !== 'object') {
    failures.push('Browser result file is missing or invalid');
    return;
  }
  if (result.marker !== marker) failures.push('Browser result marker does not match');
  if (result.kind !== 'structured') failures.push('Browser result kind is not structured');
  validateBrowserSubmissionId({ failures, result, marker });
  if (!Number.isInteger(result.issueNumber) || result.issueNumber <= 0) {
    failures.push('Browser result Issue number is not a positive integer');
  }
  if (result.issueNumber !== candidate.number) failures.push('Browser result Issue number differs');
  if (result.issueUrl !== canonicalUrl) failures.push('Browser result Issue URL differs');
  if (result.workerSha !== expectedSha) failures.push('Browser result Worker SHA differs');
}

function validateBrowserResultReference({ failures, result, marker, expectedSha, repo }) {
  if (!result || typeof result !== 'object') {
    failures.push('Browser result file is missing or invalid');
    return;
  }
  if (result.marker !== marker) failures.push('Browser result marker does not match');
  if (result.kind !== 'structured') failures.push('Browser result kind is not structured');
  validateBrowserSubmissionId({ failures, result, marker });
  if (!Number.isInteger(result.issueNumber) || result.issueNumber <= 0) {
    failures.push('Browser result Issue number is not a positive integer');
  } else if (!isGitHubIssueUrlForRepository(result.issueUrl, repo, result.issueNumber)) {
    failures.push('Browser result Issue URL is not canonical');
  }
  if (result.workerSha !== expectedSha) failures.push('Browser result Worker SHA differs');
}

function validateBrowserSubmissionId({ failures, result, marker }) {
  if (result.presentation === 'modal') {
    if (!isRenderedSubmissionId(result.submissionId)) {
      failures.push('Browser result submission ID is not a rendered submission identity');
    }
    return;
  }
  if (result.submissionId !== `ci:${marker}`) {
    failures.push('Browser result submission ID does not match the canary marker');
  }
}

function isRenderedSubmissionId(value) {
  return (
    typeof value === 'string' &&
    /^submission-(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(value)
  );
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map(label => (typeof label === 'string' ? label : label?.name))
    .filter(label => typeof label === 'string')
    .sort();
}

function sameStringSet(left, right) {
  const normalizedRight = [...right].sort();
  return (
    left.length === normalizedRight.length &&
    left.every((value, index) => value === normalizedRight[index])
  );
}

function sameGitHubLogin(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function parseNextLink(value) {
  if (!value) return '';
  for (const segment of value.split(',')) {
    const match = segment.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2].split(/\s+/).includes('next')) return match[1];
  }
  return '';
}

function parseRepo(repo) {
  requireNonempty(repo, 'repo');
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some(part => !part.trim())) {
    throw new Error('repo must use owner/name format');
  }
  return { owner: parts[0], name: parts[1] };
}

function issueApiUrl(apiBaseUrl, repo, number) {
  const { owner, name } = parseRepo(repo);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Invalid Issue number');
  return new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`,
    apiBaseUrl
  ).toString();
}

function requireNonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function validateConsistencyOptions({ consistencyAttempts, consistencyDelayMs, sleepImpl }) {
  if (
    !Number.isInteger(consistencyAttempts) ||
    consistencyAttempts < 2 ||
    consistencyAttempts > MAX_CONSISTENCY_ATTEMPTS
  ) {
    throw new Error(`consistencyAttempts must be an integer from 2 to ${MAX_CONSISTENCY_ATTEMPTS}`);
  }
  if (
    !Number.isInteger(consistencyDelayMs) ||
    consistencyDelayMs < 0 ||
    consistencyDelayMs > MAX_CONSISTENCY_DELAY_MS
  ) {
    throw new Error(`consistencyDelayMs must be an integer from 0 to ${MAX_CONSISTENCY_DELAY_MS}`);
  }
  if (typeof sleepImpl !== 'function') throw new Error('sleepImpl must be a function');
  return { attempts: consistencyAttempts, delayMs: consistencyDelayMs, sleep: sleepImpl };
}

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function safeErrorMessage(error, token) {
  return redact(error instanceof Error ? error.message : String(error), token);
}

function deliveryEvidence(outcome, reasonCode, observedAt) {
  return { schemaVersion: 1, outcome, reasonCode, observedAt };
}

function githubEvidenceReason(error) {
  if (!(error instanceof GitHubRequestError)) return 'classification_failed';
  if (error.category === 'github_network') return 'github_network';
  if (error.category === 'github_5xx') return 'github_5xx';
  if (error.category === 'github_rate_limited') return 'github_rate_limited';
  if (error.category === 'github_auth') return 'github_auth_failed';
  return 'classification_failed';
}

function redact(value, token) {
  if (!token) return value;
  return value.split(token).join('[REDACTED]');
}

function formatNumbers(numbers) {
  return numbers.length > 0 ? numbers.map(number => `#${number}`).join(', ') : 'none';
}

function parseCliArguments(argv) {
  const command = argv[0] ?? '';
  const options = {};
  const names = {
    '--repo': 'repo',
    '--marker': 'marker',
    '--prefix': 'prefix',
    '--result-file': 'resultFile',
    '--attempt-file': 'attemptFile',
    '--post-evidence-file': 'postEvidenceFile',
    '--evidence-file': 'evidenceFile',
    '--expected-sha': 'expectedSha',
    '--profile': 'profile',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const name = names[key];
    if (!name) throw new Error(`Unknown option: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
