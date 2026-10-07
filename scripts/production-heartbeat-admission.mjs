#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Admission is required only for watchdog requests; no response is treated as permission. */
export async function admitHeartbeat({ environment = process.env, fetchImpl = fetch } = {}) {
  const recoveryId = environment.BUGDROP_RECOVERY_ID || '';
  if (!recoveryId) return true;
  const {
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: runAttempt,
    WATCHDOG_ADMISSION_SECRET: secret,
  } = environment;
  if (
    !/^wd-[a-f0-9]{32}$/.test(recoveryId) ||
    !/^[1-9][0-9]*$/.test(runId || '') ||
    !/^[1-9][0-9]*$/.test(runAttempt || '') ||
    !secret ||
    secret.length < 32 ||
    environment.BUGDROP_CONTROLLED_FAILURE !== 'false'
  ) {
    throw new Error('watchdog_admission_configuration');
  }
  const identity = { schemaVersion: 1, recoveryId, runId, runAttempt };
  const response = await fetchImpl('https://bugdrop.dev/api/monitor/watchdog/admit', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  });
  if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store') {
    throw new Error('watchdog_admission_denied');
  }
  const body = await response.json();
  if (
    !body ||
    Object.keys(body).sort().join(',') !== 'admitted,recoveryId,runAttempt,runId,schemaVersion' ||
    body.admitted !== true ||
    Object.entries(identity).some(([key, value]) => body[key] !== value)
  ) {
    throw new Error('watchdog_admission_invalid');
  }
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  admitHeartbeat()
    .then(async () => {
      if (!process.env.GITHUB_OUTPUT) throw new Error('output_missing');
      await appendFile(process.env.GITHUB_OUTPUT, 'admitted=true\n');
    })
    .catch(() => {
      process.stderr.write('[watchdog-admission] denied\n');
      process.exitCode = 1;
    });
}
