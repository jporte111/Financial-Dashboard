// The single authoritative rule set for finalizing and publishing a reporting
// period. Pure functions: the periodTransition backend function enforces them
// (server-side, service role), and the admin screens use the same code only to
// explain what is blocking. Nothing here writes anything.
//
// States are kept separate:
//   draft      imported (bva_import_status 'draft'), editable, not visible to clients
//   final      validated and locked for publication (status 'final',
//              bva_import_status 'final', finalized_at set) -- still not published
//   published  final AND published: visible to clients, read-only
//
// Existing records are never re-judged by these rules. They apply only when a
// period moves to final or to published. A period that is already published
// stays published and readable; if it is reopened, it must pass these rules
// (including having a validated BVA import) before it can be published again.

import { effectiveRecord } from './sourceMissing.ts';
import { CROSS_PERIOD_PREFIX } from './crossPeriod.ts';
import { itemMessage } from './checklistCore.ts';
import { isHardValidation } from './hardRules.ts';

const MONTHS_IN_YEAR = 12;

// Period totals the workbook should carry. A missing one is shown as missing
// (never $0.00) and highlighted as a warning; only a missing reporting cutoff
// blocks (the report cannot be placed in a month without it).
export const REQUIRED_PERIOD_FIELDS = [
  'reporting_cutoff_date',
  'total_cash',
  'ytd_income',
  'ytd_expenses',
  'annual_budgeted_income',
  'annual_budgeted_expenses',
  'distributions_ytd',
];
// May legitimately be blank (the workbook's month column); stays missing,
// never converted to zero, and does not block.
export const OPTIONAL_PERIOD_FIELDS = ['month_income', 'month_expenses'];

export const EXPENSE_GROUPS = ['fixed', 'variable', 'discretionary'];

// The pre-publication review checklist (kept in sync with the admin panel).
export const PUBLISH_CHECKLIST = [
  ['categories_reviewed', 'Categories reviewed'],
  ['classes_reviewed', 'Classes reviewed'],
  ['refunds_reviewed', 'Refunds reviewed'],
  ['income_reviewed', 'Income reviewed'],
  ['cash_confirmed', 'Cash balances confirmed'],
  ['distributions_confirmed', 'Distribution totals confirmed'],
  ['budget_report_reviewed', 'Budget report reviewed'],
];

const isMissing = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));
const isNonZero = (v) => !isMissing(v) && Number(v) !== 0;

export function elapsedMonthsFromCutoff(cutoffDate) {
  if (!cutoffDate) return null;
  const d = new Date(cutoffDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.min(Math.max(d.getUTCMonth() + 1, 0), MONTHS_IN_YEAR);
}

// A usable override / exclusion needs a written reason.
export const hasReason = (o) => !!(o && typeof o.reason === 'string' && o.reason.trim().length > 0);

const blocker = (code, message, overridable = false) => ({ code, message, overridable });

// A monitored DETAIL row with no confirmed group that carries a non-zero
// figure: shown as "Unassigned" (never counted in a group) and highlighted.
export function isMaterialUnassignedDetail(line) {
  const unassigned = !line.group_confirmed || !line.budget_group || line.budget_group === 'unassigned';
  return !!line.bva_detail && unassigned && [line.ytd_actual, line.annual_budget, line.month_actual].some(isNonZero);
}

// Data rules shared by finalize and publish: ONLY structural / integrity
// failures block (see hardRules.ts). Everything else the workbook contains --
// blanks included -- is represented as it is and reported by dataWarnings().
// No blocker here can be overridden. `overrides` and `forPublish` are kept for
// callers; neither changes the result.
function dataBlockers(period, lines, _overrides = {}, _opts = {}) {
  const out = [];
  if (isMissing(period.reporting_cutoff_date)) {
    out.push(blocker('required_value_missing:reporting_cutoff_date', 'The reporting cutoff date is missing, so the report cannot be placed in a month.'));
  }
  const expected = elapsedMonthsFromCutoff(period.reporting_cutoff_date);
  if (period.reporting_cutoff_date && expected === null) {
    out.push(blocker('cutoff_invalid', 'The reporting cutoff date is not a valid date.'));
  } else if (expected !== null && Number(period.months_elapsed) !== expected) {
    out.push(blocker('pace_inconsistent', `Elapsed months (${period.months_elapsed ?? 'missing'}) do not match the cutoff date (${expected}).`));
  }
  // A period reports either its own month's data or the previous month's
  // (the workbook is titled by report month); any other gap is an error.
  if (expected !== null && period.month && period.year) {
    const d = new Date(period.reporting_cutoff_date);
    const offset = (Number(period.year) * 12 + Number(period.month) - 1) - (d.getUTCFullYear() * 12 + d.getUTCMonth());
    if (offset !== 0 && offset !== 1) {
      out.push(blocker('cutoff_period_mismatch', 'The reporting cutoff date is neither in this reporting month nor the month before it.'));
    }
  }
  // The import must hold the income lines and all three expense groups.
  const summaries = lines.filter((l) => !l.bva_detail);
  const missingGroups = EXPENSE_GROUPS.filter((g) => !summaries.some((l) => l.budget_group === g));
  if (missingGroups.length || !summaries.some((l) => l.budget_group === 'income')) {
    out.push(blocker('import_incomplete', `Imported budget lines are incomplete (missing: ${[...missingGroups, ...(summaries.some((l) => l.budget_group === 'income') ? [] : ['income'])].join(', ')}).`));
  }
  // Structural findings from the workbook itself (judged by code, so an
  // import stored under older rules is judged by these rules).
  for (const w of Array.isArray(period.bva_validation_warnings) ? period.bva_validation_warnings : []) {
    if (w && isHardValidation(String(w.code))) {
      out.push(blocker(`open_reconciliation:${w.code}`, w.message || `The workbook could not be read reliably (${w.code}).`));
    }
  }
  return out;
}

// What the review highlights about the data itself (never blocks): missing
// totals and line figures (shown as missing, never $0.00), and watch-list rows
// with figures but no group (shown as Unassigned).
export function dataWarnings(rawPeriod, lines = []) {
  const period = effectiveRecord(rawPeriod) || {};
  const out = [];
  for (const f of REQUIRED_PERIOD_FIELDS) {
    if (f !== 'reporting_cutoff_date' && isMissing(period[f])) out.push({ code: `required_value_missing:${f}`, message: `"${f}" is blank in the workbook; it is shown as missing (never $0.00).` });
  }
  for (const l of lines) {
    const missing = ['ytd_actual', 'annual_budget'].filter((f) => isMissing(l[f]));
    if (l.bva_detail && missing.length !== 1) continue;
    for (const f of missing) out.push({ code: `required_line_value_missing:${l.id}:${f}`, message: `"${l.category}" has a blank ${f}; it is shown as missing (never $0.00).` });
  }
  for (const l of lines.filter(isMaterialUnassignedDetail)) {
    out.push({ code: `detail_unassigned:${l.id}`, message: `"${l.category}" has figures but no confirmed group; it is shown as Unassigned and is not counted in any group.` });
  }
  return out;
}

// Cross-period findings (crossPeriod.ts) as blockers: only 'block' (a
// conflicting or duplicate period/version, or checks that could not run)
// blocks; 'warn' and 'info' are for review. Codes are prefixed cross_period:.
// `findings` is null when the caller did not evaluate them.
export function crossPeriodBlockers(findings, _overrides = {}) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (f.severity === 'block') out.push(blocker(`${CROSS_PERIOD_PREFIX}${f.code}`, f.message, false));
  }
  return out;
}

// A period must carry its protected state (written by the server on create).
// A record missing it -- e.g. an interrupted creation -- can never be
// finalized or published.
// (bva_import_status is checked separately: legacy periods legitimately lack it
// and are reported as having no validated import.)
export const hasInitializedState = (p) =>
  !!p && typeof p.status === 'string' && p.status !== '' && typeof p.published === 'boolean';

export function evaluateFinalize(rawPeriod, lines = [], overrides = {}, crossFindings = null) {
  // Fields listed as missing are missing, whatever number is stored.
  const period = effectiveRecord(rawPeriod);
  if (!period) return { ok: false, blockers: [blocker('period_not_found', 'Reporting period not found.')] };
  if (!hasInitializedState(period)) return { ok: false, blockers: [blocker('state_uninitialized', 'This period was not initialized by the server; it cannot be finalized. Re-create it through the import.')] };
  const out = [];
  if (period.published) out.push(blocker('published_read_only', 'This period is published and read-only.'));
  else if (period.bva_import_status === 'final' || period.status === 'final') out.push(blocker('already_final', 'This period is already final.'));
  else if (period.bva_import_status !== 'draft' || !period.bva_parsed_source) {
    out.push(blocker('no_validated_import', 'This period has no validated BVA import. Import the workbook before finalizing.'));
  }
  out.push(...dataBlockers(period, lines, overrides));
  out.push(...crossPeriodBlockers(crossFindings, overrides));
  return { ok: out.length === 0, blockers: out };
}

// checklistItems: checklistCore.checklistStatus() for this period. When given,
// each item must be CONFIRMED (recorded by the server) and not stale; when
// null (browser explanations, older tests) the stored true/false is used.
export function evaluatePublish(rawPeriod, lines = [], crossFindings = null, checklistItems = null) {
  const period = effectiveRecord(rawPeriod);
  if (!period) return { ok: false, blockers: [blocker('period_not_found', 'Reporting period not found.')] };
  if (!hasInitializedState(period)) return { ok: false, blockers: [blocker('state_uninitialized', 'This period was not initialized by the server; it cannot be published.')] };
  const out = [];
  if (period.published) out.push(blocker('already_published', 'This period is already published.'));
  if (period.status !== 'final' || period.bva_import_status !== 'final' || !period.finalized_at) {
    out.push(blocker('not_final', 'Only a finalized period (validated BVA import) can be published.'));
  }
  out.push(...dataBlockers(period, lines, period.bva_overrides || {}, { forPublish: true }));
  out.push(...crossPeriodBlockers(crossFindings));
  if (Array.isArray(checklistItems)) {
    for (const s of checklistItems) if (s.state !== 'confirmed') out.push(blocker(`checklist_incomplete:${s.key}`, itemMessage(s)));
  } else {
    const checklist = period.checklist || {};
    for (const [k, label] of PUBLISH_CHECKLIST) {
      if (!checklist[k]) out.push(blocker(`checklist_incomplete:${k}`, `Checklist item not confirmed: ${label}.`));
    }
  }
  return { ok: out.length === 0, blockers: out };
}

// The overrides that finalize records. No finding needs a written reason any
// more, so nothing new is recorded; reasons recorded under the earlier rules
// are kept as they were.
export function recordedOverrides(period, _lines = [], _overrides = {}, _by = '', _at = '', _crossFindings = null) {
  return { ...(period?.bva_overrides || {}) };
}
