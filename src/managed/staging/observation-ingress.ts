import type { StagingIngressEnv } from './ingress-env';
import { record, reject } from '../local/protocol';
import { exactObservation, observationCall, observationUuid } from './observation-wire';

export async function observeCapability(
  request: Request,
  env: StagingIngressEnv,
  action: (target: StagingIngressEnv) => Promise<Response>
): Promise<Response> {
  if (
    env.STAGING_OBSERVATION_ENABLED !== 'true' ||
    new URL(request.url).pathname !== '/v1/submission-capabilities'
  )
    return action(env);
  try {
    // Snapshot binding and scope; never send a finish to a reconfigured application.
    const target = { ...env };
    const begun = exactObservation(
      await observationCall(target.STAGING_OBSERVATION, target, '/observation/begin', {
        sdkVersion: request.headers.get('X-BugDrop-SDK-Version') === '0.1.0' ? '0.1.0' : null,
      }),
      ['schemaVersion', 'requestNonce', 'leaseId', 'expiresAt', 'sequence', 'snapshot', 'exchanges']
    );
    observationUuid(begun.leaseId);
    const snapshot = record(begun.snapshot);
    if (
      begun.schemaVersion !== 2 ||
      snapshot.applicationId !== target.STAGING_APPLICATION_ID ||
      typeof begun.sequence !== 'number' ||
      !Number.isSafeInteger(begun.sequence) ||
      begun.sequence < 1 ||
      begun.sequence > 64
    )
      reject();
    if (
      target.STAGING_APPLICATION_ID !== env.STAGING_APPLICATION_ID ||
      target.STAGING_INSTALLATION_ID !== env.STAGING_INSTALLATION_ID ||
      target.STAGING_OBSERVATION !== env.STAGING_OBSERVATION ||
      target.STAGING_AUTHORITY !== env.STAGING_AUTHORITY ||
      target.STAGING_OBSERVATION_HMAC_KEY !== env.STAGING_OBSERVATION_HMAC_KEY ||
      target.STAGING_ENABLED !== env.STAGING_ENABLED ||
      target.STAGING_OBSERVATION_ENABLED !== env.STAGING_OBSERVATION_ENABLED
    )
      reject();
    const response = await action(target);
    const finished = await observationCall(
      target.STAGING_OBSERVATION,
      target,
      '/observation/finish',
      {
        leaseId: begun.leaseId,
        runId: snapshot.runId,
        scenario: snapshot.scenario,
        sequence: begun.sequence,
        status: response.status,
      }
    );
    if (
      finished.leaseId !== begun.leaseId ||
      !Array.isArray(finished.exchanges) ||
      !finished.exchanges.some(value => {
        const entry = record(value);
        return entry.sequence === begun.sequence && entry.status === response.status;
      })
    )
      reject();
    return response;
  } catch {
    return Response.json(
      { error: 'staging_observation_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
