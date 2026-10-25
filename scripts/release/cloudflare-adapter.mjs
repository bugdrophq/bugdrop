#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize } from './canonical-json.mjs';

const CLOUDFLARE_ADAPTER_PROTOCOL = 'bugdrop.cloudflare-adapter/v1';
export const CAPABILITY_WRANGLER_VERSION = '4.151.1';

const SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA = /^[0-9a-f]{40}$/;
const MESSAGE = /^[A-Za-z0-9 .:_-]{1,120}$/;

export class CloudflareAdapterError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    Object.assign(this, { code, name: 'CloudflareAdapterError' });
  }
}

function fail(code, message) {
  throw new CloudflareAdapterError(code, message);
}

function match(value, pattern, field, code = 'INVALID_INPUT') {
  if (!pattern.test(value ?? '')) fail(code, `${field} is invalid`);
  return value;
}

function object(value, field, code = 'INVALID_CLOUDFLARE_RESPONSE') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${field} must be an object`);
  }
  return value;
}

function json(value, field) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    fail('INVALID_CLOUDFLARE_RESPONSE', `${field} is not valid JSON`);
  }
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_CLOUDFLARE_RESPONSE', `${field} is invalid`);
  }
  return value;
}

function boundedText(value, field) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value)) {
    fail('INVALID_CLOUDFLARE_RESPONSE', `${field} is invalid`);
  }
  return value;
}

export function parseEnvironmentTarget(configBytes, environment, expectedTarget) {
  if (!['preview', 'production'].includes(environment)) {
    fail('INVALID_ENVIRONMENT', 'environment must be preview or production');
  }
  match(expectedTarget, SAFE_NAME, 'expectedTarget');
  const source = Buffer.isBuffer(configBytes) ? configBytes.toString('utf8') : configBytes;
  if (typeof source !== 'string') fail('INVALID_CONTROLLER_CONFIG', 'config bytes are missing');
  let section = '';
  const names = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const table = line.match(/^\[([^\]]+)]$/);
    if (table) {
      section = table[1];
      continue;
    }
    if (section !== `env.${environment}` || !/^name\s*=/.test(line)) continue;
    const assignment = line.match(/^name\s*=\s*"([a-z0-9-]+)"\s*(?:#.*)?$/);
    if (!assignment || !SAFE_NAME.test(assignment[1])) {
      fail('INVALID_CONTROLLER_CONFIG', 'environment name assignment is unsafe');
    }
    names.push(assignment[1]);
  }
  if (names.length !== 1) {
    fail('INVALID_CONTROLLER_CONFIG', 'environment must declare exactly one name');
  }
  if (names[0] !== expectedTarget) {
    fail('TARGET_MISMATCH', 'controller environment selects a different Worker');
  }
  return names[0];
}

function lockedWrangler(lockBytes) {
  const lock = json(Buffer.isBuffer(lockBytes) ? lockBytes.toString('utf8') : lockBytes, 'lock');
  const version = lock?.packages?.['node_modules/wrangler']?.version;
  if (version !== CAPABILITY_WRANGLER_VERSION) {
    fail('WRANGLER_VERSION_MISMATCH', 'controller Wrangler does not match capability proof');
  }
  return version;
}

function within(root, value, field) {
  if (!isAbsolute(root) || !isAbsolute(value)) fail('UNSAFE_PATH', `${field} must be absolute`);
  const normalizedRoot = resolve(root);
  const normalized = resolve(value);
  const relation = relative(normalizedRoot, normalized);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    fail('UNSAFE_PATH', `${field} must be a file below its trusted root`);
  }
  return normalized;
}

function command(executable, cwd, args) {
  if (args.includes('--name'))
    fail('UNSAFE_COMMAND', '--name must not override environment target');
  return { protocol: CLOUDFLARE_ADAPTER_PROTOCOL, executable, cwd, args };
}

export function createWranglerPlan(input) {
  lockedWrangler(input.controllerLockBytes);
  const environment = input.environment;
  const target = parseEnvironmentTarget(
    input.controllerConfigBytes,
    environment,
    input.expectedTarget
  );
  const config = within(input.controllerRoot, input.controllerConfig, 'controllerConfig');
  const entrypoint = within(input.candidateRoot, input.candidateEntrypoint, 'candidateEntrypoint');
  const assets = within(input.candidateRoot, input.candidateAssets, 'candidateAssets');
  const executable = join(resolve(input.controllerRoot), 'node_modules/.bin/wrangler');
  const cwd = resolve(input.candidateRoot);
  const common = ['--config', config, '--env', environment];
  const targetSha = match(input.targetSha, SHA, 'targetSha');
  const wrap = args => command(executable, cwd, args);
  return {
    protocol: CLOUDFLARE_ADAPTER_PROTOCOL,
    target,
    environment,
    wranglerVersion: CAPABILITY_WRANGLER_VERSION,
    status: wrap(['deployments', 'status', ...common, '--json']),
    deployments: wrap(['deployments', 'list', ...common, '--json']),
    versions: wrap(['versions', 'list', ...common, '--json']),
    viewVersion: versionId =>
      wrap(['versions', 'view', match(versionId, SAFE_ID, 'versionId'), ...common, '--json']),
    deploy: wrap([
      'deploy',
      entrypoint,
      ...common,
      '--assets',
      assets,
      '--var',
      `BUILD_SHA:${targetSha}`,
    ]),
    rollback: (versionId, message) =>
      wrap([
        'rollback',
        match(versionId, SAFE_ID, 'versionId'),
        ...common,
        '--message',
        match(message, MESSAGE, 'rollback message'),
        '--yes',
      ]),
  };
}

export function parseDeploymentStatus(value) {
  const deployment = object(json(value, 'deployment status'), 'deployment status');
  const versions = deployment.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100) {
    fail('AMBIGUOUS_DEPLOYMENT', 'exactly one version must have 100 percent traffic');
  }
  return {
    deploymentId: match(deployment.id, SAFE_ID, 'deployment.id', 'INVALID_CLOUDFLARE_RESPONSE'),
    versionId: match(
      versions[0].version_id,
      SAFE_ID,
      'deployment.version_id',
      'INVALID_CLOUDFLARE_RESPONSE'
    ),
    createdOn: timestamp(deployment.created_on, 'deployment.created_on'),
    source: boundedText(deployment.source, 'deployment.source'),
    strategy: boundedText(deployment.strategy, 'deployment.strategy'),
  };
}

export function parseVersionView(value, expectedVersionId) {
  const version = object(json(value, 'version view'), 'version view');
  const versionId = match(version.id, SAFE_ID, 'version.id', 'INVALID_CLOUDFLARE_RESPONSE');
  if (expectedVersionId && versionId !== expectedVersionId) {
    fail('VERSION_MISMATCH', 'version response does not match current deployment');
  }
  const metadata = object(version.metadata, 'version.metadata');
  const resources = object(version.resources, 'version.resources');
  const script = object(resources.script, 'version.resources.script');
  const bindings = resources.bindings;
  if (!Array.isArray(bindings)) fail('INVALID_CLOUDFLARE_RESPONSE', 'bindings are missing');
  const names = bindings.map(binding => boundedText(binding?.name, 'binding.name'));
  if (new Set(names).size !== names.length) {
    fail('INVALID_CLOUDFLARE_RESPONSE', 'binding names repeat');
  }
  const buildBindings = bindings.filter(binding => binding.name === 'BUILD_SHA');
  if (buildBindings.length > 1) fail('INVALID_CLOUDFLARE_RESPONSE', 'BUILD_SHA repeats');
  const buildSha = buildBindings[0]?.text;
  if (buildSha !== undefined) match(buildSha, SHA, 'BUILD_SHA', 'INVALID_CLOUDFLARE_RESPONSE');
  const runtime = object(resources.script_runtime, 'version.resources.script_runtime');
  const runtimeAssets = object(runtime.assets, 'version.resources.script_runtime.assets');
  if (
    typeof runtimeAssets.serve_directly !== 'boolean' ||
    typeof runtimeAssets.raw_run_worker_first !== 'boolean' ||
    !names.includes('ASSETS')
  ) {
    fail('INVALID_CLOUDFLARE_RESPONSE', 'static asset metadata is incomplete');
  }
  return {
    versionId,
    createdOn: timestamp(metadata.created_on, 'version.metadata.created_on'),
    source: boundedText(metadata.source, 'version.metadata.source'),
    scriptEtag: boundedText(script.etag, 'version.resources.script.etag'),
    buildSha: buildSha ?? null,
    assets: {
      rawRunWorkerFirst: runtimeAssets.raw_run_worker_first,
      serveDirectly: runtimeAssets.serve_directly,
    },
  };
}

export function parseDeploymentList(value) {
  const deployments = json(value, 'deployment list');
  if (!Array.isArray(deployments) || deployments.length === 0 || deployments.length > 100) {
    fail('INVALID_CLOUDFLARE_RESPONSE', 'deployment list is empty or unbounded');
  }
  return deployments.map(parseDeploymentStatus);
}

export function parseVersionList(value) {
  const versions = json(value, 'version list');
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 100) {
    fail('INVALID_CLOUDFLARE_RESPONSE', 'version list is empty or unbounded');
  }
  return versions.map(item => ({
    versionId: match(item?.id, SAFE_ID, 'version.id', 'INVALID_CLOUDFLARE_RESPONSE'),
    createdOn: timestamp(item?.metadata?.created_on, 'version.metadata.created_on'),
    source: boundedText(item?.metadata?.source, 'version.metadata.source'),
  }));
}

export function reconcileDeployment(input) {
  if (!['succeeded', 'failed', 'unknown'].includes(input.commandStatus)) {
    fail('INVALID_INPUT', 'commandStatus is invalid');
  }
  if (!input.after) return { status: 'ambiguous-critical', reason: 'inspection-unavailable' };
  if (input.after.versionId === input.before?.versionId) return { status: 'unchanged' };
  const live = input.live;
  if (
    input.version?.versionId === input.after.versionId &&
    input.version.buildSha === input.expectedBuildSha &&
    live?.sourceVerified === true &&
    live?.assetVerified === true &&
    live?.buildSha === input.expectedBuildSha
  ) {
    return { status: 'candidate-active', versionId: input.after.versionId };
  }
  return { status: 'ambiguous-critical', reason: 'unexpected-active-state' };
}

export function verifyRollback(input) {
  const mismatches = [];
  if (input.after?.versionId !== input.baseline?.versionId) mismatches.push('versionId');
  if (input.version?.scriptEtag !== input.baseline?.scriptEtag) mismatches.push('scriptEtag');
  if (input.live?.sourceIdentity !== input.baseline?.sourceIdentity)
    mismatches.push('sourceIdentity');
  if (input.live?.assetIdentity !== input.baseline?.assetIdentity) mismatches.push('assetIdentity');
  return mismatches.length === 0
    ? { status: 'verified' }
    : { status: 'mismatch', fields: mismatches };
}

export function executeWrangler(plan, parse, spawn = spawnSync) {
  if (plan?.protocol !== CLOUDFLARE_ADAPTER_PROTOCOL || plan.args?.includes('--name')) {
    fail('UNSAFE_COMMAND', 'command plan is not adapter-owned');
  }
  const result = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const status = result.error ? 'unknown' : result.status === 0 ? 'succeeded' : 'failed';
  if (status !== 'succeeded' || !parse) return { status };
  return { status, value: parse(result.stdout) };
}

async function runCli() {
  const [mode, inputPath] = process.argv.slice(2);
  if (!inputPath) fail('INVALID_CLI', 'usage: cloudflare-adapter.mjs MODE INPUT.json');
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const operations = {
    status: value => parseDeploymentStatus(value),
    version: value => parseVersionView(value.response, value.expectedVersionId),
    reconcile: reconcileDeployment,
    'verify-rollback': verifyRollback,
  };
  if (!operations[mode]) fail('INVALID_CLI', `unsupported mode ${mode ?? '<missing>'}`);
  process.stdout.write(`${canonicalize(operations[mode](input))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
