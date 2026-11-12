import { describe, expect, it, vi } from 'vitest';

import {
  classifyHeartbeatOutcome,
  outcome,
  sendHeartbeatOutcome,
} from '../scripts/production-heartbeat-outcome.mjs';

const observedAt = '2026-08-12T12:34:56.789Z';
const stages = Object.fromEntries(
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
    'cleanup',
    'sweep',
  ].map(stage => [stage, 'success'])
);

describe('production heartbeat classification', () => {
  const browserTimeout = {
    evidence: outcome('inconclusive', 'browser_inconclusive', observedAt),
    stages: { ...stages, browser: 'failure', canary: 'skipped', verify: 'skipped' },
    admitted: true,
    noSubmission: true,
    artifactPrepare: 'success',
    artifact: 'success',
    incident: 'success',
  };

  it('reports an explicitly verified pre-submission setup failure without claiming delivery', () => {
    expect(classifyHeartbeatOutcome(browserTimeout)).toEqual({
      schemaVersion: 1,
      outcome: 'inconclusive',
      reasonCode: 'pre_submission_setup_failed',
      observedAt,
    });
  });

  it('does not forward the pre-submission reason from canary evidence', () => {
    expect(
      classifyHeartbeatOutcome({
        ...browserTimeout,
        stages,
        evidence: outcome('inconclusive', 'pre_submission_setup_failed', observedAt),
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'classification_failed' });
  });

  it.each([
    { noSubmission: false },
    { admitted: false },
    { evidence: undefined },
    { stages: { ...browserTimeout.stages, canary: 'failure' } },
    { stages: { ...browserTimeout.stages, verify: 'success' } },
    { stages: { ...browserTimeout.stages, cleanup: 'failure' } },
    { stages: { ...browserTimeout.stages, sweep: 'failure' } },
    { artifact: 'failure' },
  ])(
    'keeps incomplete or contradictory setup evidence inconclusive with a generic reason',
    overrides => {
      expect(classifyHeartbeatOutcome({ ...browserTimeout, ...overrides })).toMatchObject({
        outcome: 'inconclusive',
        reasonCode: 'setup_failed',
      });
    }
  );

  it.each([
    ['verified', 'issue_verified'],
    ['delivery_failed', 'issue_absent'],
    ['delivery_failed', 'issue_duplicate'],
    ['delivery_failed', 'issue_contract_invalid'],
  ])('preserves authoritative %s evidence through ancillary failures', (name, reasonCode) => {
    const evidence = outcome(name, reasonCode, observedAt);
    expect(
      classifyHeartbeatOutcome({
        evidence,
        stages: { ...stages, cleanup: 'failure', sweep: 'failure' },
        artifactPrepare: 'failure',
        artifact: 'failure',
        incident: 'failure',
      })
    ).toEqual(evidence);
  });

  it.each([
    ['checkout', 'setup_failed'],
    ['browser', 'setup_failed'],
    ['identity', 'identity_failed'],
    ['venue', 'venue_failed'],
    ['preflight', 'cleanup_failed'],
    ['canary', 'browser_inconclusive'],
    ['cleanup', 'cleanup_failed'],
    ['sweep', 'sweep_failed'],
  ])('maps a %s stage failure to %s', (stage, reasonCode) => {
    expect(
      classifyHeartbeatOutcome({
        stages: { ...stages, [stage]: 'failure' },
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'success',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode });
  });

  it('prioritizes identity over skipped dependent preflight, venue, and canary stages', () => {
    expect(
      classifyHeartbeatOutcome({
        stages: {
          ...stages,
          identity: 'failure',
          preflight: 'skipped',
          venue: 'skipped',
          canary: 'skipped',
        },
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'success',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'identity_failed' });
  });

  it('classifies the real preflight failure path before browser-inconclusive evidence', () => {
    expect(
      classifyHeartbeatOutcome({
        evidence: outcome('inconclusive', 'browser_inconclusive', observedAt),
        stages: { ...stages, preflight: 'failure', canary: 'skipped' },
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'success',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'cleanup_failed' });
  });

  it('maps artifact and incident failures without inventing delivery failure', () => {
    expect(
      classifyHeartbeatOutcome({
        stages,
        artifactPrepare: 'failure',
        artifact: 'success',
        incident: 'success',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'artifact_failed' });
    expect(
      classifyHeartbeatOutcome({
        stages,
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'failure',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'incident_failed' });
  });

  it.each([
    'github_network',
    'github_5xx',
    'github_rate_limited',
    'github_auth_failed',
    'classification_failed',
  ])('preserves sanitized evidence reason %s', reasonCode => {
    const evidence = outcome('inconclusive', reasonCode, observedAt);
    expect(
      classifyHeartbeatOutcome({
        evidence,
        stages,
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'success',
      })
    ).toEqual(evidence);
  });

  it('fails malformed evidence closed as sanitized inconclusive classification', () => {
    expect(
      classifyHeartbeatOutcome({
        evidence: {
          schemaVersion: 1,
          outcome: 'delivery_failed',
          reasonCode: 'free form',
          observedAt: 'invalid',
        },
        stages,
        artifactPrepare: 'success',
        artifact: 'success',
        incident: 'success',
      })
    ).toMatchObject({ outcome: 'inconclusive', reasonCode: 'classification_failed' });
  });
});

describe('production heartbeat sender', () => {
  it('sends exact v1 JSON and accepts the strict receiver response', async () => {
    const report = outcome('verified', 'issue_verified', observedAt);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          schemaVersion: 1,
          accepted: true,
          duplicate: false,
          outcome: 'verified',
          effect: 'verified',
          observedAt,
        },
        { headers: { 'cache-control': 'no-store' } }
      )
    );
    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report,
      })
    ).resolves.toMatchObject({ accepted: true });
    const request = fetchImpl.mock.calls[0];
    expect(request[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'X-BugDrop-Heartbeat-Id': '123:1',
    });
    expect(JSON.parse(String(request[1]?.body))).toEqual(report);
  });

  it('retries transient network and selected 5xx failures with byte-identical requests', async () => {
    const report = outcome('delivery_failed', 'issue_absent', observedAt);
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('timed out', 'AbortError'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            schemaVersion: 1,
            accepted: true,
            duplicate: false,
            outcome: 'delivery_failed',
            effect: 'degraded',
            observedAt,
          },
          { headers: { 'cache-control': 'no-store' } }
        )
      );

    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report,
        retrySleepImpl,
      })
    ).resolves.toMatchObject({ effect: 'degraded' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(retrySleepImpl.mock.calls).toEqual([[1_000], [2_000]]);
    const requestMaterial = fetchImpl.mock.calls.map(([endpoint, request]) => ({
      endpoint,
      method: request?.method,
      redirect: request?.redirect,
      headers: request?.headers,
      body: request?.body,
    }));
    expect(requestMaterial[1]).toEqual(requestMaterial[0]);
    expect(requestMaterial[2]).toEqual(requestMaterial[0]);
  });

  it('retries a terminated 200 response body with the identical stable request', async () => {
    const report = outcome('verified', 'issue_verified', observedAt);
    const retrySleepImpl = vi.fn(async () => {});
    const terminated = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(terminated)
      .mockResolvedValueOnce(
        Response.json(
          {
            schemaVersion: 1,
            accepted: true,
            duplicate: true,
            outcome: 'verified',
            effect: 'recorded_only',
            observedAt,
          },
          { headers: { 'cache-control': 'no-store' } }
        )
      );

    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report,
        retrySleepImpl,
      })
    ).resolves.toMatchObject({ duplicate: true, effect: 'recorded_only' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retrySleepImpl.mock.calls).toEqual([[1_000]]);
    const requestMaterial = fetchImpl.mock.calls.map(([endpoint, request]) => ({
      endpoint,
      method: request?.method,
      redirect: request?.redirect,
      headers: request?.headers,
      body: request?.body,
    }));
    expect(requestMaterial[1]).toEqual(requestMaterial[0]);
  });

  it('does not retry a fully received malformed 200 response body', async () => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('not-json', { status: 200, headers: { 'cache-control': 'no-store' } })
      );

    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report: outcome('verified', 'issue_verified', observedAt),
        retrySleepImpl,
      })
    ).rejects.toThrow('heartbeat_receiver_response_invalid');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401, 409, 429])('does not retry deterministic HTTP %s', async status => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report: outcome('verified', 'issue_verified', observedAt),
        retrySleepImpl,
      })
    ).rejects.toThrow(`heartbeat_receiver_http_${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it.each([301, 302])('handles redirect HTTP %s as one deterministic response', async status => {
    const retrySleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status,
        headers: { location: 'https://example.invalid/redirected' },
      })
    );
    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report: outcome('verified', 'issue_verified', observedAt),
        retrySleepImpl,
      })
    ).rejects.toThrow(`heartbeat_receiver_http_${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('manual');
    expect(retrySleepImpl).not.toHaveBeenCalled();
  });

  it('accepts idempotent recorded_only responses but rejects a false inconclusive transition', async () => {
    const report = outcome('inconclusive', 'github_network', observedAt);
    await expect(
      sendHeartbeatOutcome({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              schemaVersion: 1,
              accepted: true,
              duplicate: true,
              outcome: 'inconclusive',
              effect: 'recorded_only',
              observedAt,
            },
            { headers: { 'cache-control': 'no-store' } }
          )
        ),
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report,
      })
    ).resolves.toMatchObject({ duplicate: true, effect: 'recorded_only' });
    await expect(
      sendHeartbeatOutcome({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              schemaVersion: 1,
              accepted: true,
              duplicate: false,
              outcome: 'inconclusive',
              effect: 'verified',
              observedAt,
            },
            { headers: { 'cache-control': 'no-store' } }
          )
        ),
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:2',
        report,
      })
    ).rejects.toThrow('heartbeat_receiver_response_invalid');
  });

  it.each([
    [new Response(null, { status: 204 }), 'heartbeat_receiver_http_204'],
    [
      Response.json({ schemaVersion: 1 }, { headers: { 'cache-control': 'no-store' } }),
      'heartbeat_receiver_response_invalid',
    ],
    [
      Response.json(
        {
          schemaVersion: 1,
          accepted: true,
          duplicate: false,
          outcome: 'verified',
          effect: 'verified',
          observedAt,
        },
        { headers: { 'cache-control': 'max-age=60' } }
      ),
      'heartbeat_receiver_cache_invalid',
    ],
  ])('rejects an invalid receiver contract without including its body', async (response, error) => {
    await expect(
      sendHeartbeatOutcome({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report: outcome('verified', 'issue_verified', observedAt),
      })
    ).rejects.toThrow(error);
  });

  it('rejects free-form reasons and noncanonical timestamps before network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      sendHeartbeatOutcome({
        fetchImpl,
        endpoint: 'https://bugdrop.dev/api/monitor/heartbeat',
        secret: 'secret',
        heartbeatId: '123:1',
        report: {
          schemaVersion: 1,
          outcome: 'delivery_failed',
          reasonCode: 'network broke',
          observedAt,
        },
      })
    ).rejects.toThrow('heartbeat_outcome_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
