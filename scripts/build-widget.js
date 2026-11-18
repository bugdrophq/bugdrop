#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, version as esbuildVersion } from 'esbuild';

import {
  createDevelopmentStaticPackage,
  createReleaseStaticPackage,
} from './release/static-assets.mjs';
import { canonicalize } from './release/canonical-json.mjs';
import { loadRetentionInput } from './release/retention.mjs';

const CONTROLLER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_DEFAULT_BASELINE_ROOT = join(CONTROLLER_ROOT, 'scripts/default-flow-fixed-baseline');
const FIXED_DEFAULT_BASELINE_MANIFEST = join(FIXED_DEFAULT_BASELINE_ROOT, 'manifest.json');
const FIXED_DEFAULT_BASELINE_ENTRY = 'src/widget/index.ts';
const FIXED_DEFAULT_BASELINE_FILE_COUNT = 70;
const VALUE_OPTIONS = new Set([
  'mode',
  'source-dir',
  'output-dir',
  'version',
  'timestamp',
  'target-sha',
  'repository',
  'cutover-version',
  'retention-plan',
  'request-plan',
  'result-path',
  'current-archive-url',
  'controller-identity',
  'tool-identity',
  'source-digest',
  'development-id',
  'default-flow-runtime',
]);

function usage() {
  return `Usage: node scripts/build-widget.js [options]

Build modes:
  --mode development          Non-authoritative local/preview output (default)
  --mode release              Deterministic authoritative package

Common options:
  --source-dir PATH           Candidate checkout (default: repository root)
  --output-dir PATH           Clean output tree (default: <source>/public)
  --development-id ID         Visible identity for development output
  --default-flow-runtime ID   Internal default controller: private (default) or fixed rollback

Release options:
  --version MAJOR.MINOR.PATCH  Required planned stable version
  --timestamp UTC             Required fixed YYYY-MM-DDTHH:MM:SSZ
  --target-sha SHA            Candidate commit (derived from Git when omitted)
  --repository OWNER/NAME     Release repository (derived from Git when omitted)
  --retention-plan PATH       JSON declaration of retained exact-version assets
  --request-plan PATH         Approved request plan matching the retention input
  --result-path PATH          Write the complete builder-result identity outside the output tree
  --cutover-version VERSION   First retained exact version (default: current)
  --current-archive-url URL   Prospective exact-version release URL
  --controller-identity ID    sha256 identity (derived when omitted)
  --tool-identity ID          sha256 identity (derived when omitted)
  --source-digest DIGEST      Candidate source digest (derived when omitted)
  --help                      Show this help
`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (Object.hasOwn(options, key)) throw new Error(`${token} may only be provided once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function option(options, key, environmentName, fallback) {
  return options[key] ?? process.env[environmentName] ?? fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalized(path) {
  return path.split(sep).join('/');
}

async function listSourceFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(root, path)));
    else if (entry.isFile()) files.push(normalized(relative(root, path)));
    else throw new Error(`Unsupported candidate source entry: ${path}`);
  }
  return files;
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  for (const file of await listSourceFiles(root)) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function controllerIdentity() {
  const fixedBaselineFiles = await listSourceFiles(FIXED_DEFAULT_BASELINE_ROOT);
  const paths = [
    fileURLToPath(import.meta.url),
    join(CONTROLLER_ROOT, 'scripts/release/canonical-json.mjs'),
    join(CONTROLLER_ROOT, 'scripts/release/static-assets.mjs'),
    ...fixedBaselineFiles.map(path => join(FIXED_DEFAULT_BASELINE_ROOT, path)),
  ];
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(basename(path));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function isPlainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function resolveInside(root, path, label) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || isAbsolute(path)) {
    throw new Error(`Fixed default baseline ${label} is invalid`);
  }
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Fixed default baseline ${label} escapes its root`);
  }
  return resolved;
}

async function loadFixedDefaultBaseline(sourceDir) {
  const physicalSourceDir = await realpath(sourceDir);
  const physicalBaselineRoot = await realpath(FIXED_DEFAULT_BASELINE_ROOT);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(FIXED_DEFAULT_BASELINE_MANIFEST, 'utf8'));
  } catch {
    throw new Error('Fixed default baseline manifest is missing or malformed');
  }
  if (
    !isPlainObject(manifest) ||
    manifest.schema !== 'bugdrop.default-flow-fixed-baseline/v1' ||
    manifest.sourceCommit !== 'bb0f1b50a37867f8351b99f7e712a960836deb3f' ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== FIXED_DEFAULT_BASELINE_FILE_COUNT
  ) {
    throw new Error('Fixed default baseline manifest identity is invalid');
  }
  const candidatePaths = new Set();
  const assetPaths = new Set();
  const baseline = new Map();
  for (const file of manifest.files) {
    if (
      !isPlainObject(file) ||
      !Number.isSafeInteger(file.length) ||
      file.length <= 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error('Fixed default baseline manifest entry is invalid');
    }
    if (typeof file.candidatePath !== 'string' || typeof file.assetPath !== 'string') {
      throw new Error('Fixed default baseline manifest entry is invalid');
    }
    const candidatePath = normalized(file.candidatePath);
    const assetPath = normalized(file.assetPath);
    if (candidatePaths.has(candidatePath) || assetPaths.has(assetPath)) {
      throw new Error('Fixed default baseline manifest contains a duplicate path');
    }
    candidatePaths.add(candidatePath);
    assetPaths.add(assetPath);
    if (
      (candidatePath !== 'src/defaults.ts' && !candidatePath.startsWith('src/widget/')) ||
      !candidatePath.endsWith('.ts') ||
      assetPath !== `${candidatePath}.txt`
    ) {
      throw new Error('Fixed default baseline manifest path identity is invalid');
    }
    const candidateFile = resolveInside(physicalSourceDir, candidatePath, 'candidate path');
    const declaredAssetFile = resolveInside(physicalBaselineRoot, assetPath, 'asset path');
    let bytes;
    try {
      const assetFile = await realpath(declaredAssetFile);
      resolveInside(physicalBaselineRoot, relative(physicalBaselineRoot, assetFile), 'asset path');
      bytes = await readFile(assetFile);
    } catch {
      throw new Error(`Fixed default baseline asset is missing: ${assetPath}`);
    }
    if (bytes.length !== file.length || sha256(bytes) !== file.sha256) {
      throw new Error(`Fixed default baseline asset integrity failed: ${assetPath}`);
    }
    baseline.set(candidateFile, bytes.toString('utf8'));
  }
  if (
    candidatePaths.size !== FIXED_DEFAULT_BASELINE_FILE_COUNT ||
    !candidatePaths.has(FIXED_DEFAULT_BASELINE_ENTRY)
  ) {
    throw new Error('Fixed default baseline manifest is incomplete');
  }
  const entry = resolveInside(physicalSourceDir, FIXED_DEFAULT_BASELINE_ENTRY, 'candidate entry');
  let entryStat;
  try {
    entryStat = await lstat(entry);
  } catch {
    throw new Error(`Fixed default baseline candidate is missing: ${FIXED_DEFAULT_BASELINE_ENTRY}`);
  }
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error(
      `Fixed default baseline candidate must be a regular file: ${FIXED_DEFAULT_BASELINE_ENTRY}`
    );
  }
  return { entry, modules: baseline };
}

function resolveFixedDefaultImport(modules, importer, specifier) {
  const unresolved = resolve(dirname(importer), specifier);
  for (const path of [unresolved, `${unresolved}.ts`, join(unresolved, 'index.ts')]) {
    if (modules.has(path)) return path;
  }
  throw new Error(`Fixed default baseline import is missing: ${specifier} from ${importer}`);
}

function git(sourceDir, args) {
  try {
    return execFileSync('git', ['-C', sourceDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function repositoryFromRemote(remote) {
  const match = /(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote ?? '');
  return match?.[1];
}

async function bundleCandidate({ sourceDir, version, enableTestHooks, defaultFlowRuntime }) {
  const entry = join(sourceDir, 'src/widget/index.ts');
  const fixedBaseline =
    defaultFlowRuntime === 'fixed' ? await loadFixedDefaultBaseline(sourceDir) : undefined;
  const needsAreaCloneHook =
    !fixedBaseline && (await readdir(dirname(entry))).includes('area-capture-scroll.ts');
  const loadedFixedBaseline = new Set();
  const result = await build({
    absWorkingDir: sourceDir,
    bundle: true,
    define: {
      __BUGDROP_ENABLE_TEST_HOOKS__: enableTestHooks ? 'true' : 'false',
      __BUGDROP_DEFAULT_FLOW_RUNTIME__: JSON.stringify(defaultFlowRuntime),
      __BUGDROP_VERSION__: JSON.stringify(version),
    },
    entryPoints: [fixedBaseline?.entry ?? entry],
    format: 'iife',
    logLevel: 'silent',
    minify: true,
    outfile: 'widget.js',
    plugins:
      defaultFlowRuntime === 'fixed'
        ? [
            {
              name: 'fixed-default-baseline',
              setup(build) {
                build.onResolve({ filter: /.*/ }, args => {
                  if (!fixedBaseline.modules.has(args.importer) || !args.path.startsWith('.')) {
                    return undefined;
                  }
                  return {
                    path: resolveFixedDefaultImport(
                      fixedBaseline.modules,
                      args.importer,
                      args.path
                    ),
                  };
                });
                build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
                  const contents = fixedBaseline.modules.get(args.path);
                  if (contents === undefined) return undefined;
                  if (loadedFixedBaseline.has(args.path)) {
                    throw new Error(`Fixed default baseline loaded more than once: ${args.path}`);
                  }
                  loadedFixedBaseline.add(args.path);
                  return { contents, loader: 'ts', resolveDir: dirname(args.path) };
                });
              },
            },
          ]
        : needsAreaCloneHook
          ? [areaCaptureCloneHook()]
          : [],
    write: false,
  });
  if (fixedBaseline && loadedFixedBaseline.size !== fixedBaseline.modules.size) {
    const missing = Array.from(fixedBaseline.modules.keys())
      .filter(path => !loadedFixedBaseline.has(path))
      .map(path => normalized(relative(sourceDir, path)))
      .sort();
    throw new Error(`Fixed default baseline substitution is incomplete: ${missing.join(', ')}`);
  }
  if (result.outputFiles.length !== 1) throw new Error('Expected exactly one widget bundle output');
  const bytes = Buffer.from(result.outputFiles[0].contents);
  if (!enableTestHooks && bytes.includes('__bugdropMockToPng')) {
    throw new Error('Production widget build unexpectedly contains test screenshot hook');
  }
  return bytes;
}

function areaCaptureCloneHook() {
  return {
    name: 'area-capture-clone-hook',
    setup(build) {
      let installed = false;
      // html-to-image 1.11.13 has no public hook for editing the styled clone.
      // Run after style and value copying, before the tree is serialized to SVG.
      build.onLoad(
        { filter: /[/\\]html-to-image[/\\]es[/\\]clone-node\.js$/ },
        async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const returnClone = 'cloneSelectValue(nativeNode, clonedNode);';
          if (source.split(returnClone).length !== 2) {
            throw new Error('html-to-image clone hook must be updated for this renderer version');
          }
          installed = true;
          return {
            contents: source.replace(
              returnClone,
              `${returnClone}\n        options.onAreaClone?.(nativeNode, clonedNode);`
            ),
            loader: 'js',
            resolveDir: dirname(path),
          };
        }
      );
      build.onEnd(result => {
        if (!installed && result.errors.length === 0) {
          return {
            errors: [{ text: 'Widget build did not install the html-to-image clone hook' }],
          };
        }
      });
    },
  };
}

async function loadRetentionPlan(path, requestPlanPath) {
  if (!path) return {};
  const resolved = resolve(path);
  const plan = JSON.parse(await readFile(resolved, 'utf8'));
  if (plan === null || Array.isArray(plan) || typeof plan !== 'object') {
    throw new Error('Retention plan must be a JSON object');
  }
  if (plan.schema === 'bugdrop.retention-input/v1') {
    if (!requestPlanPath) throw new Error('Authenticated retention input requires --request-plan');
    const requestBytes = await readFile(resolve(requestPlanPath));
    const requestPlan = JSON.parse(requestBytes.toString('utf8'));
    if (!requestBytes.equals(Buffer.from(`${canonicalize(requestPlan)}\n`))) {
      throw new Error('Request plan must be canonical JSON');
    }
    return loadRetentionInput(resolved, requestPlan.requestIdentity, requestPlan.retention);
  }
  return plan;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const mode = option(options, 'mode', 'BUGDROP_BUILD_MODE', 'development');
  if (mode !== 'development' && mode !== 'release')
    throw new Error(`Unsupported build mode: ${mode}`);
  const sourceDir = resolve(option(options, 'source-dir', 'BUGDROP_SOURCE_DIR', CONTROLLER_ROOT));
  const outputDir = resolve(
    option(options, 'output-dir', 'BUGDROP_OUTPUT_DIR', join(sourceDir, 'public'))
  );
  const enableTestHooks = process.env.BUGDROP_TEST_HOOKS === '1';
  const defaultFlowRuntime = option(
    options,
    'default-flow-runtime',
    'BUGDROP_DEFAULT_FLOW_RUNTIME',
    'private'
  );
  if (defaultFlowRuntime !== 'fixed' && defaultFlowRuntime !== 'private') {
    throw new Error('Unsupported default flow runtime: expected private or fixed');
  }

  if (mode === 'development') {
    const developmentId = option(options, 'development-id', 'BUGDROP_DEVELOPMENT_ID', 'local');
    const bundleBytes = await bundleCandidate({
      sourceDir,
      version: `development:${developmentId}`,
      enableTestHooks,
      defaultFlowRuntime,
    });
    await createDevelopmentStaticPackage({
      bundleBytes,
      developmentId,
      outputDir,
      sourcePublicDir: join(sourceDir, 'public'),
    });
    process.stdout.write(`Built non-authoritative widget development:${developmentId}\n`);
    return;
  }

  if (enableTestHooks) throw new Error('Release mode forbids BUGDROP_TEST_HOOKS');
  const version = option(options, 'version', 'BUGDROP_VERSION');
  const timestamp = option(options, 'timestamp', 'BUGDROP_RELEASE_TIMESTAMP');
  if (!version) throw new Error('Release mode requires --version or BUGDROP_VERSION');
  if (!timestamp) throw new Error('Release mode requires --timestamp or BUGDROP_RELEASE_TIMESTAMP');

  const targetSha =
    option(options, 'target-sha', 'BUGDROP_TARGET_SHA') ?? git(sourceDir, ['rev-parse', 'HEAD']);
  const repository =
    option(options, 'repository', 'BUGDROP_REPOSITORY') ??
    repositoryFromRemote(git(sourceDir, ['remote', 'get-url', 'origin']));
  const retention = await loadRetentionPlan(
    option(options, 'retention-plan', 'BUGDROP_RETENTION_PLAN'),
    option(options, 'request-plan', 'BUGDROP_REQUEST_PLAN')
  );
  const retentionMode = retention.mode ?? (retention.retainedReleases ? undefined : 'disabled');
  const bundleBytes = await bundleCandidate({
    sourceDir,
    version,
    enableTestHooks: false,
    defaultFlowRuntime,
  });
  const exactName = `widget.v${version}.js`;
  const result = await createReleaseStaticPackage({
    bundleBytes,
    controllerIdentity:
      option(options, 'controller-identity', 'BUGDROP_CONTROLLER_IDENTITY') ??
      (await controllerIdentity()),
    currentArchiveUrl:
      option(options, 'current-archive-url', 'BUGDROP_CURRENT_ARCHIVE_URL') ??
      `https://github.com/${repository}/releases/download/v${version}/${exactName}`,
    cutoverVersion:
      option(options, 'cutover-version', 'BUGDROP_CUTOVER_VERSION') ??
      retention.cutoverVersion ??
      (retentionMode === 'disabled' ? null : version),
    expectedRetainedVersions: retention.expectedRetainedVersions ?? [],
    outputDir,
    repository,
    retainedReleases: retention.retainedReleases ?? [],
    retentionMode,
    sourceDigest:
      option(options, 'source-digest', 'BUGDROP_SOURCE_DIGEST') ??
      (await treeDigest(join(sourceDir, 'src/widget'))),
    sourcePublicDir: join(sourceDir, 'public'),
    targetSha,
    timestamp,
    toolIdentity:
      option(options, 'tool-identity', 'BUGDROP_TOOL_IDENTITY') ??
      `sha256:${sha256(`esbuild:${esbuildVersion}`)}`,
    version,
  });
  const resultPath = option(options, 'result-path', 'BUGDROP_BUILDER_RESULT');
  if (resultPath) {
    const builderResult = {
      schema: 'bugdrop.builder-result/v1',
      requestIdentity: retention.requestIdentity ?? null,
      staticPackage: result.staticPackage,
    };
    await writeFile(resolve(resultPath), `${canonicalize(builderResult)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`Built authoritative widget v${version} (${result.contentIdentity})\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
