import { WorkerEntrypoint } from 'cloudflare:workers';
import { Client } from 'pg';
import { reconciliationFetch, type ReconciliationEnv } from './reconciliation-handler';

export class StagingReconciliation extends WorkerEntrypoint<ReconciliationEnv> {
  fetch(request: Request): Promise<Response> {
    return reconciliationFetch(request, this.env, config => new Client(config));
  }
}

export default {
  fetch() {
    return Response.json({ error: 'managed_request_rejected' }, { status: 403 });
  },
};
