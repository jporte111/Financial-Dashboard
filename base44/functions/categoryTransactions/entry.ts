import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { norm } from '../../shared/rollupHelpers.ts';

// Return the YTD transactions behind a category or live account, for drill-down.
// Resolution order:
//   qb_code    — Spending Detail: all QBO accounts sharing that account_code.
//   account_id — Live QuickBooks page: a single QBO account.
//   category   — Snapshot-only fallback (legacy/import rows with no code).
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { period_id, account_id, qb_code, category } = body;
    if (!period_id) return Response.json({ error: 'period_id required' }, { status: 400 });
    if (!account_id && !qb_code && !category)
      return Response.json({ error: 'account_id, qb_code, or category required' }, { status: 400 });

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
    if (qb_code) {
      // Spending Detail drilldown: every QBO account sharing this code.
      const accounts = await base44.asServiceRole.entities.Account.filter({});
      const ids = new Set(
        accounts.filter((a) => a.source === 'quickbooks' && a.account_code === qb_code).map((a) => a.id)
      );
      matched = ytdTxns.filter((t) => t.account_id && ids.has(t.account_id));
    } else if (account_id) {
      // Live QuickBooks page drilldown: a single QBO account.
      matched = ytdTxns.filter((t) => t.account_id === account_id);
    } else {
      // Snapshot-only fallback: match by normalized category name.
      const key = norm(category);
      matched = ytdTxns.filter((t) => {
        if (t.category && norm(t.category) === key) return true;
        const path = t.full_account_path || '';
        const leaf = path.split(':').pop().trim();
        const namePart = leaf.replace(/^\d+\s*[-:]?\s*/, '').trim();
        return namePart && norm(namePart) === key;
      });
    }

    const rows = matched.map((t) => ({
      id: t.id,
      date: (t.date || '').slice(0, 10),
      vendor: t.vendor || '',
      description: t.description || '',
      amount: Number(t.amount || 0),
      full_account_path: t.full_account_path || '',
      in_month: inMonth(t),
    }));

    return Response.json({
      period_id,
      account_id: account_id || null,
      qb_code: qb_code || null,
      category: category || null,
      total: rows.length,
      ytd_amount: rows.reduce((s, r) => s + r.amount, 0),
      month_amount: rows.filter((r) => r.in_month).reduce((s, r) => s + r.amount, 0),
      transactions: rows,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}