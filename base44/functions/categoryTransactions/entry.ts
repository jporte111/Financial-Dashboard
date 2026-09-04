import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { buildIndexes, accountsForNames } from '../../shared/rollupHelpers.ts';

// Return the YTD transactions behind a BVA-reported category, for the
// Spending Detail drill-down. This reads only Transaction records already
// stored in the database — it never calls QuickBooks or any other external
// API — and it always excludes any transaction whose source is
// 'quickbooks', so historical QuickBooks-synced records can never surface as
// if they were live data. The BVA workbook is the only financial-data source
// for the dashboard; this endpoint only ever supplements it with underlying
// transaction detail when such records already exist locally.
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

    // YTD = every period this year up to and including the selected month.
    const yearPeriods = await base44.asServiceRole.entities.ReportingPeriod.filter({ year: period.year }, 'month');
    const ytdPeriodIds = yearPeriods.filter((p) => p.month <= period.month).map((p) => p.id);

    let ytdTxns = [];
    if (ytdPeriodIds.length) {
      const batches = await Promise.all(
        ytdPeriodIds.map((pid) => base44.asServiceRole.entities.Transaction.filter({ period_id: pid }, '-date', 5000))
      );
      ytdTxns = batches.flat();
    }

    const start = period.start_date;
    const end = period.end_date;
    const inMonth = (t) => {
      const d = (t.date || '').slice(0, 10);
      return d && d >= start && d <= end;
    };

    // Match by category name (plus any extra names on the line) against
    // whatever Account records already exist — a local lookup, not a live call.
    const accounts = await base44.asServiceRole.entities.Account.filter({});
    const { byName } = buildIndexes(accounts);
    const ids = new Set(accountsForNames(category, qb_account_names, byName).map((a) => a.id));
    const matched = ytdTxns.filter((t) => t.account_id && ids.has(t.account_id));

    // BVA-only guarantee: never return a QuickBooks-sourced transaction, even
    // if one exists historically for a matched account.
    const filtered = matched.filter((t) => t.source !== 'quickbooks');

    const rows = filtered.map((t) => ({
      id: t.id,
      date: (t.date || '').slice(0, 10),
      vendor: t.vendor || '',
      description: t.description || '',
      amount: Number(t.amount || 0),
      full_account_path: t.full_account_path || '',
      source: t.source || '',
      in_month: inMonth(t),
    }));

    return Response.json({
      period_id,
      category,
      total: rows.length,
      ytd_amount: rows.reduce((s, r) => s + r.amount, 0),
      month_amount: rows.filter((r) => r.in_month).reduce((s, r) => s + r.amount, 0),
      transactions: rows,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
