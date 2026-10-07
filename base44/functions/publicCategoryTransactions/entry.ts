import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { handlePublicCategoryRequest } from '../../shared/publicDashboardCore.ts';

// Public (no-login) category drill-down for the client view. Serves only the
// current published + final version of a month, with the budget line resolved
// on the server. It returns NO transaction rows: no transaction-detail source
// is approved for clients, and detail will only ever be offered to
// authenticated client users (PUBLIC_TRANSACTION_FIELDS is empty).
// See base44/shared/publicDashboardCore.ts.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { status, body: out } = await handlePublicCategoryRequest(base44, body);
    return Response.json(out, { status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
