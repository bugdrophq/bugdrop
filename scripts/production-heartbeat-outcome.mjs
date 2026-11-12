#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REASON_CODES = {
  verified: new Set(['issue_verified']),
  delivery_failed: new Set(['issue_absent', 'issue_duplicate', 'issue_contract_invalid']),
  inconclusive: new Set([
    'setup_failed',
    'pre_submission_setup_failed',
    'identity_failed',
    'venue_failed',
    'browser_inconclusive',
    'github_network',
    'github_5xx',
    'github_rate_limited',
    'github_auth_failed',
    'cleanup_failed',
    'sweep_failed',
    'artifact_failed',
    'incident_failed',
    'classification_failed',
  ]),
};

const SETUP_STAGES = ['checkout', 'node', 'install', 'config', 'browser'];
const RECEIVER_RETRY_DELAYS_MS = [1_000, 2_000];

export function classifyHeartbeatOutcome({
  evidence,
  stages,
  artifactPrepare,
  artifact,
  incident,
  admitted = false,
  noSubmission = false,
}) {
  if (isAuthoritativeEvidence(evidence)) return evidence;

  const evidenceTime = canonicalEvidenceTime(evidence?.observedAt);
  if (
    admitted &&
    noSubmission &&
    stages?.browser === 'failure' &&
    stages.canary === 'skipped' &&
    stages.verify === 'skipped' &&
    stages.preflight === 'success' &&
    stages.cleanup === 'success' &&
    stages.sweep === 'success' &&
    artifactPrepare === 'success' &&
    artifact === 'success' &&
    incident === 'success' &&
    evidence?.outcome === 'inconclusive' &&
    evidence.reasonCode === 'browser_inconclusive' &&
    evidenceTime
  ) {
    return outcome('inconclusive', 'pre_submission_setup_failed', evidenceTime);
  }

  let reasonCode = null;
  if (SETUP_STAGES.some(stage => stages?.[stage] !== 'success')) {
    reasonCode = 'setup_failed';
  } else if (!reasonCode && stages?.identity !== 'success') {
    reasonCode = 'identity_failed';
  } else if (!reasonCode && stages?.venue !== 'success') {
    reasonCode = 'venue_failed';
  } else if (!reasonCode && stages?.preflight !== 'success') {
    reasonCode = 'cleanup_failed';
  } else if (
    evidence?.outcome === 'inconclusive' &&
    evidence.reasonCode !== 'pre_submission_setup_failed' &&
    REASON_CODES.inconclusive.has(evidence.reasonCode)
  ) {
    reasonCode = evidence.reasonCode;
  } else if (!reasonCode && stages?.canary !== 'success') {
    reasonCode = 'browser_inconclusive';
  } else if (!reasonCode && stages?.cleanup !== 'success') {
    reasonCode = 'cleanup_failed';
  } else if (!reasonCode && stages?.sweep !== 'success') {
    reasonCode = 'sweep_failed';
  } else if (!reasonCode && (artifactPrepare !== 'success' || artifact !== 'success')) {
    reasonCode = 'artifact_failed';
  } else if (!reasonCode && incident !== 'success') {
    reasonCode = 'incident_failed';
  }
  return outcome('inconclusive', reasonCode || 'classification_failed', evidenceTime || new Date());
}

export async function sendHeartbeatOutcome({
  fetchImpl = fetch,
  endpoint,
  secret,
  heartbeatId,
  report,
  retrySleepImpl = sleep,
}) {
  requireNonempty(endpoint, 'endpoint');
  requireNonempty(secret, 'secret');
  requireNonempty(heartbeatId, 'heartbeatId');
  validateOutcome(report);

  const body = JSON.stringify(report);
  const request = {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'X-BugDrop-Heartbeat-Id': heartbeatId,
    },
    body,
  };
  let response;
  let responseText;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetchImpl(endpoint, {
        ...request,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === 2) throw new Error('heartbeat_receiver_network');
      await retrySleepImpl(RECEIVER_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await retrySleepImpl(RECEIVER_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (
      response.status !== 200 ||
      response.headers.get('cache-control')?.toLowerCase() !== 'no-store'
    ) {
      break;
    }
    try {
      responseText = await response.text();
    } catch {
      if (attempt === 2) throw new Error('heartbeat_receiver_network');
      await retrySleepImpl(RECEIVER_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    break;
  }
  if (response.status !== 200) throw new Error(`heartbeat_receiver_http_${response.status}`);
  if (response.headers.get('cache-control')?.toLowerCase() !== 'no-store') {
    throw new Error('heartbeat_receiver_cache_invalid');
  }
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error('heartbeat_receiver_response_invalid');
  }
  const keys =
    responseBody && typeof responseBody === 'object' ? Object.keys(responseBody).sort() : [];
  if (
    keys.join(',') !== 'accepted,duplicate,effect,observedAt,outcome,schemaVersion' ||
    responseBody.schemaVersion !== 1 ||
    responseBody.accepted !== true ||
    typeof responseBody.duplicate !== 'boolean' ||
    responseBody.outcome !== report.outcome ||
    responseBody.observedAt !== report.observedAt ||
    !validEffect(report.outcome, responseBody.effect)
  ) {
    throw new Error('heartbeat_receiver_response_invalid');
  }
  return responseBody;
}

export function outcome(outcomeName, reasonCode, observedAt) {
  const report = {
    schemaVersion: 1,
    outcome: outcomeName,
    reasonCode,
    observedAt: canonicalTime(observedAt),
  };
  validateOutcome(report);
  return report;
}

function isAuthoritativeEvidence(value) {
  if (!value || (value.outcome !== 'verified' && value.outcome !== 'delivery_failed')) return false;
  try {
    validateOutcome(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalEvidenceTime(value) {
  if (typeof value !== 'string') return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function validateOutcome(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('heartbeat_outcome_invalid');
  }
  if (Object.keys(report).sort().join(',') !== 'observedAt,outcome,reasonCode,schemaVersion') {
    throw new Error('heartbeat_outcome_invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    !REASON_CODES[report.outcome]?.has(report.reasonCode) ||
    typeof report.observedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.observedAt) ||
    new Date(report.observedAt).toISOString() !== report.observedAt
  ) {
    throw new Error('heartbeat_outcome_invalid');
  }
}

function validEffect(outcomeName, effect) {
  if (effect === 'recorded_only') return true;
  if (outcomeName === 'verified') return effect === 'verified';
  if (outcomeName === 'delivery_failed') return effect === 'degraded';
  return false;
}

function canonicalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('heartbeat_observed_at_invalid');
  return date.toISOString();
}

function requireNonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}_missing`);
  return value.trim();
}

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function stagesFromEnvironment(environment) {
  return Object.fromEntries(
    [
      'checkout',
      'node',
      'install',
      'config',
      'browser',
      'preflight',
      'identity',
      'venue',
      'canary',
      'verify',
      'cleanup',
      'sweep',
    ].map(stage => [stage, environment[`STAGE_${stage.toUpperCase()}`]])
  );
}

async function main(argv, environment = process.env) {
  const command = argv[0];
  if (command === 'classify') {
    let evidence;
    if (environment.DELIVERY_EVIDENCE_FILE) {
      try {
        evidence = JSON.parse(await readFile(environment.DELIVERY_EVIDENCE_FILE, 'utf8'));
      } catch {
        evidence = undefined;
      }
    } else if (environment.EVIDENCE_OUTCOME) {
      evidence = {
        schemaVersion: 1,
        outcome: environment.EVIDENCE_OUTCOME,
        reasonCode: environment.EVIDENCE_REASON,
        observedAt: environment.EVIDENCE_OBSERVED_AT,
      };
    }
    const report = classifyHeartbeatOutcome({
      evidence,
      stages: stagesFromEnvironment(environment),
      artifactPrepare: environment.ARTIFACT_PREPARE_OUTCOME,
      artifact: environment.ARTIFACT_OUTCOME,
      incident: environment.INCIDENT_OUTCOME,
      admitted: environment.HEARTBEAT_ADMITTED === 'true',
      noSubmission: environment.NO_SUBMISSION === 'true',
    });
    const outputFile = requireNonempty(environment.GITHUB_OUTPUT, 'github_output');
    await appendFile(
      outputFile,
      `outcome=${report.outcome}\nreason_code=${report.reasonCode}\nobserved_at=${report.observedAt}\n`
    );
    return;
  }
  if (command === 'send') {
    const heartbeatId = environment.HEARTBEAT_ID;
    const reason = environment.HEARTBEAT_REASON_CODE;
    const report = {
      schemaVersion: 1,
      outcome: environment.HEARTBEAT_OUTCOME,
      reasonCode:
        reason === 'pre_submission_setup_failed' && !/^[1-9][0-9]*:[1-5]$/.test(heartbeatId)
          ? 'setup_failed'
          : reason,
      observedAt: environment.HEARTBEAT_OBSERVED_AT,
    };
    await sendHeartbeatOutcome({
      endpoint: environment.MONITOR_HEARTBEAT_URL || 'https://bugdrop.dev/api/monitor/heartbeat',
      secret: environment.MONITOR_HEARTBEAT_SECRET,
      heartbeatId,
      report,
    });
    return;
  }
  throw new Error('heartbeat_command_invalid');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('[production-heartbeat-outcome] operation_failed\n');
    process.exitCode = 1;
  });
}
