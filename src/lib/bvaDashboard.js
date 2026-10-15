// Builds the entire main-dashboard view model from BVA data only.
//
// Inputs are the reporting period plus its BVA-sourced entities (BudgetLine,
// CashAccount, Distribution, RecurringTransfer, SavingsSpend). Nothing from
// QuickBooks is accepted here — that guarantees the Live (QuickBooks) layer
// can never populate or overwrite a figure on this dashboard.

import {
  n,
  round2,
  computeYtd,
  computeMonth,
  expectedPacePct,
  elapsedMonthsFromCutoff,
  paceStatus,
  STATUS,
  flagsForCategory,
  savingsStatus,
  SAVINGS_STATUS,
  FLAG,
  MONTHS_IN_YEAR,
} from './bva.js';
import { overridesFromCorrections, WARNING_SOURCE_PATHS } from './bvaCorrections.js';
import { effectiveRecord } from '../../base44/shared/sourceMissing.ts';

const EXPENSE_GROUPS = ['fixed', 'variable', 'discretionary'];

// ---- Missing vs zero --------------------------------------------------------
// A missing figure (null / absent / blank) is UNKNOWN: it is carried as null and
// rendered as "—" / "Source value missing", never as a fabricated $0.00. A
// stored 0 is an explicit, confirmed zero and stays 0.
const num = (v) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || !Number.isFinite(Number(v)) ? null : Number(v);
const r2n = (v) => (v == null ? null : round2(v));
// Sum of the known values. `complete` is false when any part is missing, so a
// total that leaves parts out is never presented as complete.
function known(values) {
  const vals = values.map(num);
  const present = vals.filter((v) => v != null);
  return {
    value: present.length ? round2(present.reduce((acc, v) => acc + v, 0)) : null,
    complete: present.length === vals.length,
    missingCount: vals.length - present.length,
  };
}
const missingYtd = (actual, annual, elapsedMonths) => ({
  mode: 'ytd',
  actual,
  annual,
  remaining: null,
  percentUsed: null,
  pacePct: expectedPacePct(elapsedMonths),
  expectedYtdBudget: null,
  varianceToPace: null,
  variancePct: null,
  favorable: null,
  status: null,
  missing: true,
});
const ytdOrMissing = (actual, annual, elapsedMonths) =>
  actual == null || annual == null ? missingYtd(actual, annual, elapsedMonths) : computeYtd({ actualYtd: actual, annualBudget: annual }, elapsedMonths);
const missingMonth = (monthlyBudget) => ({
  mode: 'month',
  actual: null,
  monthlyBudget: monthlyBudget ?? null,
  remaining: null,
  percentUsed: null,
  varianceToBudget: null,
  variancePct: null,
  favorable: null,
  hasActivity: false,
  missing: true,
});
const monthOrMissing = (monthActual, annualBudget, monthlyBudget) =>
  monthActual == null || (annualBudget == null && num(monthlyBudget) == null)
    ? missingMonth(num(monthlyBudget))
    : computeMonth({ monthActual, annualBudget: annualBudget ?? 0, monthlyBudget });

// Distribution quarters: a quarter that starts after the report's cutoff date
// is not yet applicable (shown "—", not missing and not $0.00).
const QUARTERS = ['q1', 'q2', 'q3', 'q4'];
const QUARTER_START = { q1: 1, q2: 4, q3: 7, q4: 10 };
export const QUARTER_STATE = { VALUE: 'value', MISSING: 'missing', NOT_YET: 'not_yet_applicable' };
const GROUP_LABEL = { fixed: 'Fixed', variable: 'Variable', discretionary: 'Discretionary' };
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Explicit non-OK states a section can report, so the UI never shows a silent
// zero or a stale value.
export const SECTION_STATE = {
  OK: 'ok',
  NOT_IMPORTED: 'not_imported', // "Data not imported"
  MISSING: 'source_missing', // "Source value missing"
  NEEDS_REVIEW: 'mapping_requires_review', // "Mapping requires review"
  DISCREPANCY: 'calculation_discrepancy', // "Calculation discrepancy"
  NO_MONTH_ACTIVITY: 'no_month_activity', // "No current-month activity imported."
};

export const SECTION_STATE_TEXT = {
  [SECTION_STATE.NOT_IMPORTED]: 'Data not imported',
  [SECTION_STATE.MISSING]: 'Source value missing',
  [SECTION_STATE.NEEDS_REVIEW]: 'Mapping requires review',
  [SECTION_STATE.DISCREPANCY]: 'Calculation discrepancy',
  [SECTION_STATE.NO_MONTH_ACTIVITY]: 'No current-month activity imported.',
};

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

function reportingLabels(period, elapsedMonths) {
  const cutoff = period?.reporting_cutoff_date || period?.end_date || null;
  // Reporting month is derived from the confirmed cutoff, not the filename.
  let monthIdx = null;
  let year = period?.year || null;
  if (cutoff) {
    const d = new Date(cutoff);
    if (!Number.isNaN(d.getTime())) {
      monthIdx = d.getUTCMonth();
      year = d.getUTCFullYear();
    }
  }
  if (monthIdx == null && period?.month) monthIdx = period.month - 1;
  const displayMonth = monthIdx != null && year ? `${MONTH_NAMES[monthIdx]} ${year}` : period?.label || '';
  const monthWord = monthIdx != null ? MONTH_NAMES[monthIdx] : '';
  // finalized_at is cleared to '' (Base44 rejects null for string fields), so test truthiness.
  const isFinal = period?.status === 'final' || !!period?.finalized_at;
  return {
    displayMonth,
    reportingCutoffDate: cutoff ? fmtDate(cutoff) : null,
    incomeThrough: monthWord ? `Income received through ${monthWord} ${year}` : null,
    expensesThrough: monthWord ? `Expenses through ${monthWord} ${year}` : null,
    cashAsOf: cutoff ? `As of ${fmtDate(cutoff)}` : null,
    reportHeading: displayMonth ? `${displayMonth} report` : period?.label || '',
    dataThrough: cutoff ? `Data through ${fmtDate(cutoff)}` : null,
    lastUpdated: period?.last_updated ? fmtDate(period.last_updated) : null,
    statusLabel: isFinal ? 'Final' : 'Draft',
    isFinal,
    elapsedMonths,
    elapsedLabel: `${elapsedMonths} of ${MONTHS_IN_YEAR} months elapsed`,
  };
}

// How each stored validation warning stands against what has since been
// confirmed in Admin. The stored warning list is never rewritten — resolution
// status is derived at read time from the audit trail (override reasons,
// source corrections) and the period's own child records, so the history is
// preserved and a warning re-emerges automatically if its basis changes.
const INFORMATIONAL_CODES = new Set(['period_follows_cutoff_month', 'period_is_cutoff_month']);

// "Blank distribution cells for quarters that have begun: Alpha Q1, Alpha Q2."
//   → [{ entity: 'Alpha', quarter: 'q1' }, { entity: 'Alpha', quarter: 'q2' }]
export function parseBlankQuarters(message) {
  const m = /:\s*(.+?)(?:\.\s|\.$)/.exec(String(message || '').trim());
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .map((s) => {
      const mm = /^(.*)\s+Q([1-4])$/i.exec(s);
      return mm ? { entity: mm[1].trim(), quarter: `q${mm[2]}` } : null;
    })
    .filter(Boolean);
}

function warningIndex(period, { distributions = [], transfers = [] } = {}) {
  const list = Array.isArray(period?.bva_validation_warnings) ? period.bva_validation_warnings : [];
  const corrections = Array.isArray(period?.bva_corrections) ? period.bva_corrections : [];
  const overrides = { ...(period?.bva_overrides || {}), ...overridesFromCorrections(corrections) };
  const correctedPaths = new Set(
    corrections.filter((c) => c && c.kind === 'source' && c.path).map((c) => c.path)
  );

  const classified = list.map((w) => {
    const entry = { ...w, overridden: w.overridden || w.override != null };
    let resolution = 'unresolved';
    let note = null;
    const o = overrides[w.code];
    if (o) {
      resolution = 'accepted';
      note = o.reason;
    } else if (WARNING_SOURCE_PATHS[w.code] && correctedPaths.has(WARNING_SOURCE_PATHS[w.code])) {
      resolution = 'resolved';
      const corr = corrections.find((c) => c.kind === 'source' && c.path === WARNING_SOURCE_PATHS[w.code]);
      note = corr ? `Corrected in the BVA Import screen: ${corr.reason || 'value corrected'}` : 'Corrected in the BVA Import screen.';
    } else if (w.code === 'transfer_labels_misaligned') {
      if (transfers.length > 0 && transfers.every((t) => t.source && t.purpose)) {
        resolution = 'resolved';
        note = `All ${transfers.length} recurring transfers carry confirmed source and purpose labels.`;
      }
    } else if (w.code === 'distribution_quarter_blank') {
      const blanks = parseBlankQuarters(w.message);
      if (blanks.length) {
        const stillBlank = blanks.filter(({ entity, quarter }) => {
          const d = distributions.find(
            (x) => String(x.entity_name || '').trim().toLowerCase() === entity.toLowerCase()
          );
          return !d || d[quarter] == null;
        });
        if (!stillBlank.length) {
          resolution = 'resolved';
          note = 'Each blank distribution quarter has since been confirmed.';
        }
      }
    } else if (INFORMATIONAL_CODES.has(w.code)) {
      resolution = 'informational';
      note = 'The BVA report month intentionally follows its data-cutoff month; the cutoff is confirmed in Admin.';
    }
    return { ...entry, resolution, note };
  });

  const bySection = {};
  const byCategory = {};
  for (const w of classified) {
    if (w.section) (bySection[w.section] = bySection[w.section] || []).push(w);
    const key = (w.category || w.account_number || '').toString().toLowerCase();
    if (key) (byCategory[key] = byCategory[key] || []).push(w);
  }
  const unresolved = classified.filter((w) => w.resolution === 'unresolved');
  return {
    list: classified,
    bySection,
    byCategory,
    unresolved,
    hasUnresolved: unresolved.length > 0,
    resolution: {
      resolved: classified.filter((w) => w.resolution === 'resolved'),
      accepted: classified.filter((w) => w.resolution === 'accepted'),
      informational: classified.filter((w) => w.resolution === 'informational'),
      unresolved,
    },
  };
}

function pickState({ imported = false, needsReview = false, discrepancy = false, monthMode = false, hasMonthActivity = false }) {
  if (!imported) return SECTION_STATE.NOT_IMPORTED;
  if (discrepancy) return SECTION_STATE.DISCREPANCY;
  if (needsReview) return SECTION_STATE.NEEDS_REVIEW;
  if (monthMode && !hasMonthActivity) return SECTION_STATE.NO_MONTH_ACTIVITY;
  return SECTION_STATE.OK;
}

/**
 * @param {object} data
 *   period          ReportingPeriod
 *   budgetLines     BudgetLine[]
 *   cashAccounts    CashAccount[]
 *   distributions   Distribution[]
 *   transfers       RecurringTransfer[]
 *   savingsSpends   SavingsSpend[]
 * @param {object} opts { month?: boolean }  // false = Year to Date, true = This Month
 */
export function buildBvaDashboard(data, opts = {}) {
  // Fields listed in source_missing_fields are missing, whatever is stored.
  const period = effectiveRecord(data.period || {});
  const monthMode = !!opts.month;
  const mode = monthMode ? 'month' : 'ytd';
  const lines = Array.isArray(data.budgetLines) ? data.budgetLines : [];
  const cashAccounts = Array.isArray(data.cashAccounts) ? data.cashAccounts : [];
  const distributions = Array.isArray(data.distributions) ? data.distributions : [];
  const transfers = Array.isArray(data.transfers) ? data.transfers : [];
  const savingsSpends = Array.isArray(data.savingsSpends) ? data.savingsSpends : [];

  const elapsedMonths =
    period.months_elapsed != null && period.months_elapsed !== ''
      ? Math.min(Math.max(n(period.months_elapsed), 0), MONTHS_IN_YEAR)
      : elapsedMonthsFromCutoff(period.reporting_cutoff_date || period.end_date);
  const pacePct = expectedPacePct(elapsedMonths);
  // Periods imported under the printed-total rule (bvaImport.js marks them)
  // show the workbook's printed totals. Every period stored before it keeps
  // exactly the display it was published with (never reinterpreted).
  const printedRule = period.printed_totals === true;
  const labels = reportingLabels(period, elapsedMonths);
  const warnings = warningIndex(period, { distributions, transfers });

  // A period is "BVA-validated" only when it has a finalized BVA import.
  // Everything else is legacy data or an in-progress draft import — it is
  // displayed from its stored values but never described as validated.
  const provenance =
    period.bva_import_status === 'final'
      ? { mode: 'bva_final', isBvaValidated: true, isLegacy: false, label: null }
      : period.bva_import_status === 'draft' && period.bva_parsed_source
        ? { mode: 'bva_draft', isBvaValidated: false, isLegacy: false, label: 'Draft BVA import — not finalized' }
        : { mode: 'legacy', isBvaValidated: false, isLegacy: true, label: 'Legacy period — not validated through BVA import' };

  const isDetail = (l) => !!(l.bva_detail || l.detail_flag);
  // Group-summary lines drive the Budget Overview and the snapshot. Monitored
  // DETAIL categories are a separate watchlist that rolls up into these groups
  // in the workbook — they are NOT summed into the group totals here.
  const expenseLines = lines.filter((l) => EXPENSE_GROUPS.includes(l.budget_group) && !isDetail(l));
  const incomeLines = lines.filter((l) => l.budget_group === 'income' && !isDetail(l));
  const detailLines = lines.filter(isDetail);
  const imported = lines.length > 0;

  // ---- Groups (Fixed / Variable / Discretionary) --------------------
  // A line's month_actual is null when the workbook's month column was blank.
  // "Missing" (no line carries a figure) is kept distinct from a real zero, and
  // a group whose lines are only partly known is marked partial.
  const lineMonthly = (l) => (num(l.monthly_budget) ?? (num(l.annual_budget) != null ? num(l.annual_budget) / MONTHS_IN_YEAR : null));
  const groups = EXPENSE_GROUPS.map((key) => {
    const gl = expenseLines.filter((l) => l.budget_group === key);
    const gM = known(gl.map((l) => l.month_actual));
    const gY = known(gl.map((l) => l.ytd_actual));
    const gB = known(gl.map((l) => l.annual_budget));
    const monthActual = gM.value;
    const ytd = {
      ...ytdOrMissing(gY.complete ? gY.value : null, gB.complete ? gB.value : null, elapsedMonths),
      count: gl.length,
      partial: gl.length > 0 && !(gY.complete && gB.complete),
    };
    const monthly = known(gl.map(lineMonthly)).value;
    const monthC = {
      ...monthOrMissing(monthActual, ytd.annual, monthly),
      partial: monthActual != null && !gM.complete,
    };
    // Per-line rows for this group's category breakdown (used by the public
    // client view's group cards). Shape matches the detail rows so CategoryTable
    // and the drill-down render them unchanged.
    const lineRows = gl.map((l) => {
      const lineC = ytdOrMissing(num(l.ytd_actual), num(l.annual_budget), elapsedMonths);
      const lineM = monthOrMissing(num(l.month_actual), num(l.annual_budget), l.monthly_budget);
      return {
        id: l.id,
        category: l.category,
        code: l.qb_code || null,
        group: key,
        qb_account_names: Array.isArray(l.qb_account_names) ? l.qb_account_names : [],
        annual_budget: num(l.annual_budget),
        ytd_actual: num(l.ytd_actual),
        month_actual: num(l.month_actual),
        has_snapshot: true,
        monthActual: r2n(num(l.month_actual)),
        monthActualMissing: num(l.month_actual) == null,
        ytd: lineC,
        month: lineM,
        view: monthMode ? lineM : lineC,
        hasUnresolvedWarning: false,
        drilldownEnabled: l.drilldown_enabled !== false,
      };
    });
    return {
      key,
      label: GROUP_LABEL[key],
      monthActual,
      monthActualPartial: monthC.partial,
      ytd,
      month: monthC,
      view: monthMode ? monthC : ytd,
      lineCount: gl.length,
      lines: lineRows,
    };
  });

  const eM = known(expenseLines.map((l) => l.month_actual));
  const eY = known(expenseLines.map((l) => l.ytd_actual));
  const eB = known(expenseLines.map((l) => l.annual_budget));
  const expenseMonthPresent = expenseLines.length > 0 && eM.value != null;
  // The overall expense figure is the stored total -- the workbook's printed
  // Total Expenses (see bvaImport.js) -- and falls back to the sum of the group
  // lines when none is stored. The sum is kept to show when the workbook does
  // not add up. It is NEVER the discretionary group alone.
  const expensesCalculated = { ytd: expenseLines.length && eY.complete ? eY.value : null, budget: expenseLines.length && eB.complete ? eB.value : null };
  const overallExpenses = printedRule
    ? ytdOrMissing(num(period.ytd_expenses) ?? expensesCalculated.ytd, num(period.annual_budgeted_expenses) ?? expensesCalculated.budget, elapsedMonths)
    : expenseLines.length
      ? ytdOrMissing(expensesCalculated.ytd, expensesCalculated.budget, elapsedMonths)
      : ytdOrMissing(num(period.ytd_expenses), num(period.annual_budgeted_expenses), elapsedMonths);
  // Current-month expenses — null ("Source value missing") when no source
  // carries a figure; a present zero still renders as $0.00; a total that
  // leaves out lines without a figure is marked partial.
  const monthExpenses = expenseLines.length ? eM.value : r2n(num(period.month_expenses));
  const monthExpensesPartial = expenseLines.length > 0 && eM.value != null && !eM.complete;

  // ---- Income ------------------------------------------------------
  const iY = known(incomeLines.map((l) => l.ytd_actual));
  const iB = known(incomeLines.map((l) => l.annual_budget));
  const iM = known(incomeLines.map((l) => l.month_actual));
  // The stored totals are what the workbook prints (bvaImport.js); the sums
  // of the income lines are kept to show when the workbook does not add up.
  const incomeCalculated = { ytd: incomeLines.length && iY.complete ? iY.value : null, budget: incomeLines.length && iB.complete ? iB.value : null };
  const ytdIncome = printedRule || !incomeLines.length ? r2n(num(period.ytd_income)) ?? incomeCalculated.ytd : incomeCalculated.ytd;
  const annualBudgetedIncome = printedRule || !incomeLines.length ? r2n(num(period.annual_budgeted_income)) ?? incomeCalculated.budget : incomeCalculated.budget;
  const remainingIncomeBudget = annualBudgetedIncome == null || ytdIncome == null ? null : round2(annualBudgetedIncome - ytdIncome);
  const incomeBudgetUsedPct =
    annualBudgetedIncome == null || ytdIncome == null ? null : annualBudgetedIncome ? ytdIncome / annualBudgetedIncome : 0;
  // Current-month income is null ("Source value missing") when neither the
  // imported income lines nor the stored period scalar carry a figure — the
  // BVA workbook's month column is routinely blank and must never be read as
  // a confirmed $0. A present-but-zero source still shows $0.00.
  const monthIncome = incomeLines.length ? iM.value : r2n(num(period.month_income));
  const monthIncomePartial = incomeLines.length > 0 && iM.value != null && !iM.complete;
  const incomeWorkbookBudget = period.annual_budgeted_income_workbook ?? null;

  const incomeRows = incomeLines.map((l) => {
    const annual = num(l.annual_budget);
    const ytd = num(l.ytd_actual);
    const both = annual != null && ytd != null;
    return {
      id: l.id,
      category: l.category,
      code: l.qb_code || null,
      // null = the workbook had no current-month figure for this line.
      monthActual: r2n(num(l.month_actual)),
      actualYtd: r2n(ytd),
      annualBudget: r2n(annual),
      remaining: both ? round2(annual - ytd) : null,
      percentUsed: both ? (annual ? ytd / annual : 0) : null,
      drilldownEnabled: l.drilldown_enabled !== false,
    };
  });

  // ---- Detail (monitored categories) ----------------------------
  const detail = detailLines.map((l) => {
    const key = (l.qb_code || l.category || '').toString().toLowerCase();
    const catWarnings = warnings.byCategory[key] || [];
    const hasUnresolvedWarning = catWarnings.some((w) => w.resolution === 'unresolved');
    const ytdV = num(l.ytd_actual);
    const annV = num(l.annual_budget);
    const valuesMissing = ytdV == null || annV == null;
    // A savings line (e.g. MONTHLY SAVINGS) is a TARGET, not an expense: the
    // pace math is the same, but the tone inverts (saving less than expected is
    // the unfavorable outcome) and the labels speak of the savings target.
    const isSavingsLine = l.budget_group === 'savings';
    const savingsC = isSavingsLine
      ? valuesMissing
        ? missingYtd(ytdV, annV, elapsedMonths)
        : savingsStatus({ actualYtd: ytdV, annualBudget: annV }, elapsedMonths)
      : null;
    const f = isSavingsLine
      ? null
      : valuesMissing
        ? { computed: missingYtd(ytdV, annV, elapsedMonths), flagged: hasUnresolvedWarning, reasons: hasUnresolvedWarning ? [FLAG.UNRESOLVED_WARNING] : [] }
        : flagsForCategory({ actualYtd: ytdV, annualBudget: annV }, elapsedMonths, hasUnresolvedWarning);
    const monthC = monthOrMissing(num(l.month_actual), annV, l.monthly_budget);
    const hasFvdGroup = !!(l.group_confirmed && EXPENSE_GROUPS.includes(l.budget_group));
    return {
      id: l.id,
      category: l.category,
      code: l.qb_code || null,
      // raw passthrough so the drilldown sheet can resolve transactions + budget context
      account_id: l.account_id || null,
      qb_account_names: Array.isArray(l.qb_account_names) ? l.qb_account_names : [],
      annual_budget: annV,
      ytd_actual: ytdV,
      month_actual: num(l.month_actual),
      has_snapshot: true,
      // Savings lines carry their own classification; other detail rows count
      // as grouped ONLY when an admin has confirmed a valid
      // Fixed/Variable/Discretionary group. Anything else is 'unassigned'.
      group: isSavingsLine ? 'savings' : hasFvdGroup ? l.budget_group : 'unassigned',
      groupConfirmed: isSavingsLine ? true : hasFvdGroup,
      groupLabel: isSavingsLine ? 'Savings' : hasFvdGroup ? GROUP_LABEL[l.budget_group] : 'Unassigned',
      // null = the workbook had no current-month figure for this line.
      monthActual: r2n(num(l.month_actual)),
      monthActualMissing: num(l.month_actual) == null,
      valuesMissing,
      ytd: isSavingsLine ? savingsC : f.computed,
      month: monthC,
      view: monthMode ? monthC : isSavingsLine ? savingsC : f.computed,
      flagged: isSavingsLine
        ? savingsC.status === SAVINGS_STATUS.BELOW || hasUnresolvedWarning
        : f.flagged,
      reasons: isSavingsLine
        ? savingsC.status === SAVINGS_STATUS.BELOW
          ? [FLAG.SAVINGS_BELOW]
          : []
        : f.reasons,
      hasUnresolvedWarning,
      warnings: catWarnings,
      drilldownEnabled: l.drilldown_enabled !== false,
    };
  });

  // Categories Needing Attention: every flagged detail row, largest
  // Over Budget dollar variance first (most negative variance-to-pace).
  const attention = detail
    .filter((d) => d.flagged)
    .sort((a, b) => (a.ytd.varianceToPace ?? 0) - (b.ytd.varianceToPace ?? 0));

  // ---- Cash ---------------------------------------------------
  const cashRows = [...cashAccounts]
    .sort((a, b) => n(a.sort_order) - n(b.sort_order))
    .map((a) => ({
      id: a.id,
      name: a.name,
      balance: r2n(num(a.balance)),
      balanceMissing: num(a.balance) == null,
      accountType: a.account_type === 'investment' ? 'investment' : 'bank',
      asOf: a.as_of_date ? fmtDate(a.as_of_date) : labels.reportingCutoffDate,
    }));
  const cK = known(cashRows.map((a) => a.balance));
  const cashCalculated = cK.value;
  const cashPartial = cashRows.length > 0 && !cK.complete;
  const cashReported = r2n(num(period.total_cash));
  const cashReconciles = cashReported == null || cashPartial || cashCalculated == null ? null : cashCalculated === cashReported;
  // The workbook's printed Total Cash when stored; else the sum of the
  // (known) balances, marked partial when one is missing.
  const totalCash = printedRule ? (cashReported != null ? cashReported : cashRows.length ? cashCalculated : null) : cashRows.length ? cashCalculated : cashReported;

  // ---- Distributions -----------------------------------------
  // Quarter applicability comes from the REPORT's cutoff date (never today):
  // a quarter that starts after the cutoff is not yet applicable.
  const cutoffMonth = (() => {
    const c = period.reporting_cutoff_date;
    if (c) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d.getUTCMonth() + 1;
    }
    return elapsedMonths || null;
  })();
  const quarterApplicable = Object.fromEntries(QUARTERS.map((q) => [q, cutoffMonth == null || cutoffMonth >= QUARTER_START[q]]));
  const distEntities = distributions.map((d) => {
    const values = {};
    const quarterState = {};
    for (const q of QUARTERS) {
      values[q] = r2n(num(d[q]));
      quarterState[q] = values[q] != null ? QUARTER_STATE.VALUE : quarterApplicable[q] ? QUARTER_STATE.MISSING : QUARTER_STATE.NOT_YET;
    }
    const counted = QUARTERS.filter((q) => quarterState[q] !== QUARTER_STATE.NOT_YET);
    const k = known(counted.map((q) => values[q]));
    const printed = printedRule ? r2n(num(d.workbook_ytd)) : null;
    return {
      id: d.id,
      name: d.entity_name,
      ...values,
      quarterState,
      // The YTD the workbook prints for the entity when stored; else the sum
      // of the applicable quarters (partial when a begun quarter is blank).
      ytd: printed != null ? printed : k.value,
      ytdPartial: printed != null ? false : !k.complete,
      ytdCalculated: k.value,
      ytdReconciles: printed == null || !k.complete ? null : printed === k.value,
    };
  });
  const dK = known(distEntities.map((e) => e.ytd));
  const distPartial = distEntities.some((e) => e.ytdPartial) || !dK.complete;
  const distEntitySum = dK.value;
  // The stored total (set at import time from the sum of each entity's own
  // quarters — see bvaImport.js) is what the dashboard shows. This check
  // flags any drift between that stored value and a fresh recompute from the
  // current Distribution records — e.g. a manual edit after import, or a
  // legacy period stored before this calculation was corrected. A partial
  // recompute cannot confirm or contradict it.
  const storedDistributions = r2n(num(period.distributions_ytd));
  // The workbook's printed quarter column totals (only those it prints).
  const printedQuarterTotals = printedRule
    ? Object.fromEntries(QUARTERS.map((q) => [q, r2n(num(period.distribution_quarter_totals?.[q]))]).filter(([, v]) => v != null))
    : {};
  const distributionsYtd = storedDistributions != null ? storedDistributions : distEntitySum;
  const distReconciles = storedDistributions == null || distPartial || distEntitySum == null ? null : distEntitySum === storedDistributions;

  // ---- Savings & Distributions cards ------------------------
  const savingsIn = r2n(num(period.savings_in_ytd));
  const savingsSpend = r2n(num(period.savings_spend_ytd));
  const netSavings = savingsIn != null && savingsSpend != null ? round2(savingsIn - savingsSpend) : null;

  // ---- Recurring transfers ---------------------------------
  const transferRows = transfers
    .filter((t) => t.visible_to_client !== false)
    .map((t) => ({ id: t.id, amount: r2n(num(t.amount)), amountMissing: num(t.amount) == null, source: t.source || null, purpose: t.purpose || null }));
  const tK = known(transferRows.map((t) => t.amount));
  const transfersTotal = tK.value;
  const transfersPartial = transferRows.length > 0 && !tK.complete;

  // ---- Section states -------------------------------------
  // In This Month mode, distinguish "the workbook carried no month figures"
  // (MISSING — show "Source value missing") from "a real imported zero"
  // (NO_MONTH_ACTIVITY — show "$0.00 / No current-month activity imported.").
  const monthIncomeMissing = monthIncome == null;
  const monthExpensesMissing = monthExpenses == null;
  const monthFiguresMissing = monthIncomeMissing && monthExpensesMissing;
  const anyMonthActivity = groups.some((g) => round2(n(g.monthActual)) !== 0) || round2(n(monthIncome)) !== 0;
  const unassignedDetail = detail.filter((d) => d.group === 'unassigned');
  const detailNeedsReview = detail.some((d) => !d.groupConfirmed || d.hasUnresolvedWarning);

  const states = {
    snapshot:
      monthMode && monthFiguresMissing
        ? SECTION_STATE.MISSING
        : pickState({ imported, monthMode, hasMonthActivity: anyMonthActivity }),
    groups:
      monthMode && expenseLines.length > 0 && !expenseMonthPresent
        ? SECTION_STATE.MISSING
        : pickState({ imported: expenseLines.length > 0, monthMode, hasMonthActivity: anyMonthActivity }),
    detail: pickState({
      imported: detailLines.length > 0,
      needsReview: detailNeedsReview,
      monthMode,
      hasMonthActivity: anyMonthActivity,
    }),
    income:
      monthMode && monthIncomeMissing
        ? SECTION_STATE.MISSING
        : pickState({ imported: incomeLines.length > 0 || period.ytd_income != null, monthMode, hasMonthActivity: round2(n(monthIncome)) !== 0 }),
    cash: pickState({ imported: cashRows.length > 0 || cashReported != null, discrepancy: cashReconciles === false }),
    distributions: pickState({ imported: distEntities.length > 0 || period.distributions_ytd != null, discrepancy: distReconciles === false }),
    savings:
      savingsIn == null && savingsSpend == null
        ? SECTION_STATE.NOT_IMPORTED
        : SECTION_STATE.NEEDS_REVIEW, // mapping unverified — Admin review
    transfers: pickState({ imported: transferRows.length > 0 }),
  };

  return {
    mode,
    monthMode,
    elapsedMonths,
    pacePct,
    labels,
    warnings,
    states,
    provenance,
    unassignedDetailCount: unassignedDetail.length,
    snapshot: {
      totalCash,
      cashReconciles,
      cashSource: cashRows.length ? 'accounts' : 'reported',
      cashPartial,
      ytdIncome,
      ytdIncomeMissing: ytdIncome == null,
      annualBudgetedIncome,
      annualBudgetedIncomeMissing: annualBudgetedIncome == null,
      remainingIncomeBudget,
      incomeBudgetUsedPct,
      incomeWorkbookBudget,
      // The sums of the rows, kept to show when the workbook does not add up.
      incomeCalculatedYtd: incomeCalculated.ytd,
      incomeCalculatedBudget: incomeCalculated.budget,
      expensesCalculatedYtd: expensesCalculated.ytd,
      expensesCalculatedBudget: expensesCalculated.budget,
      monthIncome,
      monthIncomeMissing,
      monthIncomePartial,
      ytdExpenses: r2n(overallExpenses.actual),
      annualExpenseBudget: r2n(overallExpenses.annual),
      annualExpenseBudgetMissing: overallExpenses.annual == null,
      remainingAnnualBudget: r2n(overallExpenses.remaining),
      expenseBudgetUsedPct: overallExpenses.percentUsed,
      monthExpenses,
      monthExpensesMissing,
      monthExpensesPartial,
      expectedPacePct: pacePct,
      overallVarianceAmount: r2n(overallExpenses.varianceToPace),
      overallVariancePct: overallExpenses.variancePct,
      favorable: overallExpenses.varianceToPace != null && overallExpenses.varianceToPace > 0,
      onPace: overallExpenses.varianceToPace != null && round2(overallExpenses.varianceToPace) === 0,
      status: overallExpenses.status,
    },
    groups,
    incomeRows,
    detail,
    attention,
    cash: {
      total: totalCash,
      calculatedTotal: cashCalculated,
      reportedTotal: cashReported,
      reconciles: cashReconciles,
      partial: cashPartial,
      accounts: cashRows,
    },
    distributions: {
      total: distributionsYtd,
      entitySum: distEntitySum,
      printedQuarterTotals,
      printedTotals: printedRule,
      reconciles: distReconciles,
      partial: distPartial,
      quarterApplicable,
      cutoffMonth,
      entities: distEntities,
    },
    savingsDistributions: {
      distributionsYtd,
      savingsIn,
      savingsSpend,
      netSavings,
      // null inputs → the field is unverified / not entered, not a confirmed $0.
      savingsInMissing: savingsIn == null,
      savingsSpendMissing: savingsSpend == null,
      netSavingsMissing: netSavings == null,
      savingsInVerified: false,
      savingsSpendVerified: false,
      savingsSpendCategories: savingsSpends.map((s) => ({ id: s.id, category: s.category, ytdAmount: r2n(num(s.ytd_amount)) })),
    },
    transfers: { items: transferRows, total: transfersTotal, partial: transfersPartial },
    overallExpenses,
    hasUnresolvedWarnings: warnings.hasUnresolved,
    STATUS,
  };
}