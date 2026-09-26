import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { handlePeriodTransition } from '../../shared/periodTransitionCore.ts';

// The only supported way to finalize, publish, reopen or re-stage a reporting
// period. Admins only; all rules live in base44/shared/publishGate.ts and are
// enforced here, server-side, before a single-record state update. Direct
// writes of the protected state fields are refused by the ReportingPeriod
// entity rules; this function writes them with the service role.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch { user = null; }
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { status, body: out } = await handlePeriodTransition(base44, body, user);
    return Response.json(out, { status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
