/** Stage 0 never authenticates, delivers, mutates state, or reports readiness. */
export function unavailable(): Response {
  return Response.json(
    { error: 'managed_not_ready' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function health(request: Request, bindingsPresent: boolean): Response {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/health') {
    return unavailable();
  }
  return Response.json(
    { stage: 'local-scaffold', ready: false, bindingsPresent },
    { status: bindingsPresent ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
