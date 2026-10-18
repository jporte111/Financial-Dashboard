// Pure planning layer for the monthly BVA import.
//
// Given a parsed + independently validated workbook and the user-confirmed
// reporting month / year / cutoff date, this produces the exact set of entity
// writes to apply. It never talks to the database, and it only ever references
// the target reporting period — re-importing a month updates that one period
// in place (no duplicate), and every other period, finalized or not, is left
// untouched.

import { round2, n, elapsedMonthsFromCutoff } from './bva.js';
import { monthState, isDiscarded, isSuperseded, isRevision, versionLabel } from '../../base44/shared/periodVersions.ts';
import { withoutNulls, nextMissingList, MISSING_MARKER } from '../../base44/shared/sourceMissing.ts';
import { detailGroupKey } from './bvaCorrections.js';

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
// Keeps a missing value missing: null stays null (it is left out of the write).
const r2 = (v) => (v == null ? null : round2(v));

// Record fields Base44 manages; never copied from an old row into a new one.
// copied_from is set only by the server (draft revisions) and refused on direct writes.
const SYSTEM_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id', 'is_sample', 'app_id', 'period_id', 'copied_from']);
const hasValue = (v) => v !== null && v !== undefined && v !== '';

// Reconcile a desired child-entity list against what already exists for the
// period. `keyOf` yields a stable natural key. Returns create / update / delete
// buckets; delete ids are always rows that belong to THIS period only.
//
// Every payload is null-free (Base44 rejects null). A missing value is left
// out -- but leaving a field out of an update keeps its old value, so when a
// re-import turns a stored value into a missing one the row is REPLACED
// (deleted and re-created) instead; fields the import does not own (admin
// notes, overrides, ...) are carried over to the new row.
function reconcileChildren(existing, desired, keyOf) {
  const byKey = new Map();
  for (const row of existing || []) byKey.set(keyOf(row), row);
  const toCreate = [];
  const toUpdate = [];
  const replaced = [];
  const seen = new Set();
  for (const d of desired) {
    const k = keyOf(d);
    seen.add(k);
    const match = byKey.get(k);
    const data = withoutNulls(d);
    if (!match) {
      toCreate.push(data);
      continue;
    }
    const cleared = Object.keys(d).filter((f) => d[f] == null && hasValue(match[f]));
    if (!cleared.length) {
      toUpdate.push({ id: match.id, data });
      continue;
    }
    const carried = Object.fromEntries(Object.entries(match).filter(([f, v]) => !SYSTEM_FIELDS.has(f) && !(f in d) && hasValue(v)));
    toCreate.push({ ...carried, ...data });
    replaced.push({ id: match.id, cleared });
  }
  const toDelete = [
    ...(existing || []).filter((row) => !seen.has(keyOf(row))).map((row) => row.id),
    ...replaced.map((x) => x.id),
  ];
  return { toCreate, toUpdate, toDelete, replaced };
}

// Numeric period fields the import writes. A missing one is listed in the
// period's source_missing_fields (see base44/shared/sourceMissing.ts).
export const IMPORT_NUMERIC_FIELDS = [
  'total_cash', 'ytd_income', 'ytd_expenses', 'month_income', 'month_expenses', 'annual_budgeted_income',
  'annual_budgeted_income_workbook', 'annual_budgeted_expenses', 'distributions_ytd', 'months_elapsed',
];
const IMPORT_TEXT_FIELDS = ['reporting_cutoff_date', 'source_filename', 'imported_by'];

// Stable key for a budget line: detail rows by account code, the three
// expense-group summaries by group (so "FIXED" and "FIXED COSTS" are the same
// line), income lines by code or name.
const lineKey = (l) =>
  l.bva_detail
    ? `d:${normKey(l.qb_code || l.category)}`
    : ['fixed', 'variable', 'discretionary'].includes(l.budget_group)
      ? `s:group:${l.budget_group}`
      : `s:${normKey(l.qb_code || l.category)}`;

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
  // Pace comes only from the confirmed cutoff date; without one it is missing
  // (never guessed from the reporting month).
  const elapsedMonths = cutoffDate ? elapsedMonthsFromCutoff(cutoffDate) : null;

  // What the dashboard shows: the workbook's printed totals when it has them
  // (the calculated totals stay in the validation warnings for checking).
  // Older validation results (no display block) keep the calculated totals.
  const D = R.display || {};
  const shown = (field, calculated) => (field in D ? D[field] : r2(calculated));
  const incomeBudgetWorkbook = r2(parsed?.income?.reportedBudgetTotal);

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
    // scalars (null = missing in the workbook; never 0)
    total_cash: shown('total_cash', R.cash.total),
    ytd_income: shown('ytd_income', R.income.actualTotal),
    ytd_expenses: shown('ytd_expenses', R.expenses.actualTotal),
    // Current-month totals are written as null when the workbook's month
    // column was blank — the dashboard then shows "Source value missing"
    // rather than a fabricated $0.00. A present-but-zero column stores 0.
    month_income: r2(R.income.monthActualTotal),
    month_expenses: r2(R.expenses.monthActualTotal),
    annual_budgeted_income: shown('annual_budgeted_income', R.income.budgetTotal),
    annual_budgeted_income_workbook: incomeBudgetWorkbook,
    annual_budgeted_expenses: shown('annual_budgeted_expenses', R.expenses.budgetTotal),
    distributions_ytd: shown('distributions_ytd', R.distributions.entitySum),
    // The workbook's printed quarter column totals (only those it prints);
    // always written, so a re-import replaces the previous set.
    distribution_quarter_totals: D.distribution_quarter_totals || {},
    // This import follows the printed-total rule: the dashboard shows the
    // workbook's printed totals for it (earlier periods are shown as stored).
    printed_totals: 'display' in R,
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
      ytd_actual: r2(g.actual),
      annual_budget: r2(g.annual),
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
      ytd_actual: r2(c.actualYtd),
      annual_budget: r2(c.annualBudget),
      pace_method: 'even',
      drilldown_enabled: true,
    });
  }
  for (const d of R.detail.categories) {
    // Never guess a group. Re-use a prior CONFIRMED mapping keyed by the
    // normalized account number (or, for a row without a code, its exact
    // name: detailGroupKey); otherwise the row is 'unassigned' and stays
    // unconfirmed until an admin sets it. There is no discretionary fallback.
    const key = detailGroupKey(d.code, d.name);
    const mapped = key ? groupMap[key] || null : null;
    desiredLines.push({
      category: d.name,
      qb_code: d.code || '',
      budget_group: mapped || 'unassigned',
      bva_detail: true,
      group_confirmed: !!mapped,
      month_actual: d.monthActual == null ? null : round2(n(d.monthActual)),
      ytd_actual: r2(d.actual),
      annual_budget: r2(d.annual),
      pace_method: 'even',
      drilldown_enabled: true,
    });
  }

  const budgetLines = reconcileChildren(existing.budgetLines, desiredLines, lineKey);

  // --- Cash accounts ------------------------------------------------
  const cashAccounts = reconcileChildren(
    existing.cashAccounts,
    R.cash.accounts.map((a, i) => ({
      name: a.name,
      balance: r2(a.balance),
      as_of_date: cutoffDate,
      sort_order: i + 1,
      account_type: /trade|schwab|merrill|brokerage|invest/i.test(a.name) ? 'investment' : 'bank',
    })),
    (a) => normKey(a.name)
  );

  // --- Distributions (entities with quarters, and the YTD the workbook
  // prints for each; without one the dashboard sums the quarters) --------
  const distributions = reconcileChildren(
    existing.distributions,
    R.distributions.entities.map((e) => ({
      entity_name: e.name,
      q1: r2(e.q1),
      q2: r2(e.q2),
      q3: r2(e.q3),
      q4: r2(e.q4),
      workbook_ytd: r2(e.reportedYtd),
    })),
    (e) => normKey(e.entity_name)
  );

  // --- Recurring transfers ---------------------------------------
  const transfers = reconcileChildren(
    existing.transfers,
    R.transfers.items.map((t) => ({
      amount: r2(t.amount),
      source: t.source || null,
      purpose: t.purpose || null,
      destination: t.destination || null,
      visible_to_client: true,
    })),
    (t) => `${t.amount == null ? 'missing' : round2(t.amount)}:${normKey(t.purpose || t.source)}`
  );

  // The period write: null-free, with the missing numeric fields listed by
  // name. Text fields the import owns are cleared with '' (Base44 accepts it).
  const periodWrite = {
    ...withoutNulls(periodData),
    ...Object.fromEntries(IMPORT_TEXT_FIELDS.map((f) => [f, periodData[f] == null ? '' : periodData[f]])),
    [MISSING_MARKER]: nextMissingList(match, IMPORT_NUMERIC_FIELDS, periodData),
  };

  return {
    action,
    periodId: match ? match.id : null,
    periodData,
    periodWrite,
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
  if (match.superseded || match.revision_status === 'discarded') {
    return { allowed: false, action: 'refuse', reason: `${match.label || 'This version'} was replaced by a newer version and is kept read-only.` };
  }
  if (match.published) {
    return {
      allowed: false,
      action: 'refuse',
      reason: `${match.label || 'This month'} is published. To correct it, upload the updated BVA workbook on the Import tab.`,
    };
  }
  return { allowed: true, action: 'update', needsInvalidate: true };
}

// Derive a prior category-number -> group map from existing BudgetLine rows so
// re-imports and new months keep human-confirmed detail groupings.
// Confirmed watch-list groups carried forward from the previous month's report:
// only for rows whose account code AND category name are unchanged (a row
// without a code: the same exact name, also without a code), and only
// confirmed groups (Fixed / Variable / Discretionary / Savings). A new or
// renamed row is not carried -- it stays unassigned until an admin sets it.
const CARRY_GROUPS = ['fixed', 'variable', 'discretionary', 'savings'];
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function carriedGroupMap(previousLines, detailRows) {
  const prev = new Map();
  for (const l of previousLines || []) {
    const key = l.bva_detail ? detailGroupKey(l.qb_code, l.category) : '';
    if (key && l.group_confirmed && CARRY_GROUPS.includes(l.budget_group)) prev.set(key, l);
  }
  const out = {};
  for (const d of detailRows || []) {
    const key = detailGroupKey(d.code, d.name);
    const p = key ? prev.get(key) : null;
    if (p && normName(p.category) === normName(d.name)) out[key] = p.budget_group;
  }
  return out;
}

export function groupMapFromLines(lines) {
  const map = {};
  for (const l of lines || []) {
    if (!l.group_confirmed) continue;
    const key = l.bva_detail ? detailGroupKey(l.qb_code, l.category) : normKey(l.qb_code || '');
    if (key && ['fixed', 'variable', 'discretionary'].includes(l.budget_group)) map[key] = l.budget_group;
  }
  return map;
}

// Which period an import for (month, year) writes into (draft revisions).
// A month can have several versions; an import never writes into a published,
// superseded or discarded version, nor into a revision whose initial copy is
// not verified. While a month has an open revision, the import goes into that
// revision -- never into the version it was copied from. `chosenId` is the
// version the admin picked (e.g. "September 2026 · revision 2 (draft)").
// Returns { allowed, action: 'create' | 'update', target, needsInvalidate,
// candidates, reason }.
// What uploading a workbook for this month will do, in plain terms (the
// updated-BVA workflow). The server decides again at import time
// (periodTransition 'prepare_import'); this only drives what the screen shows.
//   create    no report for the month yet
//   update    an unpublished draft / final report is updated in place
//   correct   the month is published: the upload becomes a corrected version
//             (clients keep the current one until the correction is published)
//   continue  a correction is already in progress: the upload updates it
//   blocked   an exceptional state (History & recovery)
export function importIntent(periods, month, year) {
  const versions = (periods || []).filter((p) => Number(p.month) === Number(month) && Number(p.year) === Number(year) && !isDiscarded(p));
  if (!versions.length) return { mode: 'create', current: null, target: null };
  const state = monthState(versions);
  const label = versions[0].label || 'This month';
  const blocked = (reason) => ({ mode: 'blocked', current: state.current || null, target: null, reason: `${reason} Open Review & Publish → History & recovery.` });
  if (state.conflict) return blocked(`${label} has more than one published version.`);
  if (state.pendingCleanup.length) return blocked(`An earlier replacement of ${label} did not finish.`);
  // A correction not yet published (open, or final and waiting to be
  // published) is updated in place; there is never a second one.
  if (state.unpublishedRevisions.length > 1) return blocked(`${label} has ${state.unpublishedRevisions.length} corrections in progress.`);
  if (state.unpublishedRevisions.length === 1) return { mode: 'continue', current: state.current || null, target: state.unpublishedRevisions[0] };
  if (state.current) return { mode: 'correct', current: state.current, target: null };
  return { mode: 'update', current: null, target: state.working || null };
}

export function importTarget(periods, month, year, chosenId = null) {
  const versions = (periods || []).filter((p) => Number(p.month) === Number(month) && Number(p.year) === Number(year) && !isDiscarded(p));
  if (!versions.length) return { allowed: true, action: 'create', target: null, needsInvalidate: false, candidates: [] };
  const state = monthState(versions);
  const open = state.unpublishedRevisions; // open or final-not-yet-published corrections
  const label = versions[0].label || 'This month';
  const refuse = (reason) => ({ allowed: false, action: 'refuse', target: null, needsInvalidate: false, candidates: open, reason });
  const usable = (p) => !p.published && !isSuperseded(p) && (!isRevision(p) || p.copy_status === 'verified');
  let target = null;
  if (chosenId) {
    target = versions.find((p) => p.id === chosenId) || null;
    if (!target) return refuse('The chosen version does not belong to this month.');
    if (open.length && !open.some((p) => p.id === target.id)) return refuse(`${label} has an open revision; import into the revision, not the version it was copied from.`);
  } else if (open.length > 1) {
    return refuse(`${label} has ${open.length} open revisions; choose one (or discard the extra one).`);
  } else if (open.length === 1) {
    target = open[0];
  } else if (state.current) {
    return refuse(`${label} is published. To correct it, upload the updated BVA workbook on the Import tab.`);
  } else {
    target = state.working;
  }
  if (!target) return refuse(`${label} has no version an import can update.`);
  if (isRevision(target) && target.copy_status !== 'verified') return refuse(`${versionLabel(target)} is still being copied; finish the copy first.`);
  if (!usable(target)) return refuse(`${versionLabel(target)} cannot be imported into: it is ${target.published ? 'published' : 'superseded'}.`);
  const pre = importPreflight(target);
  if (!pre.allowed) return refuse(pre.reason);
  return { allowed: true, action: 'update', target, needsInvalidate: pre.needsInvalidate, candidates: open.length ? open : [target], reason: null };
}