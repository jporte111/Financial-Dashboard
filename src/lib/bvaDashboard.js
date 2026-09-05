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
  aggregateYtd,
  expectedPacePct,
  elapsedMonthsFromCutoff,
  paceStatus,
  STATUS,
  flagsForCategory,
  MONTHS_IN_YEAR,
} from './bva.js';

const EXPENSE_GROUPS = ['fixed', 'variable', 'discretionary'];
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
  const isFinal = period?.status === 'final' || period?.finalized_at != null;
  return {
    displayMonth,
    reportingCutoffDate: cutoff ? fmtDate(cutoff) : null,
    incomeThrough: monthWord ? `Income received through ${monthWord} ${year}` : null,
    expensesThrough: monthWord ? `Expenses through ${monthWord} ${year}` : null,
    cashAsOf: cutoff ? `As of ${fmtDate(cutoff)}` : null,
    lastUpdated: period?.last_updated ? fmtDate(period.last_updated) : null,
    statusLabel: isFinal ? 'Final' : 'Draft',
    isFinal,
    elapsedMonths,
    elapsedLabel: `${elapsedMonths} of ${MONTHS_IN_YEAR} months elapsed`,
  };
}

function warningIndex(period) {
  const list = Array.isArray(period?.bva_validation_warnings) ? period.bva_validation_warnings : [];
  const bySection = {};
  const byCategory = {};
  for (const w of list) {
    const overridden = w.overridden || w.override != null;
    const entry = { ...w, overridden };
    if (w.section) (bySection[w.section] = bySection[w.section] || []).push(entry);
    const key = (w.category || w.account_number || '').toString().toLowerCase();
    if (key) (byCategory[key] = byCategory[key] || []).push(entry);
  }
  const unresolved = list.filter((w) => !(w.overridden || w.override != null));
  return { list, bySection, byCategory, unresolved, hasUnresolved: unresolved.length > 0 };
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
  const period = data.period || {};
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
  const labels = reportingLabels(period, elapsedMonths);
  const warnings = warningIndex(period);

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
  const groups = EXPENSE_GROUPS.map((key) => {
    const gl = expenseLines.filter((l) => l.budget_group === key);
    const monthActual = round2(gl.reduce((s, l) => s + n(l.month_actual), 0));
    const ytd = aggregateYtd(gl, elapsedMonths);
    const monthly = round2(gl.reduce((s, l) => s + (n(l.monthly_budget) || n(l.annual_budget) / MONTHS_IN_YEAR), 0));
    const monthC = computeMonth({ monthActual, annualBudget: ytd.annual, monthlyBudget: monthly });
    return {
      key,
      label: GROUP_LABEL[key],
      monthActual,
      ytd,
      month: monthC,
      view: monthMode ? monthC : ytd,
      lineCount: gl.length,
    };
  });

  const expTotals = groups.reduce(
    (acc, g) => {
      acc.actualYtd += g.ytd.actual;
      acc.annualBudget += g.ytd.annual;
      acc.monthActual += g.monthActual;
      return acc;
    },
    { actualYtd: 0, annualBudget: 0, monthActual: 0 }
  );
  // The overall expense figure is computed from the group lines when present
  // (calculated wins); it falls back to the stored period scalars only when no
  // expense lines have been imported. It is NEVER the discretionary group alone.
  const overallExpenses = expenseLines.length
    ? computeYtd({ actualYtd: expTotals.actualYtd, annualBudget: expTotals.annualBudget }, elapsedMonths)
    : computeYtd(
        { actualYtd: n(period.ytd_expenses), annualBudget: n(period.annual_budgeted_expenses) },
        elapsedMonths
      );

  // ---- Income ------------------------------------------------------
  const incomeYtdFromLines = round2(incomeLines.reduce((s, l) => s + n(l.ytd_actual), 0));
  const incomeBudgetFromLines = round2(incomeLines.reduce((s, l) => s + n(l.annual_budget), 0));
  const ytdIncome = incomeLines.length ? incomeYtdFromLines : n(period.ytd_income);
  // Independently calculated budget wins over any stored workbook figure.
  const annualBudgetedIncome = incomeLines.length
    ? incomeBudgetFromLines
    : n(period.annual_budgeted_income);
  const remainingIncomeBudget = round2(annualBudgetedIncome - ytdIncome);
  const incomeBudgetUsedPct = annualBudgetedIncome ? ytdIncome / annualBudgetedIncome : 0;
  const monthIncome = incomeLines.length
    ? round2(incomeLines.reduce((s, l) => s + n(l.month_actual), 0))
    : n(period.month_income);
  const incomeWorkbookBudget = period.annual_budgeted_income_workbook ?? null;

  const incomeRows = incomeLines.map((l) => {
    const annual = n(l.annual_budget);
    const ytd = n(l.ytd_actual);
    return {
      id: l.id,
      category: l.category,
      code: l.qb_code || null,
      monthActual: round2(n(l.month_actual)),
      actualYtd: round2(ytd),
      annualBudget: round2(annual),
      remaining: round2(annual - ytd),
      percentUsed: annual ? ytd / annual : 0,
      drilldownEnabled: l.drilldown_enabled !== false,
    };
  });

  // ---- Detail (monitored categories) ----------------------------
  const detail = detailLines.map((l) => {
    const key = (l.qb_code || l.category || '').toString().toLowerCase();
    const catWarnings = warnings.byCategory[key] || [];
    const hasUnresolvedWarning = catWarnings.some((w) => !w.overridden);
    const f = flagsForCategory(
      { actualYtd: n(l.ytd_actual), annualBudget: n(l.annual_budget) },
      elapsedMonths,
      hasUnresolvedWarning
    );
    const monthC = computeMonth({
      monthActual: n(l.month_actual),
      annualBudget: n(l.annual_budget),
      monthlyBudget: l.monthly_budget,
    });
    return {
      id: l.id,
      category: l.category,
      code: l.qb_code || null,
      // raw passthrough so the drilldown sheet can resolve transactions + budget context
      account_id: l.account_id || null,
      qb_account_names: Array.isArray(l.qb_account_names) ? l.qb_account_names : [],
      annual_budget: n(l.annual_budget),
      ytd_actual: n(l.ytd_actual),
      month_actual: n(l.month_actual),
      has_snapshot: true,
      // A detail row counts as grouped ONLY when an admin has confirmed a valid
      // Fixed/Variable/Discretionary group. Anything else is 'unassigned'.
      group: l.group_confirmed && EXPENSE_GROUPS.includes(l.budget_group) ? l.budget_group : 'unassigned',
      groupConfirmed: !!(l.group_confirmed && EXPENSE_GROUPS.includes(l.budget_group)),
      groupLabel:
        l.group_confirmed && EXPENSE_GROUPS.includes(l.budget_group) ? GROUP_LABEL[l.budget_group] : 'Unassigned',
      monthActual: round2(n(l.month_actual)),
      ytd: f.computed,
      month: monthC,
      view: monthMode ? monthC : f.computed,
      flagged: f.flagged,
      reasons: f.reasons,
      hasUnresolvedWarning,
      warnings: catWarnings,
      drilldownEnabled: l.drilldown_enabled !== false,
    };
  });

  // Categories Needing Attention: every flagged detail row, largest
  // unfavorable dollar variance first.
  const attention = detail
    .filter((d) => d.flagged)
    .sort((a, b) => a.ytd.varianceToPace - b.ytd.varianceToPace);

  // ---- Cash ---------------------------------------------------
  const cashRows = [...cashAccounts]
    .sort((a, b) => n(a.sort_order) - n(b.sort_order))
    .map((a) => ({
      id: a.id,
      name: a.name,
      balance: round2(n(a.balance)),
      accountType: a.account_type === 'investment' ? 'investment' : 'bank',
      asOf: a.as_of_date ? fmtDate(a.as_of_date) : labels.reportingCutoffDate,
    }));
  const cashCalculated = round2(cashRows.reduce((s, a) => s + a.balance, 0));
  const cashReported = period.total_cash != null ? round2(n(period.total_cash)) : null;
  const cashReconciles = cashReported == null ? null : cashCalculated === cashReported;
  const totalCash = cashRows.length ? cashCalculated : cashReported;

  // ---- Distributions -----------------------------------------
  const distEntities = distributions.map((d) => {
    const ytd = round2(n(d.q1) + n(d.q2) + n(d.q3) + n(d.q4));
    return { id: d.id, name: d.entity_name, q1: n(d.q1), q2: n(d.q2), q3: n(d.q3), q4: n(d.q4), ytd };
  });
  const distEntitySum = round2(distEntities.reduce((s, e) => s + e.ytd, 0));
  // The stored total (set at import time from the sum of each entity's own
  // quarters — see bvaImport.js) is what the dashboard shows. This check
  // flags any drift between that stored value and a fresh recompute from the
  // current Distribution records — e.g. a manual edit after import, or a
  // legacy period stored before this calculation was corrected.
  const distributionsYtd = period.distributions_ytd != null ? round2(n(period.distributions_ytd)) : distEntitySum;
  const distReconciles = period.distributions_ytd == null ? null : distEntitySum === distributionsYtd;

  // ---- Savings & Distributions cards ------------------------
  const savingsIn = period.savings_in_ytd != null ? round2(n(period.savings_in_ytd)) : null;
  const savingsSpend = period.savings_spend_ytd != null ? round2(n(period.savings_spend_ytd)) : null;
  const netSavings = savingsIn != null && savingsSpend != null ? round2(savingsIn - savingsSpend) : null;

  // ---- Recurring transfers ---------------------------------
  const transferRows = transfers
    .filter((t) => t.visible_to_client !== false)
    .map((t) => ({ id: t.id, amount: round2(n(t.amount)), source: t.source || null, purpose: t.purpose || null }));
  const transfersTotal = round2(transferRows.reduce((s, t) => s + t.amount, 0));

  // ---- Section states -------------------------------------
  const anyMonthActivity = groups.some((g) => round2(g.monthActual) !== 0) || round2(monthIncome) !== 0;
  const unassignedDetail = detail.filter((d) => d.group === 'unassigned');
  const detailNeedsReview = detail.some((d) => !d.groupConfirmed || d.hasUnresolvedWarning);

  const states = {
    snapshot: pickState({ imported, monthMode, hasMonthActivity: anyMonthActivity }),
    groups: pickState({ imported: expenseLines.length > 0, monthMode, hasMonthActivity: anyMonthActivity }),
    detail: pickState({
      imported: detailLines.length > 0,
      needsReview: detailNeedsReview,
      monthMode,
      hasMonthActivity: anyMonthActivity,
    }),
    income: pickState({ imported: incomeLines.length > 0 || period.ytd_income != null, monthMode, hasMonthActivity: round2(monthIncome) !== 0 }),
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
      ytdIncome,
      annualBudgetedIncome,
      remainingIncomeBudget,
      incomeBudgetUsedPct,
      incomeWorkbookBudget,
      monthIncome,
      ytdExpenses: round2(overallExpenses.actual),
      annualExpenseBudget: round2(overallExpenses.annual),
      remainingAnnualBudget: round2(overallExpenses.remaining),
      expenseBudgetUsedPct: overallExpenses.percentUsed,
      monthExpenses: round2(expTotals.monthActual || n(period.month_expenses)),
      expectedPacePct: pacePct,
      overallVarianceAmount: round2(overallExpenses.varianceToPace),
      overallVariancePct: overallExpenses.variancePct,
      favorable: overallExpenses.varianceToPace > 0,
      onPace: round2(overallExpenses.varianceToPace) === 0,
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
      accounts: cashRows,
    },
    distributions: {
      total: distributionsYtd,
      entitySum: distEntitySum,
      reconciles: distReconciles,
      entities: distEntities,
    },
    savingsDistributions: {
      distributionsYtd,
      savingsIn,
      savingsSpend,
      netSavings,
      savingsInVerified: false,
      savingsSpendVerified: false,
      savingsSpendCategories: savingsSpends.map((s) => ({ id: s.id, category: s.category, ytdAmount: round2(n(s.ytd_amount)) })),
    },
    transfers: { items: transferRows, total: transfersTotal },
    overallExpenses,
    hasUnresolvedWarnings: warnings.hasUnresolved,
    STATUS,
  };
}
