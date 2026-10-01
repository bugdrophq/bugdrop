import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalHash, canonicalize, compareUtf8 } from '../../scripts/release/canonical-json.mjs';
import { attestationPolicy, attestationSubjects } from '../../scripts/release/attestation.mjs';
import { validatePublicationBundle } from '../../scripts/release/publication.mjs';
import {
  authenticatePublishedAssets,
  createGithubTransport,
  createRequestPlanFromGithub,
  GithubAdapterError,
  loadPublishedReleaseAssets,
  observeMergeQueuePreflight,
  observeGithubState,
  paginateGithub,
} from '../../scripts/release/github-adapter.mjs';
import {
  buildPublicationMarker,
  findCompletedPlan,
  normalizeDispatch,
} from '../../scripts/release/plan.mjs';
import {
  bootstrapV2WorkflowBundle,
  disabledV2WorkflowBundle,
  workflowBundle,
  workflowContext,
} from '../fixtures/release/workflow/bundle';

const SHA = {
  target: 'a'.repeat(40),
  tagObject: 'b'.repeat(40),
  release: 'c'.repeat(40),
};
const REPOSITORY = 'mean-weasel/bugdrop';
const TRANSFERRED_REPOSITORY = 'bugdrophq/bugdrop';

function releaseBody(marker: unknown) {
  return `<!-- bugdrop-publication ${Buffer.from(canonicalize(marker)).toString('base64url')} -->`;
}

function withAttestation(bundle: ReturnType<typeof disabledV2WorkflowBundle>) {
  const evidence = Buffer.from('{"signed":"portable"}\n');
  const attestation = {
    protocol: 'bugdrop.release-attestation/v1',
    status: 'verified',
    asset: 'attestation.intoto.jsonl',
    bundleSha256: createHash('sha256').update(evidence).digest('hex'),
    policy: attestationPolicy({
      repository: REPOSITORY,
      controllerSha: bundle.requestPlan.source.controllerSha,
    }),
    subjects: attestationSubjects(bundle),
  };
  return {
    ...bundle,
    assets: { ...bundle.assets, 'attestation.intoto.jsonl': evidence },
    attestation,
  };
}

function transportFor(entries: Record<string, unknown>) {
  return {
    request: vi.fn(async (path: string) => {
      if (!Object.hasOwn(entries, path)) throw new Error(`unexpected request ${path}`);
      return entries[path];
    }),
  };
}

function observationEntries() {
  return {
    [`/repos/${REPOSITORY}/releases?per_page=100&page=1`]: {
      data: [
        {
          id: 7,
          tag_name: 'v1.55.0',
          draft: false,
          prerelease: false,
          published_at: '2026-08-01T00:00:00Z',
          html_url: 'https://github.test/releases/v1.55.0',
          body: 'Notes',
        },
      ],
      hasNext: false,
    },
    [`/repos/${REPOSITORY}/git/matching-refs/tags/v?per_page=100&page=1`]: {
      data: [
        {
          ref: 'refs/tags/v1.55.0',
          object: { type: 'tag', sha: SHA.tagObject },
        },
      ],
      hasNext: false,
    },
    [`/repos/${REPOSITORY}/git/tags/${SHA.tagObject}`]: {
      data: { object: { type: 'commit', sha: SHA.release }, message: 'BugDrop v1.55.0' },
      hasNext: false,
    },
    [`/repos/${REPOSITORY}/compare/${SHA.release}...${SHA.target}`]: {
      data: { status: 'ahead' },
      hasNext: false,
    },
  };
}

function publishedBundleRecord(
  bundle: ReturnType<typeof disabledV2WorkflowBundle>,
  index: number,
  immutableMarker = true,
  tagMarkerMode: 'valid' | 'missing' | 'malformed' = 'valid',
  markerTransform: (marker: unknown) => unknown = marker => marker,
  selectedRepository = REPOSITORY
) {
  const attested = bundle as ReturnType<typeof disabledV2WorkflowBundle> & {
    attestation?: Record<string, unknown>;
  };
  const marker = markerTransform(
    attested.attestation
      ? validatePublicationBundle(attested, { requireAttestation: true }).marker
      : buildPublicationMarker(bundle.finalPlan)
  );
  const authorityIndex = Number.parseInt(bundle.finalPlan.targetSha[0], 16) || index;
  const tagObjectSha = authorityIndex.toString(16).slice(-1).repeat(40);
  const tagMessage = {
    valid: `BugDrop ${bundle.finalPlan.tag}\n\n${canonicalize(marker)}`,
    missing: `BugDrop ${bundle.finalPlan.tag}`,
    malformed: `BugDrop ${bundle.finalPlan.tag}\n\n{not-json`,
  }[tagMarkerMode];
  return {
    release: {
      id: 100 + authorityIndex,
      tag_name: bundle.finalPlan.tag,
      draft: false,
      prerelease: false,
      published_at: bundle.requestPlan.attestation.candidateCommitTimestamp,
      html_url: `https://github.test/releases/${bundle.finalPlan.tag}`,
      body: releaseBody(marker),
      assets: Object.keys(bundle.assets).map((name, assetIndex) => ({
        id: authorityIndex * 100 + assetIndex + 1,
        name,
        url: `https://api.github.test/repos/${selectedRepository}/releases/assets/${authorityIndex * 100 + assetIndex + 1}`,
        browser_download_url: `https://github.com/${selectedRepository}/releases/download/${bundle.finalPlan.tag}/${name}`,
        size: bundle.assets[name].length,
      })),
    },
    ref: {
      ref: `refs/tags/${bundle.finalPlan.tag}`,
      object: immutableMarker
        ? { type: 'tag', sha: tagObjectSha }
        : { type: 'commit', sha: bundle.finalPlan.targetSha },
    },
    tagObject: immutableMarker
      ? {
          path: `/repos/${selectedRepository}/git/tags/${tagObjectSha}`,
          response: {
            data: {
              object: { type: 'commit', sha: bundle.finalPlan.targetSha },
              message: tagMessage,
            },
            hasNext: false,
          },
        }
      : null,
    bundle,
  };
}

async function planFromPublishedBundles({
  bundles,
  candidateSha = '9'.repeat(40),
  retentionBootstrap = false,
  legacy = [],
  reverseAssets = false,
  downloadDelay = 0,
  releaseTransform = (release: Record<string, unknown>) => release,
  immutableTagMarkers = true,
  tagMarkerMode = 'valid',
  markerTransform = (marker: unknown) => marker,
  requestBytes,
  verifyAttestation,
  selectedRepository = REPOSITORY,
}: {
  bundles: ReturnType<typeof disabledV2WorkflowBundle>[];
  candidateSha?: string;
  retentionBootstrap?: boolean;
  legacy?: Array<{ tag: string; targetSha: string }>;
  reverseAssets?: boolean;
  downloadDelay?: number;
  releaseTransform?: (release: Record<string, unknown>, index: number) => Record<string, unknown>;
  immutableTagMarkers?: boolean;
  tagMarkerMode?: 'valid' | 'missing' | 'malformed';
  markerTransform?: (marker: unknown) => unknown;
  requestBytes?: (_url: string, options: { assetId: string }) => Promise<Buffer>;
  verifyAttestation?: (input: unknown) => Promise<unknown>;
  selectedRepository?: string;
}) {
  const records = bundles.map((bundle, index) =>
    publishedBundleRecord(
      bundle,
      index + 1,
      immutableTagMarkers,
      tagMarkerMode,
      markerTransform,
      selectedRepository
    )
  );
  const bundledAttestation = bundles
    .map(
      bundle =>
        (bundle as ReturnType<typeof disabledV2WorkflowBundle> & { attestation?: unknown })
          .attestation
    )
    .find(Boolean);
  const effectiveVerifyAttestation =
    verifyAttestation ?? (bundledAttestation ? async () => bundledAttestation : undefined);
  records.forEach((record, index) => {
    record.release = releaseTransform(record.release, index) as typeof record.release;
  });
  if (reverseAssets) records.forEach(record => record.release.assets.reverse());
  const assetBytes = new Map<string, Buffer>();
  for (const record of records) {
    for (const asset of record.release.assets) {
      assetBytes.set(String(asset.id), record.bundle.assets[asset.name]);
    }
  }
  const releases = [
    ...records.map(record => record.release),
    ...legacy.map((item, index) => ({
      id: 900 + index,
      tag_name: item.tag,
      draft: false,
      prerelease: false,
      published_at: `2026-08-${String(20 + index).padStart(2, '0')}T00:00:00Z`,
      html_url: `https://github.test/releases/${item.tag}`,
      body: '',
      assets: [],
    })),
  ];
  const refs = [
    ...records.map(record => record.ref),
    ...legacy.map(item => ({
      ref: `refs/tags/${item.tag}`,
      object: { type: 'commit', sha: item.targetSha },
    })),
  ];
  const transport = transportFor({
    [`/repos/${selectedRepository}/releases?per_page=100&page=1`]: {
      data: releases,
      hasNext: false,
    },
    [`/repos/${selectedRepository}/git/matching-refs/tags/v?per_page=100&page=1`]: {
      data: refs,
      hasNext: false,
    },
    ...Object.fromEntries(
      records
        .filter(record => record.tagObject)
        .map(record => [record.tagObject!.path, record.tagObject!.response])
    ),
    ...Object.fromEntries(
      [
        ...records.map(record => record.bundle.finalPlan.targetSha),
        ...legacy.map(x => x.targetSha),
      ].map(sha => [
        `/repos/${selectedRepository}/compare/${sha}...${candidateSha}`,
        { data: { status: 'ahead' }, hasNext: false },
      ])
    ),
    [`/repos/${selectedRepository}/commits/main`]: { data: { sha: candidateSha }, hasNext: false },
    [`/repos/${selectedRepository}/actions/runs?head_sha=${candidateSha}&event=merge_group&per_page=100&page=1`]:
      {
        data: {
          workflow_runs: [
            {
              head_sha: candidateSha,
              event: 'merge_group',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
        hasNext: false,
      },
    [`/repos/${selectedRepository}/commits/${candidateSha}/pulls?per_page=100&page=1`]: {
      data: [],
      hasNext: false,
    },
  });
  Object.assign(transport, {
    requestBytes:
      requestBytes ??
      vi.fn(async (_url: string, options: { assetId: string }) => {
        if (downloadDelay) await new Promise(resolve => setTimeout(resolve, downloadDelay));
        const bytes = assetBytes.get(options.assetId);
        if (!bytes) throw new Error(`missing asset ${options.assetId}`);
        return bytes;
      }),
  });
  return createRequestPlanFromGithub({
    transport,
    context: {
      repositoryDir: '/controller',
      retentionBootstrap,
      dispatch: {
        ...workflowContext(false).dispatch,
        repository: selectedRepository,
        targetSha: candidateSha,
        bump: 'patch',
      },
    },
    gitObserver: () => ({
      commits: [{ sha: candidateSha, subject: 'candidate' }],
      changedPaths: ['src/index.ts'],
      excludedNewerMainCommits: [],
      candidateCommitTimestamp: '2026-08-30T00:00:00Z',
      candidateBehindMainBy: 0,
      facts: {
        candidateRef: 'refs/heads/main',
        targetExists: true,
        targetReachableFromMain: true,
        controllerReachableFromMain: true,
        previousReleaseAncestor: true,
        targetStrictlyLater: true,
      },
    }),
    ...(effectiveVerifyAttestation ? { verifyAttestation: effectiveVerifyAttestation } : {}),
  });
}

function activeHistoryBundles({
  continuationManifestTransform = (value: Record<string, unknown>) => value,
  continuationStaticManifestHash = null,
  continuationRetentionTransform = (value: Record<string, unknown>) => value,
} = {}) {
  const bootstrap = bootstrapV2WorkflowBundle({
    previousTag: 'v1.54.0',
    nextTag: 'v1.55.0',
    bump: 'minor',
    targetSha: '1'.repeat(40),
    timestamp: '2026-08-10T00:00:00Z',
  });
  const bootstrapAsset = bootstrap.assets['widget.v1.55.0.js'];
  const retention = continuationRetentionTransform({
    schema: 'bugdrop.retention-request/v1',
    mode: 'continue',
    cutoverVersion: '1.55.0',
    expectedRetainedVersions: ['1.55.0'],
    releases: [
      {
        version: '1.55.0',
        tag: 'v1.55.0',
        releaseId: '101',
        targetSha: '1'.repeat(40),
        publishedAt: '2026-08-10T00:00:00Z',
        sourcePlanIdentity: bootstrap.finalPlan.planIdentity,
        sourceContentIdentity: bootstrap.releaseContent.contentIdentity,
        asset: {
          assetId: '101',
          name: 'widget.v1.55.0.js',
          apiPath: `/repos/${REPOSITORY}/releases/assets/101`,
          downloadUrl:
            'https://github.com/mean-weasel/bugdrop/releases/download/v1.55.0/widget.v1.55.0.js',
          sha256: createHash('sha256').update(bootstrapAsset).digest('hex'),
        },
      },
    ],
  });
  const continuation = disabledV2WorkflowBundle({
    previousTag: 'v1.55.0',
    nextTag: 'v1.56.0',
    bump: 'minor',
    targetSha: '2'.repeat(40),
    timestamp: '2026-08-11T00:00:00Z',
    retentionMode: 'continue',
    retentionOverride: retention,
    manifestTransform: continuationManifestTransform,
    staticManifestHashOverride: continuationStaticManifestHash,
  });
  return [bootstrap, withAttestation(continuation)];
}

function rebindPublishedBundle(bundle: ReturnType<typeof disabledV2WorkflowBundle>) {
  bundle.requestPlan.requestIdentity = canonicalHash({
    schema: bundle.requestPlan.schema,
    protocol: bundle.requestPlan.protocol,
    request: bundle.requestPlan.request,
    source: bundle.requestPlan.source,
    attestation: bundle.requestPlan.attestation,
    inventory: bundle.requestPlan.inventory,
    retention: bundle.requestPlan.retention,
  });
  bundle.releaseContent.requestIdentity = bundle.requestPlan.requestIdentity;
  const contentPayload = { ...bundle.releaseContent };
  delete contentPayload.contentIdentity;
  bundle.releaseContent.contentIdentity = canonicalHash(contentPayload);
  Object.assign(bundle.finalPlan, {
    requestIdentity: bundle.requestPlan.requestIdentity,
    contentIdentity: bundle.releaseContent.contentIdentity,
    requestPlanHash: canonicalHash(bundle.requestPlan),
  });
  const finalPayload = { ...bundle.finalPlan };
  delete finalPayload.planIdentity;
  bundle.finalPlan.planIdentity = canonicalHash(finalPayload);
  Object.assign(bundle.assets, {
    'request-plan.json': Buffer.from(`${canonicalize(bundle.requestPlan)}\n`),
    'release-content.json': Buffer.from(`${canonicalize(bundle.releaseContent)}\n`),
    'final-release-plan.json': Buffer.from(`${canonicalize(bundle.finalPlan)}\n`),
  });
  const checksums = Object.entries(bundle.assets)
    .filter(([name]) => !['checksums.sha256', 'attestation.intoto.jsonl'].includes(name))
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
    .join('\n');
  bundle.assets['checksums.sha256'] = Buffer.from(`${checksums}\n`);
  const attested = bundle as ReturnType<typeof disabledV2WorkflowBundle> & {
    attestation?: Record<string, unknown>;
  };
  if (attested.attestation) {
    const coreAssets = { ...bundle.assets };
    delete coreAssets['attestation.intoto.jsonl'];
    attested.attestation = {
      ...attested.attestation,
      subjects: attestationSubjects({
        requestPlan: bundle.requestPlan,
        releaseContent: bundle.releaseContent,
        finalPlan: bundle.finalPlan,
        assets: coreAssets,
      }),
    };
  }
  return bundle;
}

describe('GitHub release-state observation', () => {
  it('proves preflight from merge-queue runs without observing the active release run', async () => {
    const path = `/repos/${REPOSITORY}/actions/runs?head_sha=${SHA.target}&event=merge_group&per_page=100&page=1`;
    const transport = transportFor({
      [path]: {
        data: {
          workflow_runs: [
            {
              head_sha: SHA.target,
              event: 'merge_group',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
        hasNext: false,
      },
    });

    await expect(observeMergeQueuePreflight(transport, REPOSITORY, SHA.target)).resolves.toBe(true);
    expect(transport.request).toHaveBeenCalledWith(path);
  });

  it('fails preflight closed when the exact merge-queue run failed', async () => {
    const path = `/repos/${REPOSITORY}/actions/runs?head_sha=${SHA.target}&event=merge_group&per_page=100&page=1`;
    const transport = transportFor({
      [path]: {
        data: {
          workflow_runs: [
            {
              head_sha: SHA.target,
              event: 'merge_group',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        },
        hasNext: false,
      },
    });

    await expect(observeMergeQueuePreflight(transport, REPOSITORY, SHA.target)).resolves.toBe(
      false
    );
  });

  it('builds a deterministic request plan from complete authenticated observations', async () => {
    const storedMain = 'd'.repeat(40);
    const entries = observationEntries();
    entries[`/repos/${REPOSITORY}/compare/${SHA.release}...${SHA.target}`] = {
      data: {
        status: 'ahead',
        ahead_by: 1,
        html_url: 'https://github.test/compare/v1.55.0...candidate',
        commits: [
          {
            sha: SHA.target,
            commit: { message: 'Ship guarded workflow\n\nBody' },
          },
        ],
        files: [{ filename: 'src/index.ts' }],
      },
      hasNext: false,
    };
    Object.assign(entries, {
      [`/repos/${REPOSITORY}/commits/${SHA.target}`]: {
        data: {
          sha: SHA.target,
          commit: { committer: { date: '2026-08-03T00:00:00Z' } },
        },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/commits/main`]: {
        data: { sha: SHA.target },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/compare/${SHA.release}...main`]: {
        data: { status: 'ahead' },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/actions/runs?head_sha=${SHA.target}&event=merge_group&per_page=100&page=1`]:
        {
          data: {
            workflow_runs: [
              {
                head_sha: SHA.target,
                event: 'merge_group',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
          hasNext: false,
        },
      [`/repos/${REPOSITORY}/compare/${SHA.target}...main`]: {
        data: { status: 'identical' },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/compare/${SHA.target}...${SHA.target}`]: {
        data: { status: 'identical', ahead_by: 0 },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/commits/${SHA.target}/pulls?per_page=100&page=1`]: {
        data: [
          {
            number: 42,
            title: 'Ship guarded workflow',
            html_url: 'https://github.test/pull/42',
            merge_commit_sha: SHA.target,
            labels: [{ name: 'enhancement' }],
          },
        ],
        hasNext: false,
      },
    });
    const gitObserver = vi.fn(() => ({
      commits: [{ sha: SHA.target, subject: 'Ship guarded workflow' }],
      changedPaths: ['src/index.ts'],
      excludedNewerMainCommits: [],
      candidateCommitTimestamp: '2026-08-03T00:00:00Z',
      candidateBehindMainBy: 0,
      facts: {
        candidateRef: 'refs/heads/main',
        targetExists: true,
        targetReachableFromMain: true,
        previousReleaseAncestor: true,
        targetStrictlyLater: true,
        controllerReachableFromMain: true,
      },
    }));
    const plan = await createRequestPlanFromGithub({
      transport: transportFor(entries),
      gitObserver,
      context: {
        controllerReachableFromCurrent: true,
        identityMainReachableFromCurrent: true,
        identityMainSha: storedMain,
        resumePlanIdentity: `sha256:${'e'.repeat(64)}`,
        repositoryDir: '/controller',
        dispatch: {
          repository: REPOSITORY,
          workflowRef: '.github/workflows/deploy.yml@refs/heads/main',
          targetSha: SHA.target,
          controllerSha: SHA.release,
          bump: 'patch',
          releaseReason: 'standard',
          rationale: '',
          operatorNotes: '',
          dryRun: true,
        },
      },
    });
    expect(plan).toMatchObject({
      request: { previousTag: 'v1.55.0', nextTag: 'v1.55.1', targetSha: SHA.target },
      source: { controllerSha: SHA.release, remoteMainSha: storedMain },
      attestation: {
        expectedAliases: ['widget.js', 'widget.v1.js', 'widget.v1.55.js'],
        expectedAssetNames: ['widget.v1.55.1.js', 'versions.json'],
      },
    });
    expect(gitObserver).toHaveBeenCalledWith(
      expect.objectContaining({ mainSha: storedMain, controllerSha: SHA.release })
    );
    expect(plan.inventory.pullRequests).toHaveLength(1);
  });

  it('reconstructs an exact completed plan from durable canonical Release assets', () => {
    const bundle = workflowBundle();
    const release = authenticatePublishedAssets({
      release: {
        tag: bundle.finalPlan.tag,
        targetSha: bundle.finalPlan.targetSha,
        resolvedTagSha: bundle.finalPlan.targetSha,
        published: true,
        draft: false,
        prerelease: false,
        marker: buildPublicationMarker(bundle.finalPlan),
      },
      assets: bundle.assets,
    });
    expect(
      findCompletedPlan({
        dispatch: normalizeDispatch(workflowContext(false).dispatch),
        releases: [release],
        containsTarget: () => false,
      })
    ).toMatchObject({ kind: 'completed', planIdentity: bundle.finalPlan.planIdentity });

    expect(() =>
      authenticatePublishedAssets({
        release,
        assets: {
          ...bundle.assets,
          'request-plan.json': Buffer.from('{}\n'),
        },
      })
    ).toThrow(GithubAdapterError);
  });

  it('downloads every named Release asset through the injected binary transport', async () => {
    const bundle = workflowBundle();
    const release = {
      tag: bundle.finalPlan.tag,
      targetSha: bundle.finalPlan.targetSha,
      resolvedTagSha: bundle.finalPlan.targetSha,
      published: true,
      draft: false,
      prerelease: false,
      marker: buildPublicationMarker(bundle.finalPlan),
      repository: REPOSITORY,
      assets: Object.keys(bundle.assets).map((name, index) => ({
        id: String(index + 1),
        name,
        apiUrl: `https://api.github.test/repos/${REPOSITORY}/releases/assets/${index + 1}`,
        size: bundle.assets[name].length,
      })),
    };
    const requestBytes = vi.fn(async (_url: string, options: { assetId: string }) => {
      const name = Object.keys(bundle.assets)[Number(options.assetId) - 1];
      return bundle.assets[name];
    });
    await expect(
      loadPublishedReleaseAssets({ transport: { requestBytes }, release })
    ).resolves.toMatchObject({
      finalPlan: { planIdentity: bundle.finalPlan.planIdentity },
      assetVerification: { complete: true, checksumsMatch: true },
    });
    expect(requestBytes).toHaveBeenCalledTimes(bundle.finalPlan.requiredAssets.length);
  });

  it('cryptographically authenticates the seventh evidence asset for completed-plan reuse', async () => {
    const bundle = workflowBundle();
    const evidence = Buffer.from('{"signed":"portable"}\n');
    const assets = { ...bundle.assets, 'attestation.intoto.jsonl': evidence };
    const names = Object.keys(assets);
    const attestation = {
      protocol: 'bugdrop.release-attestation/v1',
      status: 'verified',
      asset: 'attestation.intoto.jsonl',
      bundleSha256: createHash('sha256').update(evidence).digest('hex'),
      policy: attestationPolicy({
        repository: REPOSITORY,
        controllerSha: bundle.requestPlan.source.controllerSha,
      }),
      subjects: attestationSubjects(bundle),
    };
    const marker = validatePublicationBundle(
      { ...bundle, assets, attestation },
      { requireAttestation: true }
    ).marker;
    const release = {
      tag: bundle.finalPlan.tag,
      targetSha: bundle.finalPlan.targetSha,
      resolvedTagSha: bundle.finalPlan.targetSha,
      published: true,
      draft: false,
      prerelease: false,
      marker,
      repository: REPOSITORY,
      assets: names.map((name, index) => ({
        id: String(index + 1),
        name,
        apiUrl: `https://api.github.test/repos/${REPOSITORY}/releases/assets/${index + 1}`,
        size: assets[name].length,
      })),
    };
    const verifyAttestation = vi.fn(async () => attestation);
    const requestBytes = vi.fn(async (_url: string, options: { assetId: string }) => {
      if (options.assetId === '99') return Buffer.from('x');
      return assets[names[Number(options.assetId) - 1]];
    });

    const hydrated = await loadPublishedReleaseAssets({
      transport: { requestBytes },
      release,
      verifyAttestation,
    });
    expect(hydrated).toMatchObject({
      assetVerification: {
        complete: true,
        verifiedAssetNames: expect.arrayContaining(bundle.finalPlan.requiredAssets),
      },
    });
    expect(
      findCompletedPlan({
        dispatch: normalizeDispatch(workflowContext(false).dispatch),
        releases: [hydrated],
        containsTarget: () => false,
      })
    ).toMatchObject({ kind: 'completed', planIdentity: bundle.finalPlan.planIdentity });
    expect(verifyAttestation).toHaveBeenCalledOnce();

    await expect(
      loadPublishedReleaseAssets({
        transport: { requestBytes },
        release: {
          ...release,
          assets: release.assets.filter(asset => asset.name !== 'attestation.intoto.jsonl'),
        },
        verifyAttestation,
      })
    ).rejects.toBeInstanceOf(GithubAdapterError);

    await expect(
      loadPublishedReleaseAssets({
        transport: { requestBytes },
        release: { ...release, marker: buildPublicationMarker(bundle.finalPlan) },
        verifyAttestation,
      })
    ).rejects.toBeInstanceOf(GithubAdapterError);

    release.assets.push({
      id: '99',
      name: 'unexpected.bin',
      apiUrl: `https://api.github.test/repos/${REPOSITORY}/releases/assets/99`,
      size: 1,
    });
    await expect(
      loadPublishedReleaseAssets({ transport: { requestBytes }, release, verifyAttestation })
    ).rejects.toBeInstanceOf(GithubAdapterError);
  });

  it('requires marked provenance while loading the N+1 publication frontier', async () => {
    const bundle = disabledV2WorkflowBundle();
    const evidence = Buffer.from('{"signed":"portable"}\n');
    const assets = { ...bundle.assets, 'attestation.intoto.jsonl': evidence };
    const attestation = {
      protocol: 'bugdrop.release-attestation/v1',
      status: 'verified',
      asset: 'attestation.intoto.jsonl',
      bundleSha256: createHash('sha256').update(evidence).digest('hex'),
      policy: attestationPolicy({
        repository: REPOSITORY,
        controllerSha: bundle.requestPlan.source.controllerSha,
      }),
      subjects: attestationSubjects(bundle),
    };
    const attested = { ...bundle, assets, attestation };
    const verifyAttestation = vi.fn(async () => attestation);

    await expect(
      planFromPublishedBundles({ bundles: [attested], verifyAttestation })
    ).resolves.toMatchObject({ request: { previousTag: bundle.finalPlan.tag } });
    await expect(
      planFromPublishedBundles({
        bundles: [attested],
        verifyAttestation,
        releaseTransform: release => ({
          ...release,
          assets: (release.assets as Array<{ name: string }>).filter(
            asset => asset.name !== 'attestation.intoto.jsonl'
          ),
        }),
      })
    ).rejects.toBeInstanceOf(GithubAdapterError);
  });

  it('rejects deletion plus editable body downgrade against the immutable tag marker', async () => {
    const original = disabledV2WorkflowBundle();
    const attested = withAttestation(original);
    const verifyAttestation = vi.fn(async () => attested.attestation);
    const historicalBody = releaseBody(buildPublicationMarker(original.finalPlan));
    const deleteEvidenceAndRewriteBody = (release: Record<string, unknown>) => ({
      ...release,
      body: historicalBody,
      assets: (release.assets as Array<{ name: string }>).filter(
        asset => asset.name !== 'attestation.intoto.jsonl'
      ),
    });

    for (const candidateSha of [original.finalPlan.targetSha, '9'.repeat(40)]) {
      await expect(
        planFromPublishedBundles({
          bundles: [attested],
          candidateSha,
          immutableTagMarkers: true,
          releaseTransform: deleteEvidenceAndRewriteBody,
          verifyAttestation,
        })
      ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
    }
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '9'.repeat(40)],
  ])(
    'rejects evidence deletion plus body-marker removal on the %s path',
    async (_path, candidateShaFor) => {
      const original = disabledV2WorkflowBundle();
      const attested = withAttestation(original);
      const verifyAttestation = vi.fn(async () => attested.attestation);

      await expect(
        planFromPublishedBundles({
          bundles: [attested],
          candidateSha: candidateShaFor(original),
          immutableTagMarkers: true,
          releaseTransform: release => ({
            ...release,
            body: '',
            assets: (release.assets as Array<{ name: string }>).filter(
              asset => asset.name !== 'attestation.intoto.jsonl'
            ),
          }),
          verifyAttestation,
        })
      ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
      expect(verifyAttestation).not.toHaveBeenCalled();
    }
  );

  it('rejects lightweight, markerless, and malformed tag replacements after body downgrade', async () => {
    const original = disabledV2WorkflowBundle();
    const attested = withAttestation(original);
    const historicalBody = releaseBody(buildPublicationMarker(original.finalPlan));
    const downgradedRelease = (release: Record<string, unknown>) => ({
      ...release,
      body: historicalBody,
      assets: (release.assets as Array<{ name: string }>).filter(
        asset => asset.name !== 'attestation.intoto.jsonl'
      ),
    });
    const variants = [
      { immutableTagMarkers: false as const, tagMarkerMode: 'valid' as const },
      { immutableTagMarkers: true as const, tagMarkerMode: 'missing' as const },
      { immutableTagMarkers: true as const, tagMarkerMode: 'malformed' as const },
    ];

    for (const variant of variants) {
      for (const candidateSha of [original.finalPlan.targetSha, '9'.repeat(40)]) {
        await expect(
          planFromPublishedBundles({
            bundles: [attested],
            candidateSha,
            releaseTransform: downgradedRelease,
            ...variant,
          })
        ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
      }
    }
  });

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '9'.repeat(40)],
  ])(
    'rejects protocol-era marker deletion plus tag replacement before downloads on the %s path',
    async (_path, candidateShaFor) => {
      const original = disabledV2WorkflowBundle();
      const attested = withAttestation(original);

      for (const variant of [
        { immutableTagMarkers: false as const, tagMarkerMode: 'valid' as const },
        { immutableTagMarkers: true as const, tagMarkerMode: 'missing' as const },
      ]) {
        const requestBytes = vi.fn(async () => expect.unreachable('must reject before downloads'));
        await expect(
          planFromPublishedBundles({
            bundles: [attested],
            candidateSha: candidateShaFor(original),
            releaseTransform: release => ({
              ...release,
              body: '',
              assets: (release.assets as Array<{ name: string }>).filter(
                asset => asset.name !== 'attestation.intoto.jsonl'
              ),
            }),
            requestBytes,
            ...variant,
          })
        ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
        expect(requestBytes).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '9'.repeat(40)],
  ])(
    'rejects equal malformed markers before classification on the %s path',
    async (_path, candidateShaFor) => {
      const bundle = disabledV2WorkflowBundle();
      const invalidMarkers: Array<[string, (marker: Record<string, unknown>) => unknown]> = [
        ['scalar', () => 'release-plan/v1'],
        ['array', () => []],
        ['empty object', () => ({})],
        ['wrong protocol', marker => ({ ...marker, protocol: 'release-plan/v3' })],
        ['wrong schema', marker => ({ ...marker, schema: 'bugdrop.publication-marker/v9' })],
        ['wrong tag', marker => ({ ...marker, tag: 'v9.9.9' })],
        ['wrong target', marker => ({ ...marker, targetSha: '0'.repeat(40) })],
        ['malformed identity', marker => ({ ...marker, planIdentity: 'sha256:bad' })],
        [
          'malformed digest',
          marker => ({ ...marker, contentIdentity: `sha512:${'0'.repeat(64)}` }),
        ],
        ['invalid requiredEvidence', marker => ({ ...marker, requiredEvidence: [] })],
        ['unexpected key', marker => ({ ...marker, legacy: true })],
      ];

      for (const [name, markerTransform] of invalidMarkers) {
        const requestBytes = vi.fn(async () =>
          expect.unreachable(`${name} must reject before downloads`)
        );
        await expect(
          planFromPublishedBundles({
            bundles: [bundle],
            candidateSha: candidateShaFor(bundle),
            markerTransform: markerTransform as (marker: unknown) => unknown,
            requestBytes,
          }),
          name
        ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
        expect(requestBytes, name).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '9'.repeat(40)],
  ])(
    'rejects post-cutoff v1 markers before classification on the %s path',
    async (_path, candidateShaFor) => {
      const bundle = disabledV2WorkflowBundle();
      const requestBytes = vi.fn(async () =>
        expect.unreachable('post-cutoff v1 marker must reject before downloads')
      );

      await expect(
        planFromPublishedBundles({
          bundles: [bundle],
          candidateSha: candidateShaFor(bundle),
          markerTransform: marker => ({
            ...(marker as Record<string, unknown>),
            schema: 'bugdrop.publication-marker/v1',
            protocol: 'release-plan/v1',
          }),
          requestBytes,
        })
      ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
      expect(requestBytes).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '4'.repeat(40)],
  ])(
    'rejects post-attestation-boundary six-asset v2 on the %s path before downloads',
    async (_path, candidateShaFor) => {
      const bundle = disabledV2WorkflowBundle({
        previousTag: 'v1.55.2',
        nextTag: 'v1.55.3',
        targetSha: '3'.repeat(40),
      });
      const requestBytes = vi.fn(async () =>
        expect.unreachable('unattested post-boundary release must reject before downloads')
      );

      await expect(
        planFromPublishedBundles({
          bundles: [bundle],
          candidateSha: candidateShaFor(bundle),
          requestBytes,
        })
      ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
      expect(requestBytes).not.toHaveBeenCalled();
    }
  );

  it('rejects an attested N followed by an unattested N+1 before lineage classification', async () => {
    const attestedN = withAttestation(
      disabledV2WorkflowBundle({
        previousTag: 'v1.55.2',
        nextTag: 'v1.55.3',
        targetSha: '3'.repeat(40),
      })
    );
    const unattestedN1 = disabledV2WorkflowBundle({
      previousTag: 'v1.55.3',
      nextTag: 'v1.55.4',
      targetSha: '4'.repeat(40),
    });
    const requestBytes = vi.fn(async () =>
      expect.unreachable('invalid lineage must reject before downloads')
    );
    const verifyAttestation = vi.fn(async () => attestedN.attestation);

    await expect(
      planFromPublishedBundles({
        bundles: [attestedN, unattestedN1],
        candidateSha: '5'.repeat(40),
        requestBytes,
        verifyAttestation,
      })
    ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
    expect(requestBytes).not.toHaveBeenCalled();
    expect(verifyAttestation).not.toHaveBeenCalled();
  });

  it('rejects post-boundary unattested v2 before retention traversal', async () => {
    const historical = disabledV2WorkflowBundle({
      previousTag: 'v1.55.1',
      nextTag: 'v1.55.2',
      targetSha: '2'.repeat(40),
    });
    const postBoundary = disabledV2WorkflowBundle({
      previousTag: 'v1.55.2',
      nextTag: 'v1.55.3',
      targetSha: '3'.repeat(40),
    });
    const requestBytes = vi.fn(async () =>
      expect.unreachable('invalid retention history must reject before downloads')
    );

    await expect(
      planFromPublishedBundles({
        bundles: [historical, postBoundary],
        candidateSha: '4'.repeat(40),
        retentionBootstrap: true,
        requestBytes,
      })
    ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
    expect(requestBytes).not.toHaveBeenCalled();
  });

  it.each([
    [
      'completed-plan',
      (bundle: ReturnType<typeof disabledV2WorkflowBundle>) => bundle.finalPlan.targetSha,
    ],
    ['N+1', () => '4'.repeat(40)],
  ])(
    'requires the declared seventh asset on the post-boundary %s path',
    async (_path, candidateShaFor) => {
      const attested = withAttestation(
        disabledV2WorkflowBundle({
          previousTag: 'v1.55.2',
          nextTag: 'v1.55.3',
          targetSha: '3'.repeat(40),
        })
      );
      const verifyAttestation = vi.fn(async () => attested.attestation);

      await expect(
        planFromPublishedBundles({
          bundles: [attested],
          candidateSha: candidateShaFor(attested),
          releaseTransform: release => ({
            ...release,
            assets: (release.assets as Array<{ name: string }>).filter(
              asset => asset.name !== 'attestation.intoto.jsonl'
            ),
          }),
          verifyAttestation,
        })
      ).rejects.toBeInstanceOf(GithubAdapterError);
      expect(verifyAttestation).not.toHaveBeenCalled();
    }
  );

  it('accepts valid post-boundary seven-asset completed and N+1 behavior', async () => {
    const attested = withAttestation(
      disabledV2WorkflowBundle({
        previousTag: 'v1.55.2',
        nextTag: 'v1.55.3',
        targetSha: '3'.repeat(40),
      })
    );
    const verifyAttestation = vi.fn(async () => attested.attestation);

    await expect(
      planFromPublishedBundles({
        bundles: [attested],
        candidateSha: attested.finalPlan.targetSha,
        verifyAttestation,
      })
    ).resolves.toMatchObject({ status: 'completed', tag: 'v1.55.3' });
    await expect(
      planFromPublishedBundles({
        bundles: [attested],
        candidateSha: '4'.repeat(40),
        verifyAttestation,
      })
    ).resolves.toMatchObject({ request: { previousTag: 'v1.55.3' } });
    expect(verifyAttestation).toHaveBeenCalledTimes(2);
  });

  it('accepts legitimate immutable historical and attested markers but rejects disagreement', async () => {
    const historical = disabledV2WorkflowBundle();
    const attested = withAttestation(historical);
    const verifyAttestation = vi.fn(async () => attested.attestation);

    await expect(
      planFromPublishedBundles({ bundles: [historical], immutableTagMarkers: true })
    ).resolves.toMatchObject({ request: { previousTag: historical.finalPlan.tag } });
    const latestPreAttestation = disabledV2WorkflowBundle({
      previousTag: 'v1.55.1',
      nextTag: 'v1.55.2',
      targetSha: '2'.repeat(40),
    });
    await expect(
      planFromPublishedBundles({
        bundles: [latestPreAttestation],
        candidateSha: '3'.repeat(40),
      })
    ).resolves.toMatchObject({ request: { previousTag: 'v1.55.2' } });
    await expect(
      planFromPublishedBundles({
        bundles: [historical],
        immutableTagMarkers: false,
        releaseTransform: release => ({ ...release, body: '' }),
      })
    ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
    await expect(
      planFromPublishedBundles({
        bundles: [attested],
        immutableTagMarkers: true,
        verifyAttestation,
      })
    ).resolves.toMatchObject({ request: { previousTag: historical.finalPlan.tag } });
    await expect(
      planFromPublishedBundles({
        bundles: [historical],
        immutableTagMarkers: true,
        releaseTransform: release => ({
          ...release,
          body: releaseBody({ ...buildPublicationMarker(historical.finalPlan), mismatch: true }),
        }),
      })
    ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
  });

  it('authenticates retention mode before charging an exact asset to cumulative history', async () => {
    const bundle = disabledV2WorkflowBundle();
    const exactName = `widget.${bundle.finalPlan.tag}.js`;
    const names = Object.keys(bundle.assets);
    const release = {
      tag: bundle.finalPlan.tag,
      targetSha: bundle.finalPlan.targetSha,
      resolvedTagSha: bundle.finalPlan.targetSha,
      published: true,
      draft: false,
      prerelease: false,
      marker: buildPublicationMarker(bundle.finalPlan),
      repository: REPOSITORY,
      assets: names.map((name, index) => ({
        id: String(index + 1),
        name,
        apiUrl: `https://api.github.test/repos/${REPOSITORY}/releases/assets/${index + 1}`,
        downloadUrl: `https://github.com/${REPOSITORY}/releases/download/${bundle.finalPlan.tag}/${name}`,
        size: bundle.assets[name].length,
      })),
    };
    const requestBytes = vi.fn(async (_url: string, options: { assetId: string }) => {
      return bundle.assets[names[Number(options.assetId) - 1]];
    });

    await expect(
      loadPublishedReleaseAssets({
        transport: { requestBytes },
        release,
        retainedBudget: { used: 512 * 1024 * 1024 - 1, assetName: exactName },
      })
    ).resolves.toMatchObject({ requestPlan: { retention: { mode: 'disabled' } } });
  });

  it('returns an authenticated completed no-op before local Git planning', async () => {
    const bundle = disabledV2WorkflowBundle();
    const marker = buildPublicationMarker(bundle.finalPlan);
    const encodedMarker = Buffer.from(canonicalize(marker)).toString('base64url');
    const tagObjectSha = '9'.repeat(40);
    const releaseAssets = Object.keys(bundle.assets).map((name, index) => ({
      id: index + 1,
      name,
      url: `https://api.github.test/repos/${REPOSITORY}/releases/assets/${index + 1}`,
      size: bundle.assets[name].length,
      browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${bundle.finalPlan.tag}/${name}`,
    }));
    const transport = transportFor({
      [`/repos/${REPOSITORY}/releases?per_page=100&page=1`]: {
        data: [
          {
            id: 8,
            tag_name: bundle.finalPlan.tag,
            draft: false,
            prerelease: false,
            published_at: '2026-08-03T00:00:00Z',
            html_url: 'https://github.test/releases/completed',
            body: `<!-- bugdrop-publication ${encodedMarker} -->`,
            assets: releaseAssets,
          },
        ],
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/git/matching-refs/tags/v?per_page=100&page=1`]: {
        data: [
          {
            ref: `refs/tags/${bundle.finalPlan.tag}`,
            object: { type: 'tag', sha: tagObjectSha },
          },
        ],
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/git/tags/${tagObjectSha}`]: {
        data: {
          object: { type: 'commit', sha: bundle.finalPlan.targetSha },
          message: `BugDrop ${bundle.finalPlan.tag}\n\n${canonicalize(marker)}`,
        },
        hasNext: false,
      },
      [`/repos/${REPOSITORY}/compare/${bundle.finalPlan.targetSha}...${bundle.finalPlan.targetSha}`]:
        {
          data: { status: 'identical' },
          hasNext: false,
        },
    });
    Object.assign(transport, {
      requestBytes: vi.fn(async (_url: string, options: { assetId: string }) => {
        const name = Object.keys(bundle.assets)[Number(options.assetId) - 1];
        return bundle.assets[name];
      }),
    });
    const gitObserver = vi.fn(() => expect.unreachable('completed plans must not inspect Git'));
    await expect(
      createRequestPlanFromGithub({
        transport,
        gitObserver,
        context: { ...workflowContext(false), retentionBootstrap: false },
      })
    ).resolves.toEqual({
      status: 'completed',
      planIdentity: bundle.finalPlan.planIdentity,
      tag: bundle.finalPlan.tag,
      targetSha: bundle.finalPlan.targetSha,
    });
    expect(gitObserver).not.toHaveBeenCalled();

    const recoveryContext = {
      ...workflowContext(false),
      retentionBootstrap: false,
      controllerReachableFromCurrent: true,
      identityMainReachableFromCurrent: true,
      identityMainSha: bundle.requestPlan.source.remoteMainSha,
      resumePlanIdentity: bundle.finalPlan.planIdentity,
    };
    await expect(
      createRequestPlanFromGithub({
        transport,
        gitObserver,
        context: recoveryContext,
      })
    ).resolves.toMatchObject({
      status: 'completed',
      planIdentity: bundle.finalPlan.planIdentity,
    });
    await expect(
      createRequestPlanFromGithub({
        transport,
        gitObserver,
        context: {
          ...recoveryContext,
          resumePlanIdentity: `sha256:${'f'.repeat(64)}`,
        },
      })
    ).rejects.toThrow(/COMPLETED_PLAN_CONFLICT/);
    await expect(
      createRequestPlanFromGithub({
        transport,
        gitObserver,
        context: {
          ...recoveryContext,
          identityMainSha: 'd'.repeat(40),
        },
      })
    ).rejects.toThrow(/COMPLETED_PLAN_CONFLICT/);
    await expect(
      createRequestPlanFromGithub({
        transport,
        gitObserver,
        context: {
          ...recoveryContext,
          dispatch: {
            ...recoveryContext.dispatch,
            controllerSha: 'e'.repeat(40),
          },
        },
      })
    ).rejects.toThrow(/COMPLETED_PLAN_CONFLICT/);
    expect(gitObserver).not.toHaveBeenCalled();
  });

  it('rejects an invalid planning dispatch before GitHub access', async () => {
    const transport = transportFor({});
    await expect(
      createRequestPlanFromGithub({
        transport,
        context: {
          dispatch: {
            repository: REPOSITORY,
            workflowRef: '.github/workflows/deploy.yml@refs/heads/main',
            targetSha: 'short',
            controllerSha: SHA.release,
            bump: 'patch',
            releaseReason: 'standard',
          },
        },
      })
    ).rejects.toThrow(/targetSha/);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('normalizes annotated tags, Releases, and candidate ancestry', async () => {
    const state = await observeGithubState({
      transport: transportFor(observationEntries()),
      repository: REPOSITORY,
      targetSha: SHA.target,
    });
    expect(state.refs).toEqual([
      expect.objectContaining({ tag: 'v1.55.0', sha: SHA.release, kind: 'annotated' }),
    ]);
    expect(state.published).toEqual([
      expect.objectContaining({
        tag: 'v1.55.0',
        marker: null,
        targetSha: SHA.release,
        resolvedTagSha: SHA.release,
        relationToTarget: 'ancestor',
      }),
    ]);
  });

  it('follows explicit pagination and rejects ambiguous pagination metadata', async () => {
    const transport = transportFor({
      '/records?per_page=2&page=1': { data: [1, 2], hasNext: true },
      '/records?per_page=2&page=2': { data: [3], hasNext: false },
    });
    await expect(paginateGithub(transport, '/records', { perPage: 2 })).resolves.toEqual([1, 2, 3]);
    await expect(
      paginateGithub(transportFor({ '/records?per_page=100&page=1': { data: [] } }), '/records')
    ).rejects.toThrow(GithubAdapterError);
  });

  it.each([
    ['mixed-case target', { targetSha: `A${SHA.target.slice(1)}` }],
    ['invalid repository', { repository: '../other' }],
  ])('rejects %s before transport access', async (_name, change) => {
    const transport = transportFor({});
    await expect(
      observeGithubState({
        transport,
        repository: REPOSITORY,
        targetSha: SHA.target,
        ...change,
      })
    ).rejects.toThrow(GithubAdapterError);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('fails closed on divergent history and duplicate identity markers', async () => {
    const divergent = observationEntries();
    divergent[`/repos/${REPOSITORY}/compare/${SHA.release}...${SHA.target}`] = {
      data: { status: 'diverged' },
      hasNext: false,
    };
    await expect(
      observeGithubState({
        transport: transportFor(divergent),
        repository: REPOSITORY,
        targetSha: SHA.target,
      })
    ).rejects.toThrow(/diverge/);

    const duplicate = observationEntries();
    duplicate[`/repos/${REPOSITORY}/releases?per_page=100&page=1`].data[0].body =
      '<!-- bugdrop-publication e30 -->\n<!-- bugdrop-publication e30 -->';
    await expect(
      observeGithubState({
        transport: transportFor(duplicate),
        repository: REPOSITORY,
        targetSha: SHA.target,
      })
    ).rejects.toThrow(/multiple identity markers/);
  });
});

describe('authenticated disabled v2 frontier history', () => {
  const first = () =>
    disabledV2WorkflowBundle({
      previousTag: 'v1.54.0',
      nextTag: 'v1.55.0',
      bump: 'minor',
      targetSha: '1'.repeat(40),
      timestamp: '2026-08-10T00:00:00Z',
    });
  const second = () =>
    disabledV2WorkflowBundle({
      previousTag: 'v1.55.0',
      nextTag: 'v1.55.1',
      targetSha: '2'.repeat(40),
      timestamp: '2026-08-11T00:00:00Z',
    });

  it('authenticates consecutive disabled publications without activating retention', async () => {
    await expect(planFromPublishedBundles({ bundles: [first(), second()] })).resolves.toMatchObject(
      {
        request: { previousTag: 'v1.55.1', nextTag: 'v1.55.2', retentionBootstrap: false },
        retention: {
          mode: 'disabled',
          cutoverVersion: null,
          expectedRetainedVersions: [],
          releases: [],
        },
      }
    );
  });

  it('allows an explicit bootstrap after authenticated disabled history', async () => {
    await expect(
      planFromPublishedBundles({ bundles: [first(), second()], retentionBootstrap: true })
    ).resolves.toMatchObject({
      retention: {
        mode: 'bootstrap',
        cutoverVersion: '1.55.2',
        expectedRetainedVersions: [],
      },
    });
  });

  it('reproduces protected bootstrap history revalidation exactly', async () => {
    const bundles = [first(), second()];
    const planned = await planFromPublishedBundles({ bundles, retentionBootstrap: true });
    const revalidated = await planFromPublishedBundles({
      bundles: [...bundles].reverse(),
      retentionBootstrap: true,
    });
    expect(revalidated).toEqual(planned);
    expect(revalidated.request.retentionBootstrap).toBe(true);
    expect(revalidated.retention).toMatchObject({
      mode: 'bootstrap',
      cutoverVersion: '1.55.2',
    });
  });

  it.each([
    ['disabled', () => second(), [], /RETENTION_HISTORY_INCOMPLETE/],
    [
      'legacy',
      () => null,
      [{ tag: 'v1.55.1', targetSha: '2'.repeat(40) }],
      /PUBLISHED_RELEASE_CONFLICT/,
    ],
  ])(
    'rejects %s history at or above an authenticated active boundary',
    async (_kind, later, legacy, expected) => {
      const active = bootstrapV2WorkflowBundle({
        previousTag: 'v1.54.0',
        nextTag: 'v1.55.0',
        bump: 'minor',
        targetSha: '1'.repeat(40),
        timestamp: '2026-08-10T00:00:00Z',
      });
      const laterBundle = later();
      await expect(
        planFromPublishedBundles({
          bundles: laterBundle ? [active, laterBundle] : [active],
          legacy,
        })
      ).rejects.toThrow(expected);
    }
  );

  it('is invariant to GitHub order and locale collation', async () => {
    const bundles = [first(), second()];
    const baseline = await planFromPublishedBundles({ bundles });
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      other: string
    ) {
      return String(other) < String(this) ? -1 : String(other) > String(this) ? 1 : 0;
    });
    try {
      const permuted = await planFromPublishedBundles({ bundles: [...bundles].reverse() });
      expect(permuted.requestIdentity).toBe(baseline.requestIdentity);
      expect(permuted.retention).toEqual(baseline.retention);
    } finally {
      locale.mockRestore();
    }
  });

  it('rejects missing, duplicate, and inconsistent disabled publication history', async () => {
    const missing = first();
    delete missing.assets['versions.json'];
    await expect(planFromPublishedBundles({ bundles: [missing] })).rejects.toThrow(
      /PUBLISHED_ASSET/
    );

    const duplicate = first();
    await expect(planFromPublishedBundles({ bundles: [duplicate, duplicate] })).rejects.toThrow(
      /AMBIGUOUS_RELEASE/
    );

    const inconsistent = disabledV2WorkflowBundle({
      previousTag: 'v1.54.0',
      nextTag: 'v1.55.0',
      bump: 'minor',
      targetSha: '1'.repeat(40),
      timestamp: '2026-08-10T00:00:00Z',
      manifestChanges: { cutoverVersion: '1.54.0' },
    });
    await expect(planFromPublishedBundles({ bundles: [inconsistent] })).rejects.toThrow(
      /disabled manifest is inconsistent/
    );
  });
});

describe('complete active v2 manifest authority', () => {
  function transformed(
    mutate: (manifest: Record<string, unknown>) => void
  ): ReturnType<typeof disabledV2WorkflowBundle>[] {
    return activeHistoryBundles({
      continuationManifestTransform: value => {
        const changed = structuredClone(value);
        mutate(changed);
        return changed;
      },
    });
  }

  it.each([
    [
      'tag',
      (artifact: Record<string, unknown>) => {
        artifact.tag = 'v9.9.9';
      },
    ],
    [
      'target',
      (artifact: Record<string, unknown>) => {
        artifact.targetSha = '8'.repeat(40);
      },
    ],
  ])(
    'rejects an identity-consistent bootstrap manifest with false current %s',
    async (_field, mutate) => {
      const bootstrap = bootstrapV2WorkflowBundle({
        previousTag: 'v1.54.0',
        nextTag: 'v1.55.0',
        bump: 'minor',
        targetSha: '1'.repeat(40),
        timestamp: '2026-08-10T00:00:00Z',
        manifestTransform: (value: Record<string, unknown>) => {
          const changed = structuredClone(value);
          const artifacts = changed.artifacts as Record<string, Record<string, unknown>>;
          mutate(artifacts['v1.55.0']);
          return changed;
        },
      });
      await expect(planFromPublishedBundles({ bundles: [bootstrap] })).rejects.toThrow(
        /active manifest is inconsistent/
      );
    }
  );

  it('authenticates a compact bootstrap and continuation projection', async () => {
    await expect(
      planFromPublishedBundles({ bundles: activeHistoryBundles() })
    ).resolves.toMatchObject({
      request: { previousTag: 'v1.56.0', nextTag: 'v1.56.1' },
      retention: {
        mode: 'continue',
        cutoverVersion: '1.55.0',
        expectedRetainedVersions: ['1.55.0', '1.56.0'],
      },
    });
  });

  it('authenticates pre-transfer retention through the transferred repository', async () => {
    const bundles = activeHistoryBundles();
    const verifyAttestation = vi.fn(
      async () => (bundles[1] as (typeof bundles)[1] & { attestation: unknown }).attestation
    );
    const plan = await planFromPublishedBundles({
      bundles,
      selectedRepository: TRANSFERRED_REPOSITORY,
      verifyAttestation,
    });

    expect(plan.retention).toMatchObject({
      mode: 'continue',
      expectedRetainedVersions: ['1.55.0', '1.56.0'],
    });
    expect(plan.retention.releases[0].asset).toMatchObject({
      apiPath: `/repos/${REPOSITORY}/releases/assets/101`,
      downloadUrl: `https://github.com/${REPOSITORY}/releases/download/v1.55.0/widget.v1.55.0.js`,
    });
    expect(verifyAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ repository: REPOSITORY }),
      })
    );
  });

  it('does not accept a new Release published under the old repository', async () => {
    const bundle = withAttestation(
      disabledV2WorkflowBundle({
        previousTag: 'v1.56.9',
        nextTag: 'v1.57.0',
        bump: 'minor',
        targetSha: '3'.repeat(40),
      })
    );
    await expect(
      planFromPublishedBundles({
        bundles: [bundle],
        selectedRepository: TRANSFERRED_REPOSITORY,
      })
    ).rejects.toMatchObject({ code: 'PUBLISHED_RELEASE_CONFLICT' });
  });

  it.each([
    [
      'current tag',
      (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        artifacts['v1.56.0'].tag = 'v9.9.9';
      },
    ],
    [
      'current target',
      (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        artifacts['v1.56.0'].targetSha = '8'.repeat(40);
      },
    ],
    [
      'current download URL',
      (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        artifacts['v1.56.0'].downloadUrl =
          'https://github.com/mean-weasel/bugdrop/releases/download/v9.9.9/widget.v1.56.0.js';
      },
    ],
    [
      'repository root',
      (manifest: Record<string, unknown>) => (manifest.repository = 'other/repo'),
    ],
    [
      'generated timestamp',
      (manifest: Record<string, unknown>) => (manifest.generatedAt = '2026-08-12T00:00:00Z'),
    ],
    ['latest root', (manifest: Record<string, unknown>) => (manifest.latest = 'widget.v1.js')],
    [
      'versions map',
      (manifest: Record<string, unknown>) => (manifest.versions = { v1: 'wrong.js' }),
    ],
    ['extra root', (manifest: Record<string, unknown>) => (manifest.unapproved = true)],
    [
      'missing root',
      (manifest: Record<string, unknown>) => {
        delete manifest.latest;
      },
    ],
    [
      'extra current field',
      (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        artifacts['v1.56.0'].unapproved = true;
      },
    ],
    [
      'missing retained field',
      (manifest: Record<string, unknown>) => {
        const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
        delete artifacts['v1.55.0'].tag;
      },
    ],
  ])('rejects an identity-consistent active manifest with wrong %s', async (_field, mutate) => {
    await expect(planFromPublishedBundles({ bundles: transformed(mutate) })).rejects.toThrow(
      /active manifest is inconsistent/
    );
  });

  it('rejects identity-consistent disagreement between attached and static-tree manifest hashes', async () => {
    await expect(
      planFromPublishedBundles({
        bundles: activeHistoryBundles({ continuationStaticManifestHash: '7'.repeat(64) }),
      })
    ).rejects.toThrow(/active manifest is inconsistent/);
  });

  it('is invariant to Release, asset, and download timing permutations', async () => {
    const bundles = activeHistoryBundles();
    const baseline = await planFromPublishedBundles({ bundles });
    const permuted = await planFromPublishedBundles({
      bundles: [...bundles].reverse(),
      reverseAssets: true,
      downloadDelay: 1,
    });
    expect(permuted.requestIdentity).toBe(baseline.requestIdentity);
    expect(permuted.retention).toEqual(baseline.retention);
  });
});

describe('independent cumulative retention authority', () => {
  type RetentionRecord = Record<string, unknown> & { asset: Record<string, unknown> };

  function selfConsistentLie(
    mutate: (record: RetentionRecord, retention: Record<string, unknown>) => void
  ) {
    return activeHistoryBundles({
      continuationRetentionTransform: value => {
        const changed = structuredClone(value);
        const records = changed.releases as RetentionRecord[];
        mutate(records[0], changed);
        return changed;
      },
    });
  }

  it.each([
    ['targetSha', (record: RetentionRecord) => (record.targetSha = '8'.repeat(40))],
    [
      'downloadUrl',
      (record: RetentionRecord) =>
        (record.asset.downloadUrl =
          'https://github.com/mean-weasel/bugdrop/releases/download/v9.9.9/widget.v1.55.0.js'),
    ],
    ['releaseId', (record: RetentionRecord) => (record.releaseId = '999')],
    [
      'assetId',
      (record: RetentionRecord) => {
        record.asset.assetId = '999';
        record.asset.apiPath = `/repos/${REPOSITORY}/releases/assets/999`;
      },
    ],
    [
      'apiPath',
      (record: RetentionRecord) =>
        (record.asset.apiPath = '/repos/other/repository/releases/assets/101'),
    ],
    ['publishedAt', (record: RetentionRecord) => (record.publishedAt = '2026-08-09T00:00:00Z')],
    [
      'sourcePlanIdentity',
      (record: RetentionRecord) => (record.sourcePlanIdentity = `sha256:${'8'.repeat(64)}`),
    ],
    [
      'sourceContentIdentity',
      (record: RetentionRecord) => (record.sourceContentIdentity = `sha256:${'8'.repeat(64)}`),
    ],
    ['digest', (record: RetentionRecord) => (record.asset.sha256 = '8'.repeat(64))],
    [
      'version/tag/filename',
      (record: RetentionRecord, retention: Record<string, unknown>) => {
        record.version = '1.55.1';
        record.tag = 'v1.55.1';
        record.asset.name = 'widget.v1.55.1.js';
        retention.expectedRetainedVersions = ['1.55.1'];
      },
    ],
  ])('rejects a self-consistent later declaration with false prior %s', async (_field, mutate) => {
    await expect(planFromPublishedBundles({ bundles: selfConsistentLie(mutate) })).rejects.toThrow(
      /cumulative retention differs from authenticated preceding Releases/
    );
  });

  it.each([
    [
      'tag',
      (record: RetentionRecord) => {
        record.tag = 'v9.9.9';
      },
    ],
    [
      'filename',
      (record: RetentionRecord) => {
        record.asset.name = 'widget.v9.9.9.js';
      },
    ],
    [
      'extra field',
      (record: RetentionRecord) => {
        record.unapproved = true;
      },
    ],
    [
      'missing field',
      (record: RetentionRecord) => {
        delete record.sourcePlanIdentity;
      },
    ],
    [
      'extra record/order',
      (_record: RetentionRecord, records: RetentionRecord[]) => {
        records.unshift(structuredClone(records[0]));
      },
    ],
  ])('rejects identity-bound malformed cumulative %s before authority', async (_field, mutate) => {
    const bundles = activeHistoryBundles();
    const continuation = bundles[1];
    const records = continuation.requestPlan.retention.releases as RetentionRecord[];
    mutate(records[0], records);
    rebindPublishedBundle(continuation);
    await expect(planFromPublishedBundles({ bundles })).rejects.toThrow(
      /cumulative retention differs from authenticated preceding Releases/
    );
  });

  it('preserves the exact independently authenticated prefix on correct history', async () => {
    const plan = await planFromPublishedBundles({ bundles: activeHistoryBundles() });
    expect(plan.retention.releases).toHaveLength(2);
    expect(plan.retention.releases[0]).toMatchObject({
      version: '1.55.0',
      releaseId: '101',
      targetSha: '1'.repeat(40),
      asset: { assetId: '101', name: 'widget.v1.55.0.js' },
    });
    expect(plan.retention.releases[1]).toMatchObject({
      version: '1.56.0',
      releaseId: '102',
      targetSha: '2'.repeat(40),
      asset: { assetId: '201', name: 'widget.v1.56.0.js' },
    });
  });
});

describe('authenticated transport', () => {
  it('retries a transient GitHub API read without accepting an incomplete response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), { status: 200 }));
    const transport = createGithubTransport({ token: 'repository-token', fetchImpl });

    await expect(transport.request('/repos/owner/repo/releases/42')).resolves.toMatchObject({
      data: { id: 42 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      authorization: 'Bearer repository-token',
    });
  });

  it('retries a transient asset storage failure through a fresh trusted redirect', async () => {
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
      calls.push([url, options]);
      if (calls.length === 1 || calls.length === 3) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/release-asset' },
        });
      }
      return new Response(calls.length === 2 ? 'temporary failure' : 'asset bytes', {
        status: calls.length === 2 ? 500 : 200,
      });
    });
    const transport = createGithubTransport({ token: 'repository-token', fetchImpl });

    await expect(
      transport.requestBytes('/repos/owner/repo/releases/assets/1', {
        repository: 'owner/repo',
        assetId: '1',
        expectedSize: 11,
      })
    ).resolves.toEqual(Buffer.from('asset bytes'));
    expect(calls).toHaveLength(4);
    for (const index of [1, 3]) {
      expect(calls[index][1]?.headers).not.toHaveProperty('authorization');
    }
  });

  it('does not retry a missing GitHub asset', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }));
    const transport = createGithubTransport({ token: 'repository-token', fetchImpl });

    await expect(transport.requestBytes('/repos/owner/repo/releases/assets/1')).rejects.toThrow(
      /returned 404/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails after a bounded number of transient asset failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('temporary failure', { status: 503 }));
    const transport = createGithubTransport({ token: 'repository-token', fetchImpl });

    await expect(transport.requestBytes('/repos/owner/repo/releases/assets/1')).rejects.toThrow(
      /returned 503/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps tokens out of errors while requiring complete JSON responses', async () => {
    const token = 'top-secret-token';
    const fetchImpl = vi.fn(
      async () => new Response('failure', { status: 502, headers: { link: '' } })
    );
    const transport = createGithubTransport({ token, fetchImpl });
    let message = '';
    try {
      await transport.request('/repos/owner/repo/releases');
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('502');
    expect(message).not.toContain(token);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not forward the GitHub token to redirected asset storage', async () => {
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
      calls.push([url, options]);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/release-asset' },
        });
      }
      return new Response('asset bytes', { status: 200 });
    });
    const transport = createGithubTransport({ token: 'repository-token', fetchImpl });
    await expect(transport.requestBytes('/repos/owner/repo/releases/assets/1')).resolves.toEqual(
      Buffer.from('asset bytes')
    );
    expect(calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer repository-token' });
    expect(calls[1][1]?.headers).not.toHaveProperty('authorization');
  });

  it('rejects repository substitution and truncated streamed assets', async () => {
    const fetchImpl = vi.fn(async () => new Response('short', { status: 200 }));
    const transport = createGithubTransport({
      token: 'repository-token',
      fetchImpl,
    });
    await expect(
      transport.requestBytes('/repos/owner/other/releases/assets/1', {
        repository: 'owner/repo',
        assetId: '1',
        expectedSize: 5,
      })
    ).rejects.toThrow(/outside the selected repository/);
    await expect(
      transport.requestBytes('/repos/owner/repo/releases/assets/1', {
        repository: 'owner/repo',
        assetId: '1',
        expectedSize: 6,
      })
    ).rejects.toThrow(/truncated|Content-Length/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the abort timeout active until the redirected response stream completes', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => {
        if (fetchImpl.mock.calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://objects.githubusercontent.com/slow-asset' },
          });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              options?.signal?.addEventListener('abort', () =>
                controller.error(new Error('aborted'))
              );
            },
          }),
          { status: 200 }
        );
      });
      const transport = createGithubTransport({ token: 'repository-token', fetchImpl });
      const pending = transport.requestBytes('/repos/owner/repo/releases/assets/1', {
        repository: 'owner/repo',
        assetId: '1',
        expectedSize: 1,
      });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
      expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty('authorization');
    } finally {
      vi.useRealTimers();
    }
  });
});
