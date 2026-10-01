#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { canonicalize, compareUtf8 } from './canonical-json.mjs';
import { observeGitRange } from './git-observer.mjs';
import {
  RELEASE_PROTOCOL,
  RELEASE_PROTOCOL_V2,
  buildPublicationMarker,
  buildReleaseInventory,
  buildRequestPlan,
  calculateNextTag,
  findCompletedPlan,
  normalizeDispatch,
  normalizeGithubState,
  publishedFrontier,
  validateSourceContext,
} from './plan.mjs';
import { validatePublicationBundle } from './publication.mjs';
import { deriveRetentionRequest, writeRetentionInput } from './retention.mjs';
import { MAX_RETAINED_BYTES, MAX_SNAPSHOT_BYTES, MAX_WIDGET_BYTES } from './limits.mjs';
import { ATTESTATION_ASSET, attestationPolicy, verifyPortableAttestation } from './attestation.mjs';

const API_VERSION = '2022-11-28';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MARKERLESS_HISTORY_MAX_TAG = 'v1.55.0';
const UNATTESTED_V2_HISTORY_MAX_TAG = 'v1.55.2';
const PRE_TRANSFER_MAX_TAG = 'v1.56.9';
const ASSET_TIMEOUT_MS = 30_000;
const READ_RETRY_DELAYS_MS = [200, 600];
const RETRYABLE_READ_STATUSES = new Set([500, 502, 503, 504]);
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');

export class GithubAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    Object.assign(this, { code, details, name: 'GithubAdapterError' });
  }
}

function fail(code, message, details) {
  throw new GithubAdapterError(code, message, details);
}

function assertInput(repository, targetSha) {
  const segments = typeof repository === 'string' ? repository.split('/') : [];
  if (
    !REPOSITORY_PATTERN.test(repository ?? '') ||
    segments.some(segment => segment.startsWith('.') || segment.includes('..'))
  ) {
    fail('INVALID_REPOSITORY', 'repository must be owner/name');
  }
  if (!SHA_PATTERN.test(targetSha ?? '')) {
    fail('INVALID_TARGET_SHA', 'targetSha must be a full lowercase SHA');
  }
}

function compareReleaseTags(left, right) {
  if (!TAG_PATTERN.test(left?.tag ?? '') || !TAG_PATTERN.test(right?.tag ?? '')) {
    fail('INVALID_STABLE_TAG', 'release tag comparison requires stable SemVer tags');
  }
  const a = left.tag.slice(1).split('.').map(BigInt);
  const b = right.tag.slice(1).split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function publishedSourceRepository(release, selectedRepository, sourceRepository) {
  if (sourceRepository === selectedRepository) return sourceRepository;
  if (
    selectedRepository === 'bugdrophq/bugdrop' &&
    sourceRepository === 'mean-weasel/bugdrop' &&
    compareReleaseTags(release, { tag: PRE_TRANSFER_MAX_TAG }) <= 0
  ) {
    return sourceRepository;
  }
  fail('PUBLISHED_RELEASE_CONFLICT', `${release.tag} has an unexpected source repository`);
}

export function requiresReleaseAttestation(tag) {
  return compareReleaseTags({ tag }, { tag: UNATTESTED_V2_HISTORY_MAX_TAG }) > 0;
}

function activeAliasTargets(artifacts) {
  const lines = new Map();
  for (const artifact of Object.values(artifacts)) {
    const [major, minor] = artifact.version.split('.');
    for (const line of [`${major}`, `${major}.${minor}`]) {
      const previous = lines.get(line);
      if (!previous || compareReleaseTags({ tag: previous.tag }, { tag: artifact.tag }) < 0) {
        lines.set(line, artifact);
      }
    }
  }
  return lines;
}

function activeManifestVersions(artifacts) {
  const versions = Object.fromEntries(
    Object.values(artifacts).map(artifact => [`v${artifact.version}`, artifact.filename])
  );
  const lines = activeAliasTargets(artifacts);
  for (const line of lines.keys()) versions[`v${line}`] = `widget.v${line}.js`;
  return versions;
}

export function createGithubTransport({
  token,
  fetchImpl = fetch,
  apiUrl = 'https://api.github.com',
}) {
  if (typeof token !== 'string' || !token) fail('TOKEN_REQUIRED', 'an explicit token is required');
  const apiOrigin = new URL(apiUrl).origin;
  const storageOrigins = new Set([
    'https://objects.githubusercontent.com',
    'https://release-assets.githubusercontent.com',
    'https://github-releases.githubusercontent.com',
  ]);
  async function retryTransientRead(read, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await read();
      if (
        !RETRYABLE_READ_STATUSES.has(response.status) ||
        attempt === READ_RETRY_DELAYS_MS.length
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      await sleep(READ_RETRY_DELAYS_MS[attempt], undefined, { signal });
    }
  }
  async function boundedBytes(response, { expectedSize, maxBytes }) {
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
        fail('GITHUB_ASSET_FAILED', 'asset Content-Length exceeds its bound');
      if (expectedSize !== undefined && length !== expectedSize)
        fail('GITHUB_ASSET_FAILED', 'asset Content-Length differs from GitHub metadata');
    }
    if (!response.body) fail('GITHUB_ASSET_FAILED', 'asset response body is unavailable');
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail('GITHUB_ASSET_FAILED', 'asset exceeds its streamed byte bound');
      }
      chunks.push(Buffer.from(value));
    }
    if (expectedSize !== undefined && total !== expectedSize)
      fail('GITHUB_ASSET_FAILED', 'asset response is truncated or oversized');
    return Buffer.concat(chunks, total);
  }
  return {
    async request(path) {
      const response = await retryTransientRead(() =>
        fetchImpl(new URL(path, `${apiUrl.replace(/\/$/, '')}/`), {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': API_VERSION,
          },
          redirect: 'error',
        })
      );
      if (!response.ok) {
        fail('GITHUB_API_FAILED', `GitHub API returned ${response.status}`, {
          path: new URL(path, apiUrl).pathname,
          status: response.status,
        });
      }
      let data;
      try {
        data = await response.json();
      } catch {
        fail('GITHUB_API_INVALID_JSON', 'GitHub API response was not JSON');
      }
      return { data, hasNext: /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '') };
    },
    async requestBytes(path, options = {}) {
      const assetUrl = new URL(path, `${apiUrl.replace(/\/$/, '')}/`);
      const expectedPath =
        options.repository && options.assetId
          ? `/repos/${options.repository}/releases/assets/${options.assetId}`
          : null;
      if (
        assetUrl.origin !== apiOrigin ||
        !/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(assetUrl.pathname) ||
        (expectedPath && assetUrl.pathname !== expectedPath)
      ) {
        fail('GITHUB_ASSET_FAILED', 'asset API identity is outside the selected repository path');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
      try {
        const response = await retryTransientRead(async () => {
          let result = await fetchImpl(assetUrl, {
            headers: {
              accept: 'application/octet-stream',
              authorization: `Bearer ${token}`,
              'x-github-api-version': API_VERSION,
            },
            redirect: 'manual',
            signal: controller.signal,
          });
          if ([301, 302, 303, 307, 308].includes(result.status)) {
            const location = result.headers.get('location');
            let redirect;
            try {
              redirect = new URL(location);
            } catch {
              fail('GITHUB_ASSET_FAILED', 'GitHub asset redirect is malformed');
            }
            if (
              redirect.protocol !== 'https:' ||
              redirect.username ||
              redirect.password ||
              !storageOrigins.has(redirect.origin)
            ) {
              fail('GITHUB_ASSET_FAILED', 'GitHub asset redirect is not trusted HTTPS');
            }
            result = await fetchImpl(redirect, {
              headers: { accept: 'application/octet-stream' },
              redirect: 'error',
              signal: controller.signal,
            });
          }
          return result;
        }, controller.signal);
        if (!response.ok) {
          fail('GITHUB_ASSET_FAILED', `GitHub asset returned ${response.status}`, {
            status: response.status,
          });
        }
        const maxBytes = Math.min(options.maxBytes ?? MAX_WIDGET_BYTES, MAX_WIDGET_BYTES);
        return await boundedBytes(response, { expectedSize: options.expectedSize, maxBytes });
      } catch (error) {
        if (error instanceof GithubAdapterError) throw error;
        fail('GITHUB_ASSET_FAILED', 'GitHub asset request failed or timed out');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function paginateGithub(transport, path, { perPage = 100, maxPages = 100 } = {}) {
  const records = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await transport.request(`${path}${separator}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(result?.data)) {
      fail('GITHUB_API_INCOMPLETE', `${path} did not return an array`);
    }
    records.push(...result.data);
    if (result.hasNext === false) return records;
    if (result.hasNext !== true) {
      fail('GITHUB_API_INCOMPLETE', `${path} omitted pagination authority`);
    }
  }
  fail('GITHUB_API_INCOMPLETE', `${path} exceeded ${maxPages} pages`);
}

function decodeMarker(body) {
  const matches = [
    ...String(body ?? '').matchAll(/<!-- bugdrop-publication ([A-Za-z0-9_-]+) -->/g),
  ];
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail('AMBIGUOUS_MARKER', 'release body has multiple identity markers');
  try {
    return JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'));
  } catch {
    fail('INVALID_MARKER', 'release body identity marker is invalid');
  }
}

function validatePublicationMarker(marker, ref) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    fail('PUBLISHED_RELEASE_CONFLICT', 'publication marker must be a canonical object');
  }
  if (![RELEASE_PROTOCOL, RELEASE_PROTOCOL_V2].includes(marker.protocol)) {
    fail('PUBLISHED_RELEASE_CONFLICT', 'publication marker protocol is unsupported');
  }
  if (
    marker.protocol === RELEASE_PROTOCOL &&
    compareReleaseTags(ref, { tag: MARKERLESS_HISTORY_MAX_TAG }) > 0
  ) {
    fail('PUBLISHED_RELEASE_CONFLICT', 'v1 publication marker is beyond its historical boundary');
  }
  const requiresEvidence = Object.hasOwn(marker, 'requiredEvidence');
  if (
    marker.protocol === RELEASE_PROTOCOL_V2 &&
    requiresReleaseAttestation(ref.tag) &&
    !requiresEvidence
  ) {
    fail(
      'PUBLISHED_RELEASE_CONFLICT',
      'post-boundary v2 publication marker must require attestation evidence'
    );
  }
  let expected;
  try {
    expected = buildPublicationMarker(marker);
  } catch {
    fail('PUBLISHED_RELEASE_CONFLICT', 'publication marker fields are invalid');
  }
  if (requiresEvidence) {
    if (marker.protocol !== RELEASE_PROTOCOL_V2) {
      fail('PUBLISHED_RELEASE_CONFLICT', 'only v2 publication markers may require evidence');
    }
    expected = { ...expected, requiredEvidence: [ATTESTATION_ASSET] };
  }
  if (
    canonicalize(marker) !== canonicalize(expected) ||
    !IDENTITY_PATTERN.test(marker.planIdentity ?? '') ||
    !IDENTITY_PATTERN.test(marker.requestIdentity ?? '') ||
    !IDENTITY_PATTERN.test(marker.contentIdentity ?? '') ||
    !SHA_PATTERN.test(marker.targetSha ?? '') ||
    !TAG_PATTERN.test(marker.tag ?? '') ||
    marker.targetSha !== ref.sha ||
    marker.tag !== ref.tag
  ) {
    fail(
      'PUBLISHED_RELEASE_CONFLICT',
      'publication marker schema, identities, evidence, tag, or target are invalid'
    );
  }
  return expected;
}

function releaseMarker(ref, body) {
  const bodyMarker = decodeMarker(body);
  const tagMarker = ref.kind === 'annotated' ? ref.marker : null;
  if (
    bodyMarker === null &&
    tagMarker === null &&
    compareReleaseTags(ref, { tag: MARKERLESS_HISTORY_MAX_TAG }) <= 0
  ) {
    return null;
  }
  if (bodyMarker === null || tagMarker === null) {
    fail(
      'PUBLISHED_RELEASE_CONFLICT',
      'Release body and immutable annotated-tag markers must either both be absent or both be present'
    );
  }
  if (canonicalize(bodyMarker) !== canonicalize(tagMarker)) {
    fail(
      'PUBLISHED_RELEASE_CONFLICT',
      'Release body marker differs from the immutable annotated-tag marker'
    );
  }
  return validatePublicationMarker(tagMarker, ref);
}

function canonicalAsset(assets, name) {
  const bytes = assets?.[name];
  if (!Buffer.isBuffer(bytes)) fail('PUBLISHED_ASSET_MISSING', `${name} is unavailable`);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PUBLISHED_ASSET_INVALID', `${name} is not JSON`);
  }
  if (!bytes.equals(Buffer.from(`${canonicalize(value)}\n`))) {
    fail('PUBLISHED_ASSET_INVALID', `${name} is not canonical`);
  }
  return value;
}

function exactObjectKeys(value, keys) {
  return (
    value?.constructor === Object &&
    canonicalize(Object.keys(value).sort(compareUtf8)) === canonicalize([...keys].sort(compareUtf8))
  );
}

function validateDisabledManifest({
  manifest,
  release,
  requestPlan,
  releaseContent,
  exact,
  sha256,
}) {
  const version = release.tag.slice(1);
  const [major, minor] = version.split('.');
  const artifact = manifest?.artifacts?.[`v${version}`];
  const expectedVersions = {
    [`v${version}`]: exact.name,
    [`v${major}`]: `widget.v${major}.js`,
    [`v${major}.${minor}`]: `widget.v${major}.${minor}.js`,
  };
  if (
    requestPlan.retention?.mode !== 'disabled' ||
    !exactObjectKeys(manifest, [
      'artifacts',
      'authoritative',
      'current',
      'cutoverVersion',
      'generatedAt',
      'latest',
      'mode',
      'repository',
      'schema',
      'versions',
    ]) ||
    manifest.schema !== 'bugdrop.versions-manifest/v1' ||
    manifest.authoritative !== true ||
    manifest.mode !== 'release' ||
    manifest.current !== version ||
    manifest.cutoverVersion !== version ||
    manifest.generatedAt !== requestPlan.attestation.candidateCommitTimestamp ||
    manifest.latest !== 'widget.js' ||
    manifest.repository !== requestPlan.request.repository ||
    !exactObjectKeys(manifest.artifacts, [`v${version}`]) ||
    !exactObjectKeys(artifact, ['archiveUrl', 'filename', 'publishedAt', 'sha256', 'targetSha']) ||
    artifact.archiveUrl !== exact.downloadUrl ||
    artifact.filename !== exact.name ||
    artifact.publishedAt !== requestPlan.attestation.candidateCommitTimestamp ||
    artifact.sha256 !== sha256 ||
    artifact.targetSha !== release.targetSha ||
    canonicalize(manifest.versions) !== canonicalize(expectedVersions) ||
    releaseContent.staticPackage?.fileHashes?.[exact.name] !== sha256
  ) {
    fail('PUBLISHED_ASSET_INVALID', `${release.tag} disabled manifest is inconsistent`);
  }
}

function validateActiveManifest({
  manifest,
  manifestBytes,
  release,
  requestPlan,
  releaseContent,
  exact,
  exactSha256,
}) {
  const version = release.tag.slice(1);
  const retention = requestPlan.retention;
  const artifacts = Object.fromEntries([
    ...retention.releases.map(prior => [
      `v${prior.version}`,
      {
        downloadUrl: prior.asset.downloadUrl,
        filename: prior.asset.name,
        sha256: prior.asset.sha256,
        tag: prior.tag,
        targetSha: prior.targetSha,
        version: prior.version,
      },
    ]),
    [
      `v${version}`,
      {
        downloadUrl: exact.downloadUrl,
        filename: exact.name,
        sha256: exactSha256,
        tag: release.tag,
        targetSha: release.targetSha,
        version,
      },
    ],
  ]);
  const versions = activeManifestVersions(artifacts);
  const staticHashes = releaseContent.staticPackage?.fileHashes ?? {};
  const aliasesMatch = [
    ['widget.js', exactSha256],
    ...[...activeAliasTargets(artifacts)].map(([line, artifact]) => [
      `widget.v${line}.js`,
      artifact.sha256,
    ]),
  ].every(([filename, digest]) => staticHashes[filename] === digest);
  const expected = {
    artifacts,
    authoritative: true,
    current: version,
    cutoverVersion: retention.cutoverVersion,
    generatedAt: requestPlan.attestation.candidateCommitTimestamp,
    latest: 'widget.js',
    mode: 'release',
    repository: requestPlan.request.repository,
    schema: 'bugdrop.versions-manifest/v2',
    versions,
  };
  const manifestSha256 = sha256Bytes(manifestBytes);
  if (
    !['bootstrap', 'continue'].includes(retention.mode) ||
    canonicalize(manifest) !== canonicalize(expected) ||
    !aliasesMatch ||
    releaseContent.publicationAssetHashes?.['versions.json'] !== manifestSha256 ||
    releaseContent.staticPackage?.fileHashes?.['versions.json'] !== manifestSha256 ||
    releaseContent.staticPackage?.fileHashes?.[exact.name] !== exactSha256
  ) {
    fail('PUBLISHED_ASSET_INVALID', `${release.tag} active manifest is inconsistent`);
  }
}

export function authenticatePublishedAssets({ release, assets, attestation }) {
  if (release?.published !== true || release.draft !== false || release.prerelease !== false) {
    fail('PUBLISHED_RELEASE_INVALID', 'completed-plan assets must belong to a stable publication');
  }
  const requestPlan = canonicalAsset(assets, 'request-plan.json');
  const releaseContent = canonicalAsset(assets, 'release-content.json');
  const finalPlan = canonicalAsset(assets, 'final-release-plan.json');
  let expected;
  try {
    expected = validatePublicationBundle(
      { requestPlan, releaseContent, finalPlan, assets, ...(attestation ? { attestation } : {}) },
      { allowLegacy: !attestation, requireAttestation: Boolean(attestation) }
    );
  } catch (error) {
    fail('PUBLISHED_ASSET_INVALID', 'published assets do not authenticate', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    release.tag !== expected.tag ||
    release.targetSha !== expected.targetSha ||
    release.resolvedTagSha !== expected.targetSha ||
    canonicalize(release.marker) !== canonicalize(expected.marker)
  ) {
    fail('PUBLISHED_RELEASE_CONFLICT', 'published tag, target, or marker differs from its assets');
  }
  return {
    ...release,
    requestPlan,
    releaseContent,
    finalPlan,
    // The planning protocol authenticates its historical marker shape separately. The durable
    // Release marker (checked above) may additionally require provenance evidence without changing
    // deterministic State 2 identities.
    marker: buildPublicationMarker(finalPlan),
    assetVerification: {
      complete: true,
      checksumsMatch: true,
      unexpectedConflicts: false,
      planIdentity: expected.planIdentity,
      contentIdentity: expected.marker.contentIdentity,
      verifiedAssetNames: expected.contentAssets,
    },
    publishedAssets: assets,
  };
}

export async function loadPublishedReleaseAssets({
  transport,
  release,
  repository = release?.repository,
  verifyAttestation = verifyPortableAttestation,
}) {
  if (!Array.isArray(release?.assets) || release.assets.length === 0) {
    fail('PUBLISHED_ASSET_MISSING', 'published Release has no inspectable assets');
  }
  const assets = {};
  const budget = { used: 0 };
  for (const asset of release.assets) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(asset?.name ?? '') ||
      typeof asset?.apiUrl !== 'string' ||
      !asset.apiUrl.startsWith('https://') ||
      Object.hasOwn(assets, asset.name)
    ) {
      fail('PUBLISHED_ASSET_INVALID', 'published Release asset metadata is invalid');
    }
    if (
      !repository ||
      !/^\d+$/.test(asset.id ?? '') ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0
    ) {
      fail('PUBLISHED_ASSET_INVALID', 'published Release asset authority is incomplete');
    }
    if (budget.used + asset.size > MAX_SNAPSHOT_BYTES) {
      fail('PUBLISHED_ASSET_INVALID', 'published Release assets exceed the cumulative byte limit');
    }
    assets[asset.name] = await transport.requestBytes(asset.apiUrl, {
      repository,
      assetId: asset.id,
      expectedSize: asset.size,
      maxBytes: Math.min(MAX_WIDGET_BYTES, MAX_SNAPSHOT_BYTES - budget.used),
    });
    budget.used += assets[asset.name].length;
  }
  if (!Object.hasOwn(assets, ATTESTATION_ASSET)) {
    return authenticatePublishedAssets({ release, assets });
  }
  const coreAssets = { ...assets };
  const attestationBytes = coreAssets[ATTESTATION_ASSET];
  delete coreAssets[ATTESTATION_ASSET];
  const coreFinalPlan = canonicalAsset(coreAssets, 'final-release-plan.json');
  const core = authenticatePublishedAssets({
    release: { ...release, marker: buildPublicationMarker(coreFinalPlan) },
    assets: coreAssets,
  });
  const sourceRepository = publishedSourceRepository(
    release,
    repository,
    core.requestPlan.request.repository
  );
  let attestation;
  try {
    attestation = await verifyAttestation({
      bundle: {
        requestPlan: core.requestPlan,
        releaseContent: core.releaseContent,
        finalPlan: core.finalPlan,
        assets: coreAssets,
      },
      attestationBytes,
      policy: attestationPolicy({
        repository: sourceRepository,
        controllerSha: core.requestPlan.source.controllerSha,
      }),
    });
  } catch (error) {
    fail('PUBLISHED_ASSET_INVALID', 'published attestation does not authenticate', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return authenticatePublishedAssets({ release, assets, attestation });
}

function tagName(ref) {
  const prefix = 'refs/tags/';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    fail('INVALID_TAG_REF', 'matching-ref response contains an invalid ref');
  }
  return ref.slice(prefix.length);
}

async function resolveTag(transport, repository, ref) {
  const tag = tagName(ref.ref);
  const object = ref.object;
  if (!SHA_PATTERN.test(object?.sha ?? '') || !['commit', 'tag'].includes(object?.type)) {
    fail('INVALID_TAG_REF', `${tag} has an invalid Git object`);
  }
  if (object.type === 'commit') {
    return { tag, sha: object.sha, kind: 'lightweight', marker: null };
  }
  const result = await transport.request(`/repos/${repository}/git/tags/${object.sha}`);
  const target = result?.data?.object;
  if (
    result?.hasNext !== false ||
    target?.type !== 'commit' ||
    !SHA_PATTERN.test(target?.sha ?? '')
  ) {
    fail('INVALID_ANNOTATED_TAG', `${tag} does not resolve exactly to a commit`);
  }
  const annotation = String(result.data.message ?? '');
  const markerText = annotation.split('\n\n').at(-1);
  let marker = null;
  try {
    marker = JSON.parse(markerText);
  } catch {
    // Historical annotated tags do not need a BugDrop marker.
  }
  return { tag, sha: target.sha, kind: 'annotated', annotation, marker };
}

async function relationToTarget(transport, repository, releaseSha, targetSha) {
  const result = await transport.request(
    `/repos/${repository}/compare/${releaseSha}...${targetSha}`
  );
  if (result?.hasNext !== false) fail('GITHUB_API_INCOMPLETE', 'compare response was paginated');
  if (['ahead', 'identical'].includes(result?.data?.status)) return 'ancestor';
  if (result?.data?.status === 'behind') return 'descendant';
  fail('DIVERGENT_RELEASE_HISTORY', 'published release and candidate histories diverge');
}

export async function observeGithubState({ transport, repository, targetSha }) {
  assertInput(repository, targetSha);
  const [rawReleases, rawRefs] = await Promise.all([
    paginateGithub(transport, `/repos/${repository}/releases`),
    paginateGithub(transport, `/repos/${repository}/git/matching-refs/tags/v`),
  ]);
  const refs = await Promise.all(rawRefs.map(ref => resolveTag(transport, repository, ref)));
  const refByTag = new Map(refs.map(ref => [ref.tag, ref]));
  const releases = [];
  for (const release of rawReleases) {
    const tag = release?.tag_name;
    const ref = refByTag.get(tag);
    if (!TAG_PATTERN.test(tag ?? '') || !ref || typeof release?.draft !== 'boolean') {
      fail('INVALID_RELEASE', 'release list contains an unresolved or invalid stable tag');
    }
    const published = release.draft === false && release.published_at !== null;
    releases.push({
      id: String(release.id ?? ''),
      repository,
      tag,
      targetSha: ref.sha,
      draft: release.draft,
      prerelease: release.prerelease === true,
      published,
      url: String(release.html_url ?? ''),
      publishedAt: String(release.published_at ?? ''),
      assets: (release.assets ?? []).map(asset => ({
        id: String(asset?.id ?? ''),
        name: String(asset?.name ?? ''),
        apiUrl: String(asset?.url ?? ''),
        downloadUrl: String(asset?.browser_download_url ?? ''),
        size: Number(asset?.size),
      })),
      marker: releaseMarker(ref, release.body),
      relationToTarget:
        published && release.prerelease !== true
          ? await relationToTarget(transport, repository, ref.sha, targetSha)
          : undefined,
    });
  }
  return normalizeGithubState({ apiComplete: true, refs, releases });
}

async function requestRecord(transport, path, field) {
  const result = await transport.request(path);
  if (result?.hasNext !== false || !result?.data || typeof result.data !== 'object') {
    fail('GITHUB_API_INCOMPLETE', `${field} response is incomplete`);
  }
  return result.data;
}

async function observePullRequests(transport, repository, commits) {
  const pulls = new Map();
  for (const commit of commits) {
    const records = await paginateGithub(
      transport,
      `/repos/${repository}/commits/${commit.sha}/pulls`
    );
    for (const pull of records) {
      if (!Number.isSafeInteger(pull?.number) || !SHA_PATTERN.test(pull?.merge_commit_sha ?? '')) {
        fail('GITHUB_API_INCOMPLETE', 'associated pull request identity is incomplete');
      }
      pulls.set(pull.number, {
        number: pull.number,
        title: String(pull.title ?? ''),
        url: String(pull.html_url ?? ''),
        sha: pull.merge_commit_sha,
        labels: (pull.labels ?? []).map(label => String(label?.name ?? '')),
      });
    }
  }
  return [...pulls.values()];
}

export async function observeMergeQueuePreflight(transport, repository, targetSha) {
  const records = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await transport.request(
      `/repos/${repository}/actions/runs?head_sha=${targetSha}&event=merge_group&per_page=100&page=${page}`
    );
    if (!Array.isArray(result?.data?.workflow_runs)) {
      fail('GITHUB_API_INCOMPLETE', 'merge-queue workflow response is incomplete');
    }
    records.push(...result.data.workflow_runs);
    if (result.hasNext === false) break;
    if (result.hasNext !== true || page === 100) {
      fail('GITHUB_API_INCOMPLETE', 'merge-queue workflow pagination is incomplete');
    }
  }
  return (
    records.length > 0 &&
    records.every(
      run =>
        run?.head_sha === targetSha &&
        run?.event === 'merge_group' &&
        run?.status === 'completed' &&
        run?.conclusion === 'success'
    )
  );
}

export async function createRequestPlanFromGithub({
  transport,
  context,
  gitObserver = observeGitRange,
  verifyAttestation,
}) {
  const dispatch = normalizeDispatch({
    ...context?.dispatch,
    retentionBootstrap: context?.retentionBootstrap,
  });
  assertInput(dispatch.repository, dispatch.targetSha);
  let recovery = null;
  if (
    context.identityMainSha !== undefined ||
    context.resumePlanIdentity !== undefined ||
    context.identityMainReachableFromCurrent !== undefined ||
    context.controllerReachableFromCurrent !== undefined
  ) {
    if (
      !SHA_PATTERN.test(context.identityMainSha ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(context.resumePlanIdentity ?? '') ||
      context.identityMainReachableFromCurrent !== true ||
      context.controllerReachableFromCurrent !== true
    ) {
      fail(
        'UNAUTHENTICATED_PARTIAL_SOURCE',
        'stored controller, remote-main, and plan identities must remain authenticated'
      );
    }
    recovery = {
      identityMainSha: context.identityMainSha,
      planIdentity: context.resumePlanIdentity,
    };
  }
  const state = await observeGithubState({
    transport,
    repository: dispatch.repository,
    targetSha: dispatch.targetSha,
  });
  const exactPublished = state.releases.filter(
    release =>
      release.published &&
      !release.draft &&
      !release.prerelease &&
      release.targetSha === dispatch.targetSha
  );
  if (exactPublished.length > 1) {
    fail('COMPLETED_PLAN_AMBIGUOUS', 'multiple published Releases target this candidate');
  }
  if (exactPublished.length === 1) {
    const hydrated = await loadPublishedReleaseAssets({
      transport,
      release: exactPublished[0],
      ...(verifyAttestation ? { verifyAttestation } : {}),
    });
    const completed = findCompletedPlan({
      dispatch,
      releases: [hydrated],
      containsTarget: () => false,
    });
    if (
      recovery &&
      (hydrated.finalPlan.planIdentity !== recovery.planIdentity ||
        hydrated.requestPlan.source.controllerSha !== dispatch.controllerSha ||
        hydrated.requestPlan.source.remoteMainSha !== recovery.identityMainSha)
    ) {
      fail(
        'COMPLETED_PLAN_CONFLICT',
        'published plan differs from the authenticated recovery identity'
      );
    }
    return {
      status: 'completed',
      planIdentity: completed.planIdentity,
      tag: hydrated.tag,
      targetSha: hydrated.targetSha,
    };
  }
  const frontier = publishedFrontier(state);
  if (!frontier) fail('FRONTIER_MISSING', 'no stable published Release is available');
  const [remoteMain, preflightSuccessful] = await Promise.all([
    requestRecord(transport, `/repos/${dispatch.repository}/commits/main`, 'remote main'),
    observeMergeQueuePreflight(transport, dispatch.repository, dispatch.targetSha),
  ]);
  const identityMainSha = recovery?.identityMainSha ?? remoteMain.sha;
  const git = gitObserver({
    repositoryDir: context.repositoryDir,
    previousSha: frontier.targetSha,
    targetSha: dispatch.targetSha,
    mainSha: identityMainSha,
    controllerSha: dispatch.controllerSha,
  });
  const inventory = buildReleaseInventory({
    compareUrl: `https://github.com/${dispatch.repository}/compare/${frontier.tag}...${dispatch.targetSha}`,
    pullRequests: await observePullRequests(transport, dispatch.repository, git.commits),
    commits: git.commits,
    changedPaths: git.changedPaths,
    excludedNewerMainCommits: git.excludedNewerMainCommits,
  });
  validateSourceContext(dispatch, {
    ...git.facts,
    laterReleaseContainsTarget: state.published.some(
      release => release.relationToTarget === 'descendant'
    ),
    preflightSuccessful,
  });
  const nextTag = calculateNextTag(frontier.tag, dispatch.bump);
  const [major, minor] = nextTag.slice(1).split('.');
  const retentionReleases = [];
  const retainedBytes = {};
  let retainedBytesUsed = 0;
  for (const release of [...state.published].sort(compareReleaseTags)) {
    const version = release.tag.slice(1);
    if (release.marker?.protocol !== 'release-plan/v2') {
      retentionReleases.push({
        version,
        published: true,
        draft: false,
        prerelease: false,
        retention: null,
        retentionRecord: null,
      });
      continue;
    }
    const hydrated = await loadPublishedReleaseAssets({
      transport,
      release,
      repository: dispatch.repository,
      ...(verifyAttestation ? { verifyAttestation } : {}),
    });
    if (hydrated.requestPlan.protocol !== 'release-plan/v2') {
      fail('PUBLISHED_ASSET_INVALID', `${release.tag} v2 marker does not authenticate v2 assets`);
    }
    const exact = release.assets.find(asset => asset.name === `widget.v${version}.js`);
    if (!exact || !/^\d+$/.test(release.id) || !/^\d+$/.test(exact.id)) {
      fail('PUBLISHED_ASSET_INVALID', `${release.tag} lacks stable Release asset identity`);
    }
    const sha256 = hydrated.releaseContent.publicationAssetHashes?.[exact.name];
    const sourceRepository = publishedSourceRepository(
      release,
      dispatch.repository,
      hydrated.requestPlan.request.repository
    );
    const sourceExact = {
      ...exact,
      downloadUrl: `https://github.com/${sourceRepository}/releases/download/${release.tag}/${exact.name}`,
    };
    let sourceManifest;
    try {
      sourceManifest = JSON.parse(hydrated.publishedAssets['versions.json'].toString('utf8'));
    } catch {
      fail('PUBLISHED_ASSET_INVALID', `${release.tag} manifest is invalid`);
    }
    if (
      !hydrated.publishedAssets['versions.json'].equals(
        Buffer.from(`${canonicalize(sourceManifest)}\n`)
      ) ||
      exact.downloadUrl !==
        `https://github.com/${dispatch.repository}/releases/download/${release.tag}/${exact.name}`
    ) {
      fail(
        'PUBLISHED_ASSET_INVALID',
        `${release.tag} manifest or download identity is not canonical`
      );
    }
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
      fail('PUBLISHED_ASSET_INVALID', `${release.tag} exact bytes lack four-way authority`);
    }
    const sourceRetention = hydrated.requestPlan.retention;
    if (sourceRetention.mode === 'disabled') {
      validateDisabledManifest({
        manifest: sourceManifest,
        release,
        requestPlan: hydrated.requestPlan,
        releaseContent: hydrated.releaseContent,
        exact: sourceExact,
        sha256,
      });
      retentionReleases.push({
        version,
        published: true,
        draft: false,
        prerelease: false,
        retention: null,
        retentionRecord: null,
      });
      continue;
    }
    const authenticatedPrefix = retentionReleases
      .filter(item => ['bootstrap', 'continue'].includes(item.retention?.mode))
      .map(item => item.retentionRecord);
    if (canonicalize(sourceRetention.releases) !== canonicalize(authenticatedPrefix)) {
      fail(
        'PUBLISHED_ASSET_INVALID',
        `${release.tag} cumulative retention differs from authenticated preceding Releases`
      );
    }
    validateActiveManifest({
      manifest: sourceManifest,
      manifestBytes: hydrated.publishedAssets['versions.json'],
      release,
      requestPlan: hydrated.requestPlan,
      releaseContent: hydrated.releaseContent,
      exact: sourceExact,
      exactSha256: sha256,
    });
    const exactBytes = hydrated.publishedAssets[exact.name];
    if (retainedBytesUsed + exactBytes.length > MAX_RETAINED_BYTES) {
      fail('PUBLISHED_ASSET_INVALID', 'retained exact assets exceed the cumulative byte limit');
    }
    retainedBytesUsed += exactBytes.length;
    retentionReleases.push({
      version,
      published: true,
      draft: false,
      prerelease: false,
      retention: hydrated.requestPlan.retention,
      retentionRecord: {
        version,
        tag: release.tag,
        releaseId: release.id,
        targetSha: release.targetSha,
        publishedAt: release.publishedAt,
        sourcePlanIdentity: hydrated.finalPlan.planIdentity,
        sourceContentIdentity: hydrated.releaseContent.contentIdentity,
        asset: {
          assetId: exact.id,
          name: exact.name,
          apiPath: `/repos/${sourceRepository}/releases/assets/${exact.id}`,
          downloadUrl: sourceExact.downloadUrl,
          sha256,
        },
      },
    });
    retainedBytes[version] = exactBytes;
  }
  const retention = deriveRetentionRequest({
    candidateVersion: nextTag.slice(1),
    retentionBootstrap: context.retentionBootstrap === true,
    releases: retentionReleases,
  });
  const requestPlan = buildRequestPlan({
    dispatch,
    previousTag: frontier.tag,
    nextTag,
    generatedNotes: inventory.generatedNotes,
    controllerSha: dispatch.controllerSha,
    remoteMainSha: identityMainSha,
    inventory,
    retentionBootstrap: context.retentionBootstrap === true,
    retention,
    attestation: {
      previousReleaseSha: frontier.targetSha,
      candidateCommitTimestamp: git.candidateCommitTimestamp,
      candidateBehindMainBy: git.candidateBehindMainBy,
      expectedAliases: ['widget.js', `widget.v${major}.js`, `widget.v${major}.${minor}.js`],
      expectedAssetNames: [`widget.${nextTag}.js`, 'versions.json'],
      verificationCommands: ['npm run validate', 'npm run build'],
    },
  });
  if (context.retentionOutputDir) {
    await writeRetentionInput({
      root: context.retentionOutputDir,
      requestIdentity: requestPlan.requestIdentity,
      retention,
      assets: retainedBytes,
    });
  }
  return requestPlan;
}

async function runCli() {
  const [mode, inputPath] = process.argv.slice(2);
  if (!['observe', 'plan'].includes(mode) || !inputPath) {
    fail('INVALID_CLI', 'usage: github-adapter.mjs observe|plan INPUT.json');
  }
  const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const token = process.env.BUGDROP_GITHUB_TOKEN;
  const transport = createGithubTransport({ token, apiUrl: input.apiUrl });
  const output =
    mode === 'observe'
      ? await observeGithubState({ ...input, transport })
      : await createRequestPlanFromGithub({ context: input, transport });
  process.stdout.write(`${canonicalize(output)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
