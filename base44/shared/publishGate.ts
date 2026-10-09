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

const MONTHS_IN_YEAR = 12;

// Period totals that must come from the workbook. A missing value blocks.
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

// A monitored DETAIL row with no confirmed group affects reporting when it
// carries any non-zero figure. Such rows block until classified or explicitly
// excluded with a reason; all-blank / all-zero rows do not.
export function isMaterialUnassignedDetail(line) {
  const unassigned = !line.group_confirmed || !line.budget_group || line.budget_group === 'unassigned';
  return !!line.bva_detail && unassigned && [line.ytd_actual, line.annual_budget, line.month_actual].some(isNonZero);
}

// Data rules shared by finalize and publish.
function dataBlockers(period, lines, overrides) {
  const out = [];
  for (const f of REQUIRED_PERIOD_FIELDS) {
    if (isMissing(period[f])) out.push(blocker(`required_value_missing:${f}`, `Required value "${f}" is missing from the import.`));
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

  const summaries = lines.filter((l) => !l.bva_detail);
  const missingGroups = EXPENSE_GROUPS.filter((g) => !summaries.some((l) => l.budget_group === g));
  if (missingGroups.length || !summaries.some((l) => l.budget_group === 'income')) {
    out.push(blocker('import_incomplete', `Imported budget lines are incomplete (missing: ${[...missingGroups, ...(summaries.some((l) => l.budget_group === 'income') ? [] : ['income'])].join(', ')}).`));
  }
  // Primary figures: a blank is missing, never $0.00, and cannot be
  // overridden. Summary lines need both. A watch-list DETAIL row with no
  // figures at all is not material; one with only one of the two is missing
  // the other.
  for (const l of lines) {
    const missing = ['ytd_actual', 'annual_budget'].filter((f) => isMissing(l[f]));
    if (l.bva_detail && missing.length !== 1) continue;
    for (const f of missing) out.push(blocker(`required_line_value_missing:${l.id}:${f}`, `"${l.category}" is missing ${f}.`));
  }

  for (const w of Array.isArray(period.bva_validation_warnings) ? period.bva_validation_warnings : []) {
    if (!w || !w.blocksFinalize) continue;
    const code = `open_reconciliation:${w.code}`;
    // A warning marked not overridable (a missing value, a conflicting
    // section, a wrong reporting month) must be fixed in the workbook.
    if (w.overridable === false) {
      out.push(blocker(code, w.message || `Validation ${w.code} must be corrected in the workbook.`, false));
      continue;
    }
    if (w.overridden) continue;
    if (!hasReason(overrides[code]) && !hasReason(overrides[w.code])) {
      out.push(blocker(code, w.message || `Reconciliation ${w.code} is open.`, true));
    }
  }

  for (const l of lines.filter(isMaterialUnassignedDetail)) {
    const code = `detail_unassigned:${l.id}`;
    if (!hasReason(overrides[code])) {
      out.push(blocker(code, `"${l.category}" has figures but no confirmed group. Classify it, or exclude it with a documented reason.`, true));
    }
  }
  return out;
}

// Cross-period findings (crossPeriod.ts) as blockers: 'block' cannot be
// overridden; 'override' blocks until accepted with a written reason (codes
// prefixed cross_period:); 'warn' and 'info' never block. `findings` is null
// when the caller did not evaluate them (browser explanations, older tests).
export function crossPeriodBlockers(findings, overrides = {}) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const code = `${CROSS_PERIOD_PREFIX}${f.code}`;
    if (f.severity === 'block') out.push(blocker(code, f.message, false));
    else if (f.severity === 'override' && !hasReason(overrides[code])) out.push(blocker(code, f.message, true));
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

export function evaluatePublish(rawPeriod, lines = [], crossFindings = null) {
  const period = effectiveRecord(rawPeriod);
  if (!period) return { ok: false, blockers: [blocker('period_not_found', 'Reporting period not found.')] };
  if (!hasInitializedState(period)) return { ok: false, blockers: [blocker('state_uninitialized', 'This period was not initialized by the server; it cannot be published.')] };
  const out = [];
  if (period.published) out.push(blocker('already_published', 'This period is already published.'));
  if (period.status !== 'final' || period.bva_import_status !== 'final' || !period.finalized_at) {
    out.push(blocker('not_final', 'Only a finalized period (validated BVA import) can be published.'));
  }
  out.push(...dataBlockers(period, lines, period.bva_overrides || {}));
  // A cross-period finding accepted at finalize stays accepted; a new one
  // (e.g. the previous month was revised since) needs a reopen and a reason.
  out.push(...crossPeriodBlockers(crossFindings, period.bva_overrides || {}).map((b) => (b.overridable
    ? { ...b, message: `${b.message} Not accepted at finalize: reopen to draft and finalize again with a written reason.` }
    : b)));
  const checklist = period.checklist || {};
  for (const [k, label] of PUBLISH_CHECKLIST) {
    if (!checklist[k]) out.push(blocker(`checklist_incomplete:${k}`, `Checklist item not confirmed: ${label}.`));
  }
  return { ok: out.length === 0, blockers: out };
}

// The overrides that finalize records: only those that clear a blocker that
// was actually present, each with its reason, who and when.
export function recordedOverrides(period, lines, overrides, by, at, crossFindings = null) {
  const needed = [...dataBlockers(period, lines, {}), ...crossPeriodBlockers(crossFindings, {})].filter((b) => b.overridable).map((b) => b.code);
  const out = { ...(period.bva_overrides || {}) };
  for (const code of needed) {
    const o = overrides[code] || overrides[code.replace(/^open_reconciliation:/, '')];
    if (hasReason(o)) out[code] = { reason: o.reason.trim(), by, at };
  }
  return out;
}
