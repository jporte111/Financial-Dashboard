import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { transactionsForCategory } from '../../shared/categoryTransactionsCore.ts';

// Public (no-login) version of the category drill-down for the client view.
// Anyone can reach this endpoint, so it serves ONLY periods that have been
// published and finalized — anything else is refused. The shared core is the
// exact same code the authenticated drill-down uses, so the client view always
// shows identical transaction detail.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { period_id, category, qb_account_names } = body;
    if (!period_id) return Response.json({ error: 'period_id required' }, { status: 400 });
    if (!category) return Response.json({ error: 'category required' }, { status: 400 });

    const period = await base44.asServiceRole.entities.ReportingPeriod.get(period_id);
    if (!period) return Response.json({ error: 'Period not found' }, { status: 404 });
    if (!period.published || period.status !== 'final') {
      return Response.json({ error: 'Period not published' }, { status: 403 });
    }

    return Response.json(await transactionsForCategory(base44, period, category, qb_account_names));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}