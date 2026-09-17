import { hmac, utf8 } from '../local/protocol';
import type { WorkState } from './state';
export async function signedStatus(
  key: string,
  current: WorkState | undefined,
  fenced: boolean
): Promise<Response> {
  const state = current
    ? current.state === 'operator_action_required'
      ? current.state
      : current.completedAt !== null
        ? 'complete'
        : current.sqlQuarantined
          ? 'quarantined'
          : 'pending'
    : fenced
      ? 'retired'
      : 'absent';
  const response = JSON.stringify({ schemaVersion: 1, state, work: current ?? null });
  return new Response(response, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-BugDrop-Uninstall-Receipt-Signature': await hmac(
        key,
        utf8(`bugdrop:uninstall:status:v1\0${response}`)
      ),
    },
  });
}
