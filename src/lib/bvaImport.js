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
    month_income: round2(R.income.categories.reduce((s, c) => s + n(c.monthActual), 0)),
    month_expenses: round2(R.expenses.groups.reduce((s, g) => s + n(g.monthActual), 0)),
    annual_budgeted_income: incomeBudgetCalc,
    annual_budgeted_income_workbook: incomeBudgetWorkbook,
    annual_budgeted_expenses: round2(R.expenses.budgetTotal),
    // Distributions YTD is the business-reported total, preserved as-is.
    distributions_ytd: R.distributions.reportedTotal != null ? round2(R.distributions.reportedTotal) : null,
    bva_validation_warnings: validation.warnings,
    bva_parsed_source: parsed,
    bva_import_status: 'draft',
  };
  // On create only, seed the review-workflow status; never downgrade an
  // existing period's status on re-import.
  if (action === 'create') {
    periodData.status = 'draft';
    periodData.published = false;
  }

  // --- Budget lines: 3 group summaries + N monitored detail rows -------
  const desiredLines = [];
  for (const g of R.expenses.groups) {
    desiredLines.push({
      category: g.name || g.key,
      budget_group: g.key,
      bva_detail: false,
      group_confirmed: true,
      month_actual: round2(n(g.monthActual)),
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
      month_actual: round2(n(c.monthActual)),
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
      month_actual: round2(n(d.monthActual)),
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

/**
 * Build the payload that marks a period Final. Throws when a required
 * reconciliation is still failing and has not been explicitly overridden.
 */
export function planFinalize({ period, validation, overrides = {}, finalizedBy }) {
  const stillOpen = (validation.openReconciliations || []).filter((code) => !overrides[code]);
  if (stillOpen.length) {
    throw new Error(
      `Cannot finalize: ${stillOpen.length} reconciliation(s) still open without an override — ${stillOpen.join(', ')}`
    );
  }
  const mergedWarnings = (validation.warnings || []).map((w) =>
    overrides[w.code] ? { ...w, overridden: true, override: overrides[w.code], blocksFinalize: false } : w
  );
  return {
    id: period.id,
    data: {
      bva_import_status: 'final',
      status: 'final',
      published: true,
      finalized_at: new Date().toISOString(),
      finalized_by: finalizedBy || null,
      publication_date: new Date().toISOString().slice(0, 10),
      bva_overrides: overrides,
      bva_validation_warnings: mergedWarnings,
      last_updated: new Date().toISOString().slice(0, 10),
    },
  };
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
