import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// ---- Roll-up helpers (mirror src/lib/rollup.js; backend can't import src/) ----
function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

function resolveBudgetAccount(account, byId, seen = new Set()) {
  if (!account || seen.has(account.id)) return null;
  if (account.has_own_budget) return account;
  if (!account.budget_parent_id) return null;
  seen.add(account.id);
  return resolveBudgetAccount(byId[account.budget_parent_id], byId, seen);
}

// Normalize a name for matching Excel categories to QBO accounts:
// lowercase, strip everything but alphanumerics ("Beauty / Fitness" -> "beautyfitness").
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resolve a transaction to the account whose budget it should count toward:
// walk up the budget_parent_id chain to a budget account; if none, use the
// transaction's own account so unconfigured accounts still surface their spend.
function lineAccountFor(t, byId, byCode, byNormName) {
  let acc = t.account_id ? byId[t.account_id] : null;

  // Fallback for legacy/imported transactions that have no account_id: parse
  // the account code (or name) out of the colon-delimited full_account_path.
  if (!acc) {
    const path = t.full_account_path || '';
    const leaf = path.split(':').pop().trim();
    if (leaf) {
      const m = leaf.match(/^(\d+)/);
      if (m && byCode[m[1]]) acc = byCode[m[1]];
      else {
        const namePart = leaf.replace(/^\d+\s*[-:]?\s*/, '').trim();
        const cand = namePart ? byNormName[norm(namePart)] : null;
        if (cand) acc = cand;
      }
    }
    if (!acc && t.category) {
      const cand = byNormName[norm(t.category)];
      if (cand) acc = cand;
    }
  }
  if (!acc) return null;
  return resolveBudgetAccount(acc, byId) || acc;
}

function rollUp(txns, byId, byCode, byNormName) {
  const totals = {};
  for (const t of txns) {
    const acc = lineAccountFor(t, byId, byCode, byNormName);
    if (!acc) continue;
    if (!totals[acc.id]) totals[acc.id] = { actual: 0, count: 0 };
    totals[acc.id].actual += Number(t.amount || 0);
    totals[acc.id].count += 1;
  }
  return totals;
}

// Compute live monthly + YTD actuals per category, merged with the stored
// BudgetLine snapshots so Spending Detail can show both side by side.
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
    const byId = indexById(accounts);
    const byCode = {};
    for (const a of accounts) {
      if (a.account_code && !byCode[a.account_code]) byCode[a.account_code] = a;
    }
    // Normalized name -> account. Prefer budget accounts so name collisions
    // resolve to the account that actually carries a budget.
    const byNormName = {};
    for (const a of accounts) {
      if (!a.has_own_budget) continue;
      byNormName[norm(a.account_name)] = a;
    }
    for (const a of accounts) {
      const key = norm(a.account_name);
      if (!byNormName[key]) byNormName[key] = a;
    }

    // Load all YTD transactions (across every period Jan..current month).
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

    const ytdTotals = rollUp(ytdTxns, byId, byCode, byNormName);
    const monthTotals = rollUp(monthTxns, byId, byCode, byNormName);

    // Stored Excel/BudgetLine snapshots for the selected period.
    const budgetLines = await base44.asServiceRole.entities.BudgetLine.filter({ period_id: periodId });

    const rows = {};
    const makeRow = (acc) => ({
      account_id: acc.id,
      category: acc.account_name,
      budget_group: acc.top_level_group,
      qb_code: acc.account_code || '',
      annual_budget: Number(acc.annual_budget || 0),
      pace_method: 'even',
      expected_ytd_override: null,
      drilldown_enabled: true,
      snapshot_month: 0,
      snapshot_ytd: 0,
      has_snapshot: false,
      live_ytd: 0,
      live_month_value: 0,
      has_live: false,
    });

    // Rows for every account that received rolled-up transactions (budget parent
    // when configured, otherwise the account itself).
    for (const id of new Set([...Object.keys(ytdTotals), ...Object.keys(monthTotals)])) {
      const acc = byId[id];
      if (!acc) continue;
      const row = makeRow(acc);
      row.live_ytd = ytdTotals[id]?.actual || 0;
      row.live_month_value = monthTotals[id]?.actual || 0;
      row.has_live = (ytdTotals[id]?.count || 0) > 0;
      rows[id] = row;
    }

    // Merge BudgetLine snapshots into the account that carries that category's
    // live totals: match by normalized name, then resolve up the hierarchy (or
    // use the account itself when it isn't configured to roll up). When several
    // accounts share a name (duplicate accounts from mixed imports), prefer the
    // one that actually received rolled-up transactions so the snapshot pairs
    // with the live row.
    const matchedLineIds = new Set();
    const accountsByNorm = {};
    for (const a of accounts) {
      const k = norm(a.account_name);
      (accountsByNorm[k] = accountsByNorm[k] || []).push(a);
    }
    for (const l of budgetLines) {
      const key = norm(l.category);
      const cands = accountsByNorm[key];
      if (!cands || !cands.length) continue; // no account by that name -> snapshot-only row below
      const acc = cands.find((c) => rows[c.id] && rows[c.id].has_live) || cands.find((c) => c.has_own_budget) || cands[0];
      const target = resolveBudgetAccount(acc, byId) || acc;
      if (!rows[target.id]) rows[target.id] = makeRow(target);
      const row = rows[target.id];
      if (row.has_snapshot) continue; // one snapshot per category
      matchedLineIds.add(l.id);
      row.has_snapshot = true;
      row.snapshot_month = Number(l.month_actual || 0);
      row.snapshot_ytd = Number(l.ytd_actual || 0);
      row.annual_budget = Number(l.annual_budget || 0);
      row.pace_method = l.pace_method || 'even';
      row.expected_ytd_override = l.expected_ytd_override ?? null;
      row.drilldown_enabled = l.drilldown_enabled !== false;
      row.qb_code = l.qb_code || row.qb_code;
    }

    // Budget lines that don't map to any budget account — snapshot-only rows.
    const unmatchedRows = [];
    for (const l of budgetLines) {
      if (matchedLineIds.has(l.id)) continue;
      unmatchedRows.push({
        account_id: null,
        category: l.category,
        budget_group: l.budget_group,
        qb_code: l.qb_code || '',
        annual_budget: Number(l.annual_budget || 0),
        pace_method: l.pace_method || 'even',
        expected_ytd_override: l.expected_ytd_override ?? null,
        drilldown_enabled: l.drilldown_enabled !== false,
        snapshot_month: Number(l.month_actual || 0),
        snapshot_ytd: Number(l.ytd_actual || 0),
        has_snapshot: true,
        live_ytd: 0,
        live_month_value: 0,
        has_live: false,
      });
    }

    const allRows = [...Object.values(rows), ...unmatchedRows];

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
      rows: allRows,
      notice,
      counts: { ytd_transactions: ytdTxns.length, month_transactions: monthTxns.length, accounts: accounts.length },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}