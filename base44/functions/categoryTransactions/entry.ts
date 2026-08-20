import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { norm, buildIndexes, accountsForNames } from '../../shared/rollupHelpers.ts';

// Return the YTD transactions behind a category or live account, for drill-down.
// Resolution order:
//   account_id     — Live QuickBooks page: a single QBO account.
//   category + qb_account_names — Spending Detail: every QBO account whose
//                    name matches the category or any name in the list.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { period_id, account_id, category, qb_account_names, source_filter } = body;
    if (!period_id) return Response.json({ error: 'period_id required' }, { status: 400 });
    if (!account_id && !category)
      return Response.json({ error: 'account_id or category required' }, { status: 400 });

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

    let matched;
    if (account_id) {
      // Live QuickBooks page drilldown: a single QBO account.
      matched = ytdTxns.filter((t) => t.account_id === account_id);
    } else {
      // Spending Detail drilldown: QBO accounts matching the category name
      // or any extra name in qb_account_names.
      const accounts = await base44.asServiceRole.entities.Account.filter({});
      const { byName } = buildIndexes(accounts);
      const ids = new Set(accountsForNames(category, qb_account_names, byName).map((a) => a.id));
      matched = ytdTxns.filter((t) => t.account_id && ids.has(t.account_id));
    }

    // Source isolation: the Excel tab sees only manual/import records, the
    // QuickBooks tab sees only QBO-synced records, the Admin reconciliation
    // view (no filter) sees both.
    let filtered = matched;
    if (source_filter === 'excel') filtered = matched.filter((t) => t.source !== 'quickbooks');
    else if (source_filter === 'quickbooks') filtered = matched.filter((t) => t.source === 'quickbooks');

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
      account_id: account_id || null,
      category: category || null,
      source_filter: source_filter || null,
      total: rows.length,
      ytd_amount: rows.reduce((s, r) => s + r.amount, 0),
      month_amount: rows.filter((r) => r.in_month).reduce((s, r) => s + r.amount, 0),
      transactions: rows,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}