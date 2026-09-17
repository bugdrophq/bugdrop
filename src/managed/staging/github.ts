// Closed until the separately reviewed Managed GitHub App adapter and target are present.
export default {
  fetch(): Response {
    return Response.json(
      { outcome: 'failed_before_delivery' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  },
};
