import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { buildPublicDashboard } from '../../shared/publicDashboardCore.ts';

// Public (no-login) dashboard data for the client view at /client (and the
// connected custom domain). Anyone can reach this endpoint. It reads with the
// service role (financial entities are admin-only for direct access), so ALL
// publication and field rules are enforced server-side in
// base44/shared/publicDashboardCore.ts: published + final periods only, and
// every record rebuilt from an explicit field allow-list.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    return Response.json(await buildPublicDashboard(base44.asServiceRole, body));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
