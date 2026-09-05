import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { transactionsForCategory } from '../../shared/categoryTransactionsCore.ts';

// Return the YTD transactions behind a BVA-reported category, for the
// Spending Detail drill-down. Authenticated endpoint — the public client view
// uses publicCategoryTransactions instead. The shared core reads only
// Transaction / Account records already stored in the database and always
// excludes QuickBooks-sourced records.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { period_id, category, qb_account_names } = body;
    if (!period_id) return Response.json({ error: 'period_id required' }, { status: 400 });
    if (!category) return Response.json({ error: 'category required' }, { status: 400 });

    const period = await base44.asServiceRole.entities.ReportingPeriod.get(period_id);
    if (!period) return Response.json({ error: 'Period not found' }, { status: 404 });

    return Response.json(await transactionsForCategory(base44, period, category, qb_account_names));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}