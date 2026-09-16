export type Outcome =
  'delivered' | 'delivering' | 'indeterminate' | 'failed_before_delivery' | 'rejected';
const result = (outcome: Outcome) => ({ schemaVersion: 1 as const, outcome });
export const response = (outcome: Outcome): Response =>
  Response.json(result(outcome), { headers: { 'Cache-Control': 'no-store' } });
