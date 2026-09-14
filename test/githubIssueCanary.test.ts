import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_TITLE_PREFIX,
  canaryTitle,
  closeMatchingIssues,
  listMatchingIssues,
  observeCanaryDelivery,
  runCli,
  verifyCanaryIssue,
} from '../scripts/github-issue-canary.mjs';

const REPO = 'mean-weasel/bugdrop-widget-test';
const MARKER = `bugdrop-ci-canary:123:1:${'a'.repeat(40)}`;
const SHA = 'a'.repeat(40);
const TOKEN = 'synthetic-redaction-sentinel-not-a-credential';
const RENDERED_SUBMISSION_ID = 'submission-95a970ec-e4fa-41da-9a29-f4b62fb941ca';
const noWait = vi.fn(async () => {});

type Issue = {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  user: { login: string };
  pull_request?: { url: string };
};

function issue(overrides: Partial<Issue> = {}): Issue {
  const number = overrides.number ?? 42;
  return {
    number,
    html_url: `https://github.com/${REPO}/issues/${number}`,
    title: canaryTitle(MARKER),
    body: [
      '## Canary marker',
      '',
      MARKER,
      '',
      '<details>',
      '<summary>System Info</summary>',
      '</details>',
      '',
      `<!-- bugdrop-submission: ci:${MARKER} -->`,
      '',
      '---',
      '*Submitted via [BugDrop](https://github.com/bugdrophq/bugdrop)*',
    ].join('\n'),
    state: 'open',
    labels: [{ name: 'bug' }, { name: 'bugdrop' }],
    user: { login: 'neonwatty-bugdrop[bot]' },
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

function terminatedResponse(status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    }),
    { status }
  );
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    marker: MARKER,
    kind: 'structured',
    submissionId: `ci:${MARKER}`,
    issueNumber: 42,
    issueUrl: `https://github.com/${REPO}/issues/42`,
    workerSha: SHA,
    ...overrides,
  };
}

function renderedResult(overrides: Record<string, unknown> = {}) {
  return result({
    presentation: 'modal',
    submissionId: RENDERED_SUBMISSION_ID,
    ...overrides,
  });
}

function issueFetch(
  matches: Issue[],
  direct: Issue = matches[0]
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async input =>
    String(input).includes('/issues?') ? jsonResponse(matches) : jsonResponse(direct)
  );
}

describe('GitHub Issue canary discovery and verification', () => {
  it('retries GET network and selected 5xx failures with 1s/2s delays', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`network ${TOKEN}`))
      .mockResolvedValueOnce(new Response(`upstream ${TOKEN}`, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse([issue()]));

    await expect(
      listMatchingIssues({ fetchImpl, repo: REPO, token: TOKEN, marker: MARKER, retrySleepImpl })
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(retrySleepImpl.mock.calls).toEqual([[1_000], [2_000]]);
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      String(fetchImpl.mock.calls[0][0]),
      String(fetchImpl.mock.calls[0][0]),
      String(fetchImpl.mock.calls[0][0]),
    ]);
  });

  it('retries a terminated GET response body on the same URL', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(terminatedResponse())
      .mockResolvedValueOnce(jsonResponse([issue()]));

    await expect(
      listMatchingIssues({ fetchImpl, repo: REPO, token: TOKEN, marker: MARKER, retrySleepImpl })
    ).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(String(fetchImpl.mock.calls[0][0]));
    expect(retrySleepImpl.mock.calls).toEqual([[1_000]]);
  });

  it('classifies a terminated 401 response from status without retrying its body', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(terminatedResponse(401));

    await expect(
      listMatchingIssues({ fetchImpl, repo: REPO, token: TOKEN, marker: MARKER, retrySleepImpl })
    ).rejects.toThrow('github_auth');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['github_rate_limited', new Response(`quota ${TOKEN}`, { status: 429 })],
    ['github_auth', new Response(`auth ${TOKEN}`, { status: 401 })],
    ['github_request_failed', new Response(`missing ${TOKEN}`, { status: 404 })],
    ['github_response_invalid', new Response(`not-json ${TOKEN}`, { status: 200 })],
  ])('does not retry deterministic GET failure %s', async (category, failedResponse) => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(failedResponse);
    await expect(
      listMatchingIssues({ fetchImpl, repo: REPO, token: TOKEN, marker: MARKER, retrySleepImpl })
    ).rejects.toThrow(category);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it('retries the same page URL and appends a page only after valid success', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const first = issue({ number: 41 });
    const second = issue({ number: 42 });
    const pageTwo = `https://api.github.com/repos/mean-weasel/bugdrop-widget-test/issues?state=all&per_page=100&page=2`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([first], { headers: { Link: `<${pageTwo}>; rel="next"` } })
      )
      .mockResolvedValueOnce(new Response('temporary', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse([second]));

    const matches = await listMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      retrySleepImpl,
    });
    expect(matches.map(candidate => candidate.number)).toEqual([41, 42]);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(pageTwo);
    expect(String(fetchImpl.mock.calls[2][0])).toBe(pageTwo);
    expect(retrySleepImpl.mock.calls).toEqual([[1_000]]);
  });

  it('paginates state=all, filters PRs, and discovers a body-only marker', async () => {
    const matching = issue({ number: 42, title: 'unexpected title' });
    const pullRequest = issue({
      number: 43,
      pull_request: { url: 'https://api.github.com/repos/example/pulls/43' },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([pullRequest], {
          headers: {
            Link: `<https://api.github.com/repos/mean-weasel/bugdrop-widget-test/issues?state=all&per_page=100&page=2>; rel="next"`,
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([matching]));

    const matches = await listMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
    });

    expect(matches.map(candidate => candidate.number)).toEqual([42]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('state=all');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('per_page=100');
  });

  it('verifies the complete Issue and browser response contract', async () => {
    const fetchImpl = issueFetch([issue()]);

    const verified = await verifyCanaryIssue({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      expectedSha: SHA,
      result: result(),
      sleepImpl: noWait,
    });

    expect(verified.number).toBe(42);
    expect(verified.html_url).toBe(`https://github.com/${REPO}/issues/42`);
  });

  it('verifies a rendered modal result with its runtime submission identity', async () => {
    const renderedIssue = issue({
      body: issue().body.replace(`ci:${MARKER}`, RENDERED_SUBMISSION_ID),
    });
    const fetchImpl = issueFetch([renderedIssue]);

    const verified = await verifyCanaryIssue({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      expectedSha: SHA,
      result: renderedResult(),
      sleepImpl: noWait,
    });

    expect(verified.number).toBe(42);
  });

  it('does not accept the legacy production attribution for preview canaries', async () => {
    const candidate = issue({
      body: issue().body.replace('github.com/bugdrophq/bugdrop', 'github.com/mean-weasel/bugdrop'),
    });

    await expect(
      verifyCanaryIssue({
        fetchImpl: issueFetch([candidate], candidate),
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        sleepImpl: noWait,
      })
    ).rejects.toThrow('Issue body lacks BugDrop attribution');
  });

  it('verifies self-hosted production author and labels from the runtime profile', async () => {
    const repo = 'acme/bugdrop-heartbeat-test';
    const marker = `bugdrop-production-heartbeat:123:1:${SHA}`;
    const submissionId = 'submission-95a970ec-e4fa-41da-9a29-f4b62fb941ca';
    const candidate = issue({
      html_url: `https://github.com/${repo}/issues/42`,
      title: `[BugDrop production heartbeat] ${marker}`,
      body: issue().body.replaceAll(MARKER, marker).replace(`ci:${marker}`, submissionId),
      labels: [{ name: 'synthetic' }],
      user: { login: 'acme-bugdrop[bot]' },
    });
    const profileEnvironment = {
      BUGDROP_CANARY_REPO: repo,
      PLAYWRIGHT_BASE_URL: 'https://heartbeat.example.com',
      EXPECTED_WIDGET_ORIGIN: 'https://bugdrop.example.com',
      BUGDROP_CANARY_EXPECTED_AUTHOR: 'ACME-BUGDROP[bot]',
      BUGDROP_CANARY_EXPECTED_LABELS_JSON: '["synthetic"]',
    };

    await expect(
      verifyCanaryIssue({
        fetchImpl: issueFetch([candidate], candidate),
        repo,
        token: TOKEN,
        marker,
        expectedSha: SHA,
        result: {
          marker,
          kind: 'structured',
          presentation: 'modal',
          submissionId,
          issueNumber: 42,
          issueUrl: `https://github.com/${repo}/issues/42`,
          workerSha: SHA,
        },
        profile: 'production',
        profileEnvironment,
        sleepImpl: noWait,
      })
    ).resolves.toMatchObject({ number: 42 });
  });

  it('accepts the deployed production attribution during the repository transition', async () => {
    const repo = 'acme/bugdrop-heartbeat-test';
    const marker = `bugdrop-production-heartbeat:123:1:${SHA}`;
    const submissionId = 'submission-95a970ec-e4fa-41da-9a29-f4b62fb941ca';
    const candidate = issue({
      html_url: `https://github.com/${repo}/issues/42`,
      title: `[BugDrop production heartbeat] ${marker}`,
      body: issue()
        .body.replaceAll(MARKER, marker)
        .replace(`ci:${marker}`, submissionId)
        .replace('github.com/bugdrophq/bugdrop', 'github.com/mean-weasel/bugdrop'),
      labels: [{ name: 'synthetic' }],
      user: { login: 'acme-bugdrop[bot]' },
    });
    const profileEnvironment = {
      BUGDROP_CANARY_REPO: repo,
      PLAYWRIGHT_BASE_URL: 'https://heartbeat.example.com',
      EXPECTED_WIDGET_ORIGIN: 'https://bugdrop.example.com',
      BUGDROP_CANARY_EXPECTED_AUTHOR: 'acme-bugdrop[bot]',
      BUGDROP_CANARY_EXPECTED_LABELS_JSON: '["synthetic"]',
    };

    await expect(
      verifyCanaryIssue({
        fetchImpl: issueFetch([candidate], candidate),
        repo,
        token: TOKEN,
        marker,
        expectedSha: SHA,
        result: {
          marker,
          kind: 'structured',
          presentation: 'modal',
          submissionId,
          issueNumber: 42,
          issueUrl: `https://github.com/${repo}/issues/42`,
          workerSha: SHA,
        },
        profile: 'production',
        profileEnvironment,
        sleepImpl: noWait,
      })
    ).resolves.toMatchObject({ number: 42 });
  });

  it('accepts GitHub canonical repository casing for a case-aliased configuration', async () => {
    const configuredRepo = 'ACME/BugDrop-Heartbeat-Test';
    const canonicalRepo = 'acme/bugdrop-heartbeat-test';
    const marker = `bugdrop-production-heartbeat:123:1:${SHA}`;
    const submissionId = 'submission-95a970ec-e4fa-41da-9a29-f4b62fb941ca';
    const candidate = issue({
      html_url: `https://github.com/${canonicalRepo}/issues/42`,
      title: `[BugDrop production heartbeat] ${marker}`,
      body: issue().body.replaceAll(MARKER, marker).replace(`ci:${marker}`, submissionId),
      user: { login: 'acme-bugdrop[bot]' },
    });
    const profileEnvironment = {
      BUGDROP_CANARY_REPO: configuredRepo,
      PLAYWRIGHT_BASE_URL: 'https://heartbeat.example.com',
      EXPECTED_WIDGET_ORIGIN: 'https://bugdrop.example.com',
      BUGDROP_CANARY_EXPECTED_AUTHOR: 'acme-bugdrop[bot]',
      BUGDROP_CANARY_EXPECTED_LABELS_JSON: '["bug","bugdrop"]',
    };

    await expect(
      verifyCanaryIssue({
        fetchImpl: issueFetch([candidate], candidate),
        repo: configuredRepo,
        token: TOKEN,
        marker,
        expectedSha: SHA,
        result: {
          marker,
          kind: 'structured',
          presentation: 'modal',
          submissionId,
          issueNumber: 42,
          issueUrl: candidate.html_url,
          workerSha: SHA,
        },
        profile: 'production',
        profileEnvironment,
        sleepImpl: noWait,
      })
    ).resolves.toMatchObject({ number: 42 });
  });

  it.each([
    ['missing rendered identity', renderedResult({ submissionId: undefined })],
    ['non-rendered identity', renderedResult({ submissionId: `ci:${MARKER}` })],
    ['malformed rendered identity', renderedResult({ submissionId: 'submission-not-random' })],
  ])('rejects a rendered modal result with %s', async (_name, browserResult) => {
    const renderedIssue = issue({
      body: issue().body.replace(`ci:${MARKER}`, RENDERED_SUBMISSION_ID),
    });
    const fetchImpl = issueFetch([renderedIssue]);

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: browserResult,
        sleepImpl: noWait,
      })
    ).rejects.toThrow('rendered submission identity');
  });

  it.each([
    ['wrong title', issue({ title: `${CANARY_TITLE_PREFIX} wrong` })],
    ['missing body marker', issue({ body: '## Description\nmissing marker' })],
    [
      'legacy body shape',
      issue({ body: issue().body.replace('## Canary marker', '## Description') }),
    ],
    [
      'wrong structured submission marker',
      issue({
        body: issue().body.replace(`<!-- bugdrop-submission: ci:${MARKER} -->`, '<!-- wrong -->'),
      }),
    ],
    [
      'wrong structured section value with marker retained in submission comment',
      issue({
        body: issue().body.replace(`## Canary marker\n\n${MARKER}`, '## Canary marker\n\nwrong'),
      }),
    ],
    ['unexpected labels', issue({ labels: [{ name: 'bug' }] })],
    ['wrong author', issue({ user: { login: 'someone-else' } })],
    ['closed before verification', issue({ state: 'closed' })],
    ['screenshot section', issue({ body: `${issue().body}\n## Screenshot` })],
  ])('rejects %s', async (_name, candidate) => {
    const fetchImpl = issueFetch([candidate], candidate);

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        sleepImpl: noWait,
      })
    ).rejects.toThrow();
  });

  it('rejects duplicate marker matches while preserving their numbers for cleanup diagnostics', async () => {
    const candidates = [issue(), issue({ number: 43 })];
    const fetchImpl = issueFetch(candidates);

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        sleepImpl: noWait,
      })
    ).rejects.toThrow('exactly one');
  });

  it.each([
    ['missing result', undefined],
    ['wrong marker', result({ marker: 'wrong-marker' })],
    ['wrong kind', result({ kind: 'legacy' })],
    ['wrong submission ID', result({ submissionId: 'wrong' })],
    ['wrong number', result({ issueNumber: 99 })],
    ['wrong URL', result({ issueUrl: `https://github.com/${REPO}/issues/99` })],
    ['wrong Worker SHA', result({ workerSha: 'b'.repeat(40) })],
  ])('rejects a %s independently of cleanup discovery', async (_name, browserResult) => {
    const fetchImpl = issueFetch([issue()]);

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: browserResult,
        sleepImpl: noWait,
      })
    ).rejects.toThrow();
  });

  it('uses exact browser Issue readback while bounded list discovery stabilizes', async () => {
    const candidate = issue();
    const listResponses = [[], [candidate], [candidate]];
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (!String(input).includes('/issues?')) return jsonResponse(candidate);
      return jsonResponse(listResponses.shift() ?? [candidate]);
    });

    const verified = await verifyCanaryIssue({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      expectedSha: SHA,
      result: result(),
      consistencyAttempts: 4,
      sleepImpl,
    });

    expect(verified.number).toBe(42);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/issues\/42$/);
  });

  it('fails immediately when a duplicate appears during singleton stabilization', async () => {
    const candidate = issue();
    const duplicate = issue({ number: 43 });
    const listResponses = [[candidate], [candidate, duplicate]];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (!String(input).includes('/issues?')) return jsonResponse(candidate);
      return jsonResponse(listResponses.shift() ?? [candidate, duplicate]);
    });

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        consistencyAttempts: 4,
        sleepImpl: noWait,
      })
    ).rejects.toThrow('found 2');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a stable marker singleton that differs from the browser-reported Issue', async () => {
    const browserIssue = issue();
    const otherMatch = issue({ number: 43 });
    const fetchImpl = issueFetch([otherMatch], browserIssue);

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        sleepImpl: noWait,
      })
    ).rejects.toThrow('not browser Issue #42');
  });

  it('rejects a marker bound to a different Worker SHA before network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: `bugdrop-ci-canary:123:1:${'b'.repeat(40)}`,
        expectedSha: SHA,
        result: result(),
      })
    ).rejects.toThrow('expected Worker SHA');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unbounded consistency configuration before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      verifyCanaryIssue({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        expectedSha: SHA,
        result: result(),
        consistencyAttempts: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow('consistencyAttempts');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sanitized authoritative delivery evidence', () => {
  const observe = (fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) =>
    observeCanaryDelivery({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      expectedSha: SHA,
      result: result(),
      attempted: true,
      feedbackPostObserved: true,
      consistencyAttempts: 2,
      consistencyDelayMs: 0,
      sleepImpl: noWait,
      observedAt: new Date('2026-08-12T12:34:56.789Z'),
      ...overrides,
    });

  it('reports verified from stable singleton and exact contract reads without identifiers', async () => {
    await expect(observe(issueFetch([issue()]))).resolves.toEqual({
      schemaVersion: 1,
      outcome: 'verified',
      reasonCode: 'issue_verified',
      observedAt: '2026-08-12T12:34:56.789Z',
    });
  });

  it('reports only authoritative absent, duplicate, and contract-invalid categories', async () => {
    await expect(observe(issueFetch([]))).resolves.toMatchObject({
      outcome: 'delivery_failed',
      reasonCode: 'issue_absent',
    });
    await expect(observe(issueFetch([issue(), issue({ number: 43 })]))).resolves.toMatchObject({
      outcome: 'delivery_failed',
      reasonCode: 'issue_duplicate',
    });
    await expect(
      observe(issueFetch([issue({ labels: [{ name: 'bug' }] })]))
    ).resolves.toMatchObject({
      outcome: 'delivery_failed',
      reasonCode: 'issue_contract_invalid',
    });
  });

  it('waits through the complete empty-read window before declaring Issue absence', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return jsonResponse([]);
    }) as typeof fetch;

    await expect(
      observe(fetchImpl, { consistencyAttempts: 6, sleepImpl: async () => {} })
    ).resolves.toMatchObject({
      outcome: 'delivery_failed',
      reasonCode: 'issue_absent',
    });
    expect(requests).toBe(6);
  });

  it('does not declare absence when an Issue appears after repeated empty reads', async () => {
    const candidate = issue();
    const listResponses = [[], [], [candidate], [candidate], [candidate], [candidate]];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (!String(input).includes('/issues?')) return jsonResponse(candidate);
      return jsonResponse(listResponses.shift() ?? [candidate]);
    });

    await expect(
      observe(fetchImpl, { consistencyAttempts: 6, sleepImpl: async () => {} })
    ).resolves.toMatchObject({
      outcome: 'verified',
      reasonCode: 'issue_verified',
    });
    expect(listResponses).toEqual([]);
  });

  it('keeps nonempty-then-empty evidence inconclusive through the complete window', async () => {
    const listResponses = [[issue({ number: 43 })], [], [], [], [], []];
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(listResponses.shift() ?? []));

    await expect(
      observe(fetchImpl, { consistencyAttempts: 6, sleepImpl: async () => {} })
    ).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'classification_failed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(listResponses).toEqual([]);
  });

  it('keeps fluctuating nonempty evidence inconclusive through the complete window', async () => {
    const candidates = [issue(), issue({ number: 43 })];
    let index = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const candidate = candidates[index % candidates.length];
      index += 1;
      return jsonResponse([candidate]);
    });

    await expect(
      observe(fetchImpl, { consistencyAttempts: 6, sleepImpl: async () => {} })
    ).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'classification_failed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('keeps missing attempts/results and ambiguous GitHub failures inconclusive', async () => {
    await expect(observe(issueFetch([]), { attempted: false })).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(observe(issueFetch([issue()]), { result: undefined })).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(
      observe(issueFetch([]), { result: undefined, feedbackPostObserved: false })
    ).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(
      observe(issueFetch([]), { result: undefined, feedbackPostObserved: true })
    ).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(
      observe(issueFetch([]), {
        result: result({ workerSha: 'b'.repeat(40) }),
        feedbackPostObserved: true,
      })
    ).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(observe(issueFetch([]), { feedbackPostObserved: false })).resolves.toMatchObject({
      outcome: 'inconclusive',
      reasonCode: 'browser_inconclusive',
    });
    await expect(
      observe(vi.fn<typeof fetch>().mockRejectedValue(new Error(`network ${TOKEN}`)), {
        retrySleepImpl: noWait,
      })
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'github_network' });
    await expect(
      observe(
        vi
          .fn<typeof fetch>()
          .mockImplementation(async () => new Response(`upstream ${TOKEN}`, { status: 503 })),
        { retrySleepImpl: noWait }
      )
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'github_5xx' });
    await expect(
      observe(vi.fn<typeof fetch>().mockResolvedValue(new Response('quota', { status: 429 })))
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'github_rate_limited' });
    await expect(
      observe(vi.fn<typeof fetch>().mockResolvedValue(new Response('auth', { status: 401 })))
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'github_auth_failed' });
    await expect(
      observe(vi.fn<typeof fetch>().mockResolvedValue(new Response('bad json', { status: 200 })))
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'classification_failed' });
    await expect(
      observe(vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 })))
    ).resolves.toMatchObject({ outcome: 'inconclusive', reasonCode: 'classification_failed' });
  });
});

describe('GitHub Issue canary cleanup', () => {
  it('closes every duplicate marker match and proves none remain open', async () => {
    const issues = [issue(), issue({ number: 43 })];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/issues?')) return jsonResponse(issues);
      const number = Number(url.split('/').pop());
      const candidate = issues.find(item => item.number === number)!;
      if (init?.method === 'PATCH') {
        candidate.state = 'closed';
        return jsonResponse(candidate);
      }
      return jsonResponse(candidate);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      sleepImpl: noWait,
    });

    expect(cleanup.matchedNumbers).toEqual([42, 43]);
    expect(cleanup.closedNumbers).toEqual([42, 43]);
    expect(issues.every(candidate => candidate.state === 'closed')).toBe(true);
  });

  it('continues closing later matches after one close fails, then reports the remaining leak', async () => {
    const issues = [issue(), issue({ number: 43 })];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/issues?')) return jsonResponse(issues);
      const number = Number(url.split('/').pop());
      const candidate = issues.find(item => item.number === number)!;
      if (init?.method === 'PATCH' && number === 42) {
        return new Response('close failed', { status: 500 });
      }
      if (init?.method === 'PATCH') candidate.state = 'closed';
      return jsonResponse(candidate);
    });

    await expect(
      closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        consistencyAttempts: 2,
        sleepImpl: noWait,
      })
    ).rejects.toThrow('42');
    expect(issues[1].state).toBe('closed');
  });

  it('waits for a newly-created marker Issue to appear before cleanup', async () => {
    const candidate = issue();
    const listResponses = [[], [], [candidate], [candidate]];
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) {
        return jsonResponse(listResponses.shift() ?? [candidate]);
      }
      if (init?.method === 'PATCH') candidate.state = 'closed';
      return jsonResponse(candidate);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      consistencyAttempts: 4,
      sleepImpl,
    });

    expect(cleanup.closedNumbers).toEqual([42]);
    expect(cleanup.openNumbers).toEqual([]);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when marker cleanup never observes the newly-created Issue', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([]));

    await expect(
      closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        consistencyAttempts: 3,
        sleepImpl: noWait,
      })
    ).rejects.toThrow('appeared within the retry bound');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('requires stable zero-open evidence after cleanup', async () => {
    const candidate = issue();
    const listResponses = [[candidate], [], []];
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) {
        return jsonResponse(listResponses.shift() ?? []);
      }
      if (init?.method === 'PATCH') candidate.state = 'closed';
      return jsonResponse(candidate);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      consistencyAttempts: 3,
      sleepImpl,
    });

    expect(cleanup.openNumbers).toEqual([]);
    expect(listResponses).toEqual([]);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a late open match after a transient empty final list', async () => {
    const candidate = issue();
    const lateDuplicate = issue({ number: 43 });
    const listResponses = [[candidate], [], [lateDuplicate], [lateDuplicate]];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) {
        return jsonResponse(listResponses.shift() ?? [lateDuplicate]);
      }
      if (init?.method === 'PATCH') candidate.state = 'closed';
      return jsonResponse(candidate);
    });

    await expect(
      closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        consistencyAttempts: 3,
        sleepImpl: noWait,
      })
    ).rejects.toThrow('still open after cleanup: #43');
    expect(listResponses).toEqual([]);
  });

  it('treats an ambiguous close as success when exact readback is closed', async () => {
    const candidate = issue();
    let listCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/issues?')) {
        listCount += 1;
        return jsonResponse([candidate]);
      }
      if (init?.method === 'PATCH') {
        candidate.state = 'closed';
        return new Response('gateway lost the response', { status: 502 });
      }
      return jsonResponse(candidate);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      sleepImpl: noWait,
    });

    expect(cleanup.closedNumbers).toEqual([42]);
    expect(listCount).toBe(3);
  });

  it('reconciles an accepted close whose response body terminates without repeating the PATCH', async () => {
    const candidate = issue();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) return jsonResponse([candidate]);
      if (init?.method === 'PATCH') {
        candidate.state = 'closed';
        return terminatedResponse();
      }
      return jsonResponse(candidate);
    });

    await expect(
      closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        sleepImpl: noWait,
      })
    ).resolves.toMatchObject({ closedNumbers: [42], openNumbers: [] });
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1);
  });

  it('reconciles an accepted close with malformed JSON by exact readback without repeating it', async () => {
    const candidate = issue();
    let exactGetCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) return jsonResponse([candidate]);
      if (init?.method === 'PATCH') {
        candidate.state = 'closed';
        return new Response('not-json', { status: 200 });
      }
      exactGetCount += 1;
      return jsonResponse(candidate);
    });

    await expect(
      closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        sleepImpl: noWait,
      })
    ).resolves.toMatchObject({ closedNumbers: [42], openNumbers: [] });
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1);
    expect(exactGetCount).toBe(1);
  });

  it('retries an ambiguous close once only after readback proves the Issue is still open', async () => {
    const candidate = issue();
    let patchCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/issues?')) return jsonResponse([candidate]);
      if (init?.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 1) return new Response('timeout', { status: 504 });
        candidate.state = 'closed';
      }
      return jsonResponse(candidate);
    });

    await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      sleepImpl: noWait,
    });

    expect(patchCount).toBe(2);
    expect(candidate.state).toBe('closed');
  });

  it('waits for stale exact and paginated close readbacks without another PATCH', async () => {
    const openCandidate = issue();
    const closedCandidate = issue({ state: 'closed' });
    const exactStates = [openCandidate, openCandidate, closedCandidate];
    const listStates = [[openCandidate], [openCandidate], [openCandidate], [closedCandidate]];
    const sleepImpl = vi.fn(async () => {});
    let patchCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'PATCH') {
        patchCount += 1;
        return jsonResponse(closedCandidate);
      }
      if (String(input).includes('/issues?')) {
        return jsonResponse(listStates.shift() ?? [closedCandidate]);
      }
      return jsonResponse(exactStates.shift() ?? closedCandidate);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      marker: MARKER,
      consistencyAttempts: 4,
      sleepImpl,
    });

    expect(cleanup.openNumbers).toEqual([]);
    expect(patchCount).toBe(1);
    expect(sleepImpl).toHaveBeenCalledTimes(5);
  });

  it('sweeps only open non-PR Issues with the reserved title prefix', async () => {
    const stale = issue({ title: `${CANARY_TITLE_PREFIX} stale-run`, body: 'stale' });
    const human = issue({ number: 43, title: 'Human issue', body: CANARY_TITLE_PREFIX });
    const pullRequest = issue({
      number: 44,
      title: `${CANARY_TITLE_PREFIX} pull-request`,
      pull_request: { url: 'https://api.github.com/pulls/44' },
    });
    const issues = [stale, human, pullRequest];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/issues?')) return jsonResponse(issues);
      stale.state = init?.method === 'PATCH' ? 'closed' : stale.state;
      return jsonResponse(stale);
    });

    const cleanup = await closeMatchingIssues({
      fetchImpl,
      repo: REPO,
      token: TOKEN,
      prefix: CANARY_TITLE_PREFIX,
      sleepImpl: noWait,
    });

    expect(cleanup.matchedNumbers).toEqual([42]);
    expect(human.state).toBe('open');
    expect(pullRequest.state).toBe('open');
    expect(
      fetchImpl.mock.calls
        .filter(call => String(call[0]).includes('/issues?'))
        .every(call => String(call[0]).includes('state=open'))
    ).toBe(true);
  });

  it('does not retry a deterministic close failure or expose its body', async () => {
    const candidate = issue();
    let message = '';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/issues?')) return jsonResponse([candidate]);
      if (init?.method === 'PATCH') return new Response(`forbidden ${TOKEN}`, { status: 422 });
      return jsonResponse(candidate);
    });
    try {
      await closeMatchingIssues({
        fetchImpl,
        repo: REPO,
        token: TOKEN,
        marker: MARKER,
        sleepImpl: noWait,
        retrySleepImpl: noWait,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1);
    expect(message).toContain('github_request_failed');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('forbidden');
  });

  it('redacts the token from API errors and never calls the Issues create endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`failure echoed ${TOKEN}`, {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    let message = '';
    try {
      await listMatchingIssues({ fetchImpl, repo: REPO, token: TOKEN, marker: MARKER });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(TOKEN);
    expect(message).toContain('[REDACTED]');
    expect(fetchImpl.mock.calls.every(call => initMethod(call[1]) !== 'POST')).toBe(true);
  });
});

describe('GitHub Issue canary CLI', () => {
  it('verifies through the CLI without exposing its token', async () => {
    const fetchImpl = issueFetch([issue()]);
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(
      [
        'verify',
        '--repo',
        REPO,
        '--marker',
        MARKER,
        '--expected-sha',
        SHA,
        '--result-file',
        'result.json',
      ],
      {
        fetchImpl,
        env: { BUGDROP_CANARY_GITHUB_TOKEN: TOKEN },
        readFileImpl: vi.fn().mockResolvedValue(JSON.stringify(result())),
        stdout: value => output.push(value),
        stderr: value => errors.push(value),
        sleepImpl: noWait,
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0])).toEqual({
      verified: true,
      issueNumber: 42,
      issueUrl: `https://github.com/${REPO}/issues/42`,
    });
    expect(errors).toEqual([]);
    expect(output.join('\n')).not.toContain(TOKEN);
  });

  it('fails closed before an API request when the token is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const errors: string[] = [];

    const exitCode = await runCli(['sweep', '--repo', REPO, '--prefix', CANARY_TITLE_PREFIX], {
      fetchImpl,
      env: {},
      stdout: vi.fn(),
      stderr: value => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('BUGDROP_CANARY_GITHUB_TOKEN is required');
  });

  it('reports malformed arguments without an uncaught exception', async () => {
    const errors: string[] = [];

    const exitCode = await runCli(['cleanup', '--marker'], {
      fetchImpl: vi.fn<typeof fetch>(),
      env: { BUGDROP_CANARY_GITHUB_TOKEN: TOKEN },
      stdout: vi.fn(),
      stderr: value => errors.push(value),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['[bugdrop-canary] --marker requires a value']);
  });
});

function initMethod(init: RequestInit | undefined): string {
  return init?.method ?? 'GET';
}
