import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { handlePublicCategoryRequest } from '../../shared/publicDashboardCore.ts';

// Public (no-login) category drill-down for the client view. Serves only
// published + final periods; the budget line and its account names are
// resolved on the server (caller-supplied account names are ignored), YTD is
// built from published periods only, and rows carry only displayed fields.
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
