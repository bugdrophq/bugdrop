import { describe, expect, it, vi } from 'vitest';

import {
  INCIDENT_TITLE,
  listIncidents,
  transitionHeartbeatIncident,
} from '../scripts/github-heartbeat-incident.mjs';

const TOKEN = 'incident-token-redaction-sentinel';
const RUN_URL = 'https://github.com/bugdrophq/bugdrop/actions/runs/123';
const noWait = vi.fn(async () => {});

function response(value: unknown, init: ResponseInit = {}): Response {
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

function incident(
  state: 'open' | 'closed' = 'open',
  number = 7,
  body = 'Production heartbeat failure. Classification: issue_absent.'
) {
  return { number, title: INCIDENT_TITLE, state, body };
}

function transition(fetchImpl: typeof fetch, outcome: 'failure' | 'recovery' | 'inconclusive') {
  return transitionHeartbeatIncident({
    fetchImpl,
    token: TOKEN,
    outcome,
    runUrl: RUN_URL,
    details: 'synthetic stage result',
    retrySleepImpl: noWait,
  });
}

describe('heartbeat incident discovery', () => {
  it('retries GET network and selected 5xx failures exactly three times with bounded delays', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`network ${TOKEN}`))
      .mockResolvedValueOnce(new Response(`upstream ${TOKEN}`, { status: 504 }))
      .mockResolvedValueOnce(response([incident()]));
    await expect(listIncidents({ fetchImpl, token: TOKEN, retrySleepImpl })).resolves.toHaveLength(
      1
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(retrySleepImpl.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('retries a terminated GET response body on the same URL', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(terminatedResponse())
      .mockResolvedValueOnce(response([incident()]));

    await expect(listIncidents({ fetchImpl, token: TOKEN, retrySleepImpl })).resolves.toHaveLength(
      1
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(String(fetchImpl.mock.calls[0][0]));
    expect(retrySleepImpl.mock.calls).toEqual([[1_000]]);
  });

  it('classifies a terminated 401 response from status without retrying its body', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(terminatedResponse(401));

    await expect(listIncidents({ fetchImpl, token: TOKEN, retrySleepImpl })).rejects.toThrow(
      'github_auth'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'github_rate_limited',
      new Response(`quota ${TOKEN}`, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ],
    ['github_auth', new Response(`auth ${TOKEN}`, { status: 401 })],
    ['github_request_failed', new Response(`missing ${TOKEN}`, { status: 404 })],
    ['github_response_invalid', new Response(`not-json ${TOKEN}`, { status: 200 })],
  ])('does not retry deterministic GET failure %s', async (category, failedResponse) => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(failedResponse);
    await expect(listIncidents({ fetchImpl, token: TOKEN, retrySleepImpl })).rejects.toThrow(
      category
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it('retries the same incident page without duplicating prior page entries', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const pageTwo = 'https://api.github.com/repos/bugdrophq/bugdrop/issues?state=all&page=2';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([incident('open', 7)], { headers: { Link: `<${pageTwo}>; rel="next"` } })
      )
      .mockResolvedValueOnce(new Response('temporary', { status: 500 }))
      .mockResolvedValueOnce(response([incident('closed', 8)]));
    const matches = await listIncidents({ fetchImpl, token: TOKEN, retrySleepImpl });
    expect(matches.map(candidate => candidate.number)).toEqual([7, 8]);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(pageTwo);
    expect(String(fetchImpl.mock.calls[2][0])).toBe(pageTwo);
  });

  it('paginates, filters pull requests, and rejects duplicate incidents before mutation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([{ ...incident(), pull_request: {} }], {
          headers: {
            Link: '<https://api.github.com/repos/bugdrophq/bugdrop/issues?state=all&page=2>; rel="next"',
          },
        })
      )
      .mockResolvedValueOnce(response([incident('open', 7), incident('closed', 8)]));
    await expect(transition(fetchImpl, 'failure')).rejects.toThrow('found 2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  });

  it('returns only the stable exact incident title', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response([incident(), { ...incident('open', 8), title: `${INCIDENT_TITLE} extra` }])
      );
    await expect(listIncidents({ fetchImpl, token: TOKEN })).resolves.toHaveLength(1);
  });

  it('scopes incident discovery to the configured private operational repository', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([]));
    await listIncidents({ fetchImpl, token: TOKEN, repo: 'acme/private-bugdrop' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/repos/acme/private-bugdrop/issues');
  });
});

describe('heartbeat incident lifecycle', () => {
  it('creates, comments, and reopens a sanitized inconclusive incident', async () => {
    const body = 'Production heartbeat inconclusive. Classification: github_network.';
    const created = incident('open', 7, body);
    const createFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(created));
    await expect(
      transitionHeartbeatIncident({
        fetchImpl: createFetch,
        token: TOKEN,
        outcome: 'inconclusive',
        reasonCode: 'github_network',
      })
    ).resolves.toMatchObject({ action: 'created' });
    expect(JSON.parse(String(createFetch.mock.calls[1][1]?.body))).toEqual({
      title: INCIDENT_TITLE,
      body,
    });

    const updateFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([created]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 99 }));
    await expect(
      transitionHeartbeatIncident({
        fetchImpl: updateFetch,
        token: TOKEN,
        outcome: 'inconclusive',
        reasonCode: 'github_network',
      })
    ).resolves.toMatchObject({ action: 'updated' });

    const closed = incident('closed', 7, body);
    const reopenFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([closed]))
      .mockResolvedValueOnce(response(created))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 100 }));
    await expect(
      transitionHeartbeatIncident({
        fetchImpl: reopenFetch,
        token: TOKEN,
        outcome: 'inconclusive',
        reasonCode: 'github_network',
      })
    ).resolves.toMatchObject({ action: 'reopened' });
    expect(JSON.parse(String(reopenFetch.mock.calls[1][1]?.body))).toEqual({
      state: 'open',
      body,
    });
  });

  it('comments without closing or relabeling an active confirmed failure as inconclusive', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([incident()]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 101 }));
    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'inconclusive',
        reasonCode: 'cleanup_failed',
      })
    ).resolves.toMatchObject({ action: 'updated', state: 'open' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false);
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      body: 'Production heartbeat inconclusive. Classification: cleanup_failed.',
    });
  });

  it('reopens a closed confirmed failure without replacing its body for inconclusive evidence', async () => {
    const closed = incident('closed');
    const reopened = incident('open');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([closed]))
      .mockResolvedValueOnce(response(reopened))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 103 }));

    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'inconclusive',
        reasonCode: 'github_network',
      })
    ).resolves.toMatchObject({ action: 'reopened', state: 'open' });

    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ state: 'open' });
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({
      body: 'Production heartbeat inconclusive. Classification: github_network.',
    });
  });

  it('promotes an open inconclusive incident to confirmed failure before commenting', async () => {
    const confirmedBody = 'Production heartbeat failure. Classification: issue_absent.';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([
          incident(
            'open',
            7,
            'Production heartbeat inconclusive. Classification: browser_inconclusive.'
          ),
        ])
      )
      .mockResolvedValueOnce(response(incident('open', 7, confirmedBody)))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 102 }));
    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'failure',
        reasonCode: 'issue_absent',
      })
    ).resolves.toMatchObject({ action: 'updated', state: 'open' });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ body: confirmedBody });
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({ body: confirmedBody });
  });

  it('creates on first failure and comments on recurrence', async () => {
    const created = incident();
    const createFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(created));
    await expect(transition(createFetch, 'failure')).resolves.toMatchObject({ action: 'created' });
    expect(JSON.parse(String(createFetch.mock.calls[1][1]?.body))).toMatchObject({
      title: INCIDENT_TITLE,
    });

    const updateFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([created]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 99 }));
    await expect(transition(updateFetch, 'failure')).resolves.toMatchObject({ action: 'updated' });
    expect(String(updateFetch.mock.calls[2][0])).toContain('/issues/7/comments');
  });

  it('uses only normalized classification in new incident comments', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(incident()));
    await transitionHeartbeatIncident({
      fetchImpl,
      token: TOKEN,
      outcome: 'failure',
      reasonCode: 'issue_absent',
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).body;
    expect(body).toBe('Production heartbeat failure. Classification: issue_absent.');
    expect(body).not.toContain('runs/');
  });

  it('reopens a closed incident on recurrence, then comments', async () => {
    const closed = incident('closed');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([closed]))
      .mockResolvedValueOnce(response(incident('open')))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 99 }));
    await expect(transition(fetchImpl, 'failure')).resolves.toMatchObject({ action: 'reopened' });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ state: 'open' });
  });

  it('comments and closes one open incident on recovery', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([incident()]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: 99 }))
      .mockResolvedValueOnce(response(incident('closed')));
    await expect(transition(fetchImpl, 'recovery')).resolves.toMatchObject({ action: 'closed' });
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
  });

  it('does nothing when recovery has no incident', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([]));
    await expect(transition(fetchImpl, 'recovery')).resolves.toEqual({
      action: 'none',
      state: 'absent',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous comment failure when only a historical identical comment exists', async () => {
    const body = 'Production heartbeat failure. Classification: issue_absent.';
    const historical = { id: 10, body };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([incident()]))
      .mockResolvedValueOnce(response([historical]))
      .mockRejectedValueOnce(new Error('connection failed before acceptance'))
      .mockResolvedValueOnce(response([historical]));

    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'failure',
        reasonCode: 'issue_absent',
        retrySleepImpl: noWait,
      })
    ).rejects.toThrow('could not be reconciled');
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('reconciles after-acceptance ambiguity only from a new paginated exact-body identity', async () => {
    const body = 'Production heartbeat failure. Classification: issue_absent.';
    const pageTwo = 'https://api.github.com/repos/bugdrophq/bugdrop/issues/7/comments?page=2';
    const historical = { id: 10, body };
    const unrelated = { id: 20, body: 'different sanitized comment' };
    const accepted = { id: 11, body };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([incident()]))
      .mockResolvedValueOnce(
        response([historical], { headers: { Link: `<${pageTwo}>; rel="next"` } })
      )
      .mockResolvedValueOnce(response([unrelated]))
      .mockRejectedValueOnce(new Error('response lost after acceptance'))
      .mockResolvedValueOnce(
        response([historical], { headers: { Link: `<${pageTwo}>; rel="next"` } })
      )
      .mockResolvedValueOnce(response([unrelated, accepted]));

    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'failure',
        reasonCode: 'issue_absent',
        retrySleepImpl: noWait,
      })
    ).resolves.toMatchObject({ action: 'updated' });
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[2][0])).toBe(pageTwo);
    expect(String(fetchImpl.mock.calls[5][0])).toBe(pageTwo);
  });

  it('does not reconcile a deterministic comment failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([incident()]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(new Response(`forbidden ${TOKEN}`, { status: 422 }));

    await expect(
      transitionHeartbeatIncident({
        fetchImpl,
        token: TOKEN,
        outcome: 'failure',
        reasonCode: 'issue_absent',
        retrySleepImpl: noWait,
      })
    ).rejects.toThrow('github_request_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('reconciles an ambiguous create by rediscovery', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(response([incident()]));
    await expect(transition(fetchImpl, 'failure')).resolves.toMatchObject({ action: 'created' });
  });

  it('reconciles an accepted create whose response body terminates without repeating the POST', async () => {
    let created = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST') {
        created = true;
        return terminatedResponse(201);
      }
      return response(created ? [incident()] : []);
    });

    await expect(transition(fetchImpl, 'failure')).resolves.toMatchObject({ action: 'created' });
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('redacts the token on a failed mutation and failed reconciliation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockRejectedValueOnce(new Error(`lost ${TOKEN}`))
      .mockRejectedValueOnce(new Error(`also ${TOKEN}`));
    let message = '';
    try {
      await transition(fetchImpl, 'failure');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(TOKEN);
  });

  it('fails a deterministic native mutation immediately without reconciliation or body leakage', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(new Response(`forbidden ${TOKEN}`, { status: 422 }));
    let message = '';
    try {
      await transition(fetchImpl, 'failure');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    expect(message).toContain('github_request_failed');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('forbidden');
  });
});
