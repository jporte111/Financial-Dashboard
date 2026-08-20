import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { buildIndexes, rollUpByAccount, accountsForNames } from '../../shared/rollupHelpers.ts';

// Two outputs from the live (QuickBooks) layer:
//   rows         — Spending Detail: one row per BudgetLine (Excel report of
//                  record), with the live QBO column = sum of every QBO account
//                  whose name matches the line's category OR its qb_account_names.
//   liveAccounts — Live QuickBooks page: one row per QBO account that received
//                  transactions, with live YTD/month totals.
// Pairing is by normalized account NAME at display time (not account code).
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const periodId = body.period_id;
    if (!periodId) return Response.json({ error: 'period_id required' }, { status: 400 });

    const period = await base44.asServiceRole.entities.ReportingPeriod.get(periodId);
    if (!period) return Response.json({ error: 'Period not found' }, { status: 404 });

    // Every reporting period in this year, up to and including the selected month.
    const yearPeriods = await base44.asServiceRole.entities.ReportingPeriod.filter({ year: period.year }, 'month');
    const ytdPeriodIds = yearPeriods.filter((p) => p.month <= period.month).map((p) => p.id);

    const accounts = await base44.asServiceRole.entities.Account.filter({});
    const { byName } = buildIndexes(accounts);
    const qboIdSet = new Set(accounts.filter((a) => a.source === 'quickbooks').map((a) => a.id));

    // All YTD transactions (across every period Jan..current month).
    let ytdTxns = [];
    if (ytdPeriodIds.length) {
      const batches = await Promise.all(
        ytdPeriodIds.map((pid) => base44.asServiceRole.entities.Transaction.filter({ period_id: pid }, '-date', 5000))
      );
      ytdTxns = batches.flat();
    }

    // Monthly subset = transactions dated within the selected period's range.
    const start = period.start_date;
    const end = period.end_date;
    const monthTxns = ytdTxns.filter((t) => {
      const d = (t.date || '').slice(0, 10);
      return d && d >= start && d <= end;
    });

    const ytdTotals = rollUpByAccount(ytdTxns, qboIdSet);
    const monthTotals = rollUpByAccount(monthTxns, qboIdSet);

    const budgetLines = await base44.asServiceRole.entities.BudgetLine.filter({ period_id: periodId });

    // Spending Detail rows — one per BudgetLine (the Excel report of record).
    // The live column sums every QBO account whose name matches the line's
    // category or any name in its qb_account_names.
    const rows = budgetLines.map((l) => {
      const matching = accountsForNames(l.category, l.qb_account_names, byName);
      let liveYtd = 0;
      let liveMonth = 0;
      let hasLive = false;
      for (const a of matching) {
        const y = ytdTotals[a.id];
        const m = monthTotals[a.id];
        if (y) { liveYtd += y.actual; if (y.count) hasLive = true; }
        if (m) liveMonth += m.actual;
      }
      return {
        account_id: null,
        account_ids: matching.map((a) => a.id),
        category: l.category,
        budget_group: l.budget_group,
        qb_code: l.qb_code || '',
        qb_account_names: Array.isArray(l.qb_account_names) ? l.qb_account_names : [],
        annual_budget: Number(l.annual_budget || 0),
        pace_method: l.pace_method || 'even',
        expected_ytd_override: l.expected_ytd_override ?? null,
        drilldown_enabled: l.drilldown_enabled !== false,
        snapshot_month: Number(l.month_actual || 0),
        snapshot_ytd: Number(l.ytd_actual || 0),
        has_snapshot: true,
        live_ytd: liveYtd,
        live_month_value: liveMonth,
        has_live: hasLive,
      };
    });

    // Live QuickBooks rows — one per QBO account that received transactions.
    const liveAccounts = accounts
      .filter((a) => a.source === 'quickbooks' && (ytdTotals[a.id] || monthTotals[a.id]))
      .map((a) => ({
        account_id: a.id,
        account_name: a.account_name,
        qb_code: a.account_code || '',
        budget_group: a.top_level_group,
        full_account_path: a.full_account_path || '',
        account_type: a.account_type,
        live_ytd: ytdTotals[a.id]?.actual || 0,
        live_month_value: monthTotals[a.id]?.actual || 0,
        count: ytdTotals[a.id]?.count || 0,
      }))
      .sort((a, b) => b.live_ytd - a.live_ytd);

    // Warn when YTD is requested but no prior-month transactions exist.
    let notice = null;
    if (period.month > 1) {
      const priorTxns = ytdTxns.filter((t) => {
        const d = (t.date || '').slice(0, 10);
        return d && d < start;
      });
      if (priorTxns.length === 0) {
        notice = 'No transactions found for prior months this year — YTD figures may be incomplete. Run the QuickBooks sync to pull the full year-to-date.';
      }
    }

    return Response.json({
      period_id: periodId,
      period_label: period.label,
      rows,
      liveAccounts,
      notice,
      counts: { ytd_transactions: ytdTxns.length, month_transactions: monthTxns.length, qbo_accounts: qboIdSet.size },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}