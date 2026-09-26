// Pure planning layer for the monthly BVA import.
//
// Given a parsed + independently validated workbook and the user-confirmed
// reporting month / year / cutoff date, this produces the exact set of entity
// writes to apply. It never talks to the database, and it only ever references
// the target reporting period — re-importing a month updates that one period
// in place (no duplicate), and every other period, finalized or not, is left
// untouched.

import { round2, n, elapsedMonthsFromCutoff } from './bva.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (x) => String(x).padStart(2, '0');
const monthBounds = (year, month) => {
  const start = `${year}-${pad(month)}-01`;
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}` };
};

const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Reconcile a desired child-entity list against what already exists for the
// period. `keyOf` yields a stable natural key. Returns create / update / delete
// buckets; delete ids are always rows that belong to THIS period only.
function reconcileChildren(existing, desired, keyOf) {
  const byKey = new Map();
  for (const row of existing || []) byKey.set(keyOf(row), row);
  const toCreate = [];
  const toUpdate = [];
  const seen = new Set();
  for (const d of desired) {
    const k = keyOf(d);
    seen.add(k);
    const match = byKey.get(k);
    if (match) toUpdate.push({ id: match.id, data: d });
    else toCreate.push(d);
  }
  const toDelete = (existing || []).filter((row) => !seen.has(keyOf(row))).map((row) => row.id);
  return { toCreate, toUpdate, toDelete };
}

/**
 * @param {object} args
 *   parsed          parseBvaWorkbook() output
 *   validation      validateBva() output
 *   confirm         { month, year, cutoffDate, filename, importedBy }
 *   existingPeriods ReportingPeriod[] (all of them)
 *   existing        { budgetLines, cashAccounts, distributions, transfers } for the matched period (or empty)
 *   groupMap        optional { [normalizedAccountNumber]: 'fixed'|'variable'|'discretionary' } to preserve prior detail-group mappings
 */
export function planBvaImport(args) {
  const { parsed, validation, confirm, existingPeriods = [], existing = {}, groupMap = {} } = args;
  const month = Number(confirm.month);
  const year = Number(confirm.year);
  const cutoffDate = confirm.cutoffDate || parsed?.meta?.cutoffDate || null;
  const R = validation.reconciled;

  // --- Match (or plan to create) the ONE target period ------------------
  const match = existingPeriods.find((p) => Number(p.month) === month && Number(p.year) === year) || null;
  const action = match ? 'update' : 'create';
  const { start, end } = monthBounds(year, month);
  const elapsedMonths = elapsedMonthsFromCutoff(cutoffDate) || month;

  const incomeBudgetCalc = round2(R.income.budgetTotal);
  const incomeBudgetWorkbook =
    parsed?.income?.reportedBudgetTotal != null ? round2(parsed.income.reportedBudgetTotal) : null;

  const periodData = {
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    month,
    year,
    start_date: start,
    end_date: end,
    reporting_cutoff_date: cutoffDate,
    months_elapsed: elapsedMonths,
    source_filename: confirm.filename || parsed?.meta?.titleText || null,
    imported_at: new Date().toISOString(),
    imported_by: confirm.importedBy || null,
    // scalars
    total_cash: round2(R.cash.total),
    ytd_income: round2(R.income.actualTotal),
    ytd_expenses: round2(R.expenses.actualTotal),
    // Current-month totals are written as null when the workbook's month
    // column was blank — the dashboard then shows "Source value missing"
    // rather than a fabricated $0.00. A present-but-zero column stores 0.
    month_income: R.income.monthActualTotal == null ? null : round2(R.income.monthActualTotal),
    month_expenses: R.expenses.monthActualTotal == null ? null : round2(R.expenses.monthActualTotal),
    annual_budgeted_income: incomeBudgetCalc,
    annual_budgeted_income_workbook: incomeBudgetWorkbook,
    annual_budgeted_expenses: round2(R.expenses.budgetTotal),
    // Distributions YTD is the sum of each entity's own quarters — always
    // authoritative. The workbook's displayed grand total is a manually-typed
    // cell range that has been wrong before; it is retained only inside
    // bva_parsed_source (below) for BVA Review's audit trail, never stored
    // here as the dashboard figure.
    distributions_ytd: round2(R.distributions.entitySum),
    bva_validation_warnings: validation.warnings,
    bva_parsed_source: parsed,
    // No state fields (status / published / bva_import_status / finalized_*):
    // those are written only by the periodTransition function. A new period
    // takes the schema defaults (draft, unpublished); an existing unpublished
    // period is reset to draft by periodTransition 'invalidate' BEFORE any
    // import write (see importPreflight).
  };

  // --- Budget lines: 3 group summaries + N monitored detail rows -------
  const desiredLines = [];
  for (const g of R.expenses.groups) {
    desiredLines.push({
      category: g.name || g.key,
      budget_group: g.key,
      bva_detail: false,
      group_confirmed: true,
      month_actual: g.monthActual == null ? null : round2(n(g.monthActual)),
      ytd_actual: round2(g.actual),
      annual_budget: round2(g.annual),
      pace_method: 'even',
      drilldown_enabled: true,
    });
  }
  for (const c of R.income.categories) {
    desiredLines.push({
      category: c.name,
      qb_code: c.code || '',
      budget_group: 'income',
      bva_detail: false,
      group_confirmed: true,
      month_actual: c.monthActual == null ? null : round2(n(c.monthActual)),
      ytd_actual: round2(c.actualYtd),
      annual_budget: round2(c.annualBudget),
      pace_method: 'even',
      drilldown_enabled: true,
    });
  }
  for (const d of R.detail.categories) {
    // Never guess a group. Re-use a prior CONFIRMED mapping keyed by the
    // normalized account number; otherwise the row is 'unassigned' and stays
    // unconfirmed until an admin sets it. There is no discretionary fallback.
    const mapped = d.code ? groupMap[normKey(d.code)] : null;
    desiredLines.push({
      category: d.name,
      qb_code: d.code || '',
      budget_group: mapped || 'unassigned',
      bva_detail: true,
      group_confirmed: !!mapped,
      month_actual: d.monthActual == null ? null : round2(n(d.monthActual)),
      ytd_actual: round2(d.actual),
      annual_budget: round2(d.annual),
      pace_method: 'even',
      drilldown_enabled: true,
    });
  }

  const budgetLines = reconcileChildren(
    existing.budgetLines,
    desiredLines,
    (l) => `${l.bva_detail ? 'd' : 's'}:${normKey(l.qb_code || l.category)}`
  );

  // --- Cash accounts ------------------------------------------------
  const cashAccounts = reconcileChildren(
    existing.cashAccounts,
    R.cash.accounts.map((a, i) => ({
      name: a.name,
      balance: round2(a.balance),
      as_of_date: cutoffDate,
      sort_order: i + 1,
      account_type: /trade|schwab|merrill|brokerage|invest/i.test(a.name) ? 'investment' : 'bank',
    })),
    (a) => normKey(a.name)
  );

  // --- Distributions (entities with quarters; YTD recomputed at read) --
  const distributions = reconcileChildren(
    existing.distributions,
    R.distributions.entities.map((e) => ({
      entity_name: e.name,
      q1: round2(e.q1),
      q2: round2(e.q2),
      q3: round2(e.q3),
      q4: round2(e.q4),
    })),
    (e) => normKey(e.entity_name)
  );

  // --- Recurring transfers ---------------------------------------
  const transfers = reconcileChildren(
    existing.transfers,
    R.transfers.items.map((t) => ({
      amount: round2(t.amount),
      source: t.source || null,
      purpose: t.purpose || null,
      visible_to_client: true,
    })),
    (t) => `${round2(t.amount)}:${normKey(t.purpose || t.source)}`
  );

  return {
    action,
    periodId: match ? match.id : null,
    periodData,
    budgetLines,
    cashAccounts,
    distributions,
    transfers,
    warnings: validation.warnings,
    blocksFinalize: validation.blocksFinalize,
    openReconciliations: validation.openReconciliations,
  };
}

// Decide, before any write, whether an import may touch the matched period.
// Published months are refused until draft revisions exist; an existing
// unpublished month must first be reset to draft by periodTransition
// 'invalidate', so stale "final" state can never cover re-imported figures.
export function importPreflight(match) {
  if (!match) return { allowed: true, action: 'create', needsInvalidate: false };
  if (match.published) {
    return {
      allowed: false,
      action: 'refuse',
      reason: `${match.label || 'This month'} is published. Re-importing a published month is refused until draft revisions are available.`,
    };
  }
  return { allowed: true, action: 'update', needsInvalidate: true };
}

// Derive a prior category-number -> group map from existing BudgetLine rows so
// re-imports and new months keep human-confirmed detail groupings.
export function groupMapFromLines(lines) {
  const map = {};
  for (const l of lines || []) {
    if (!l.group_confirmed) continue;
    const key = normKey(l.qb_code || '');
    if (key && ['fixed', 'variable', 'discretionary'].includes(l.budget_group)) map[key] = l.budget_group;
  }
  return map;
}
