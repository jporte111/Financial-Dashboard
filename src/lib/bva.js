// BVA calculation core.
//
// Every derived figure the dashboard shows is computed here from primitives
// (Actual YTD, Annual Budget, elapsed reporting months / Current Month). The
// monthly BVA workbook's own formula cells are NOT trusted — see
// src/lib/bvaValidation.js, which recomputes these and compares.
//
// Formulas (from the requirements, authoritative):
//   Remaining               = Annual Budget - Actual YTD
//   Percent Used            = Actual YTD / Annual Budget
//   Expected Pace %         = Elapsed Reporting Months / 12
//   Expected YTD Budget     = Annual Budget * Expected Pace %
//   Variance to Expected Pace = Expected YTD Budget - Actual YTD
//   Variance %              = Expected Pace % - Percent Used
//
// Sign convention for every variance: positive = favorable, negative =
// unfavorable, zero = on pace.

export const MONTHS_IN_YEAR = 12;

export const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// Round to cents the way the display does, so "on pace" means "rounds to $0.00".
export const round2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;

// Elapsed reporting months as a 0..12 integer. Derive from the confirmed
// reporting cutoff date (last day of the reporting month) — never from a
// filename or worksheet tab.
export function elapsedMonthsFromCutoff(cutoffDate) {
  if (!cutoffDate) return 0;
  const d = cutoffDate instanceof Date ? cutoffDate : new Date(cutoffDate);
  if (Number.isNaN(d.getTime())) return 0;
  // A cutoff of 2026-07-31 means seven completed reporting months (Jan..Jul).
  return Math.min(Math.max(d.getUTCMonth() + 1, 0), MONTHS_IN_YEAR);
}

export function expectedPacePct(elapsedMonths) {
  const m = Math.min(Math.max(n(elapsedMonths), 0), MONTHS_IN_YEAR);
  return m / MONTHS_IN_YEAR;
}

// Status vocabulary. These describe pace, not raw budget consumption.
export const STATUS = {
  UNDER: 'under_pace', // favorable
  OVER: 'over_pace', // unfavorable
  ON: 'on_pace',
  EXCEEDED: 'annual_budget_exceeded',
};

export const STATUS_TEXT = {
  [STATUS.UNDER]: 'Under Expected Pace',
  [STATUS.OVER]: 'Over Expected Pace',
  [STATUS.ON]: 'On Pace',
  [STATUS.EXCEEDED]: 'Annual Budget Exceeded',
};

export const STATUS_TOOLTIP =
  'Compares actual year-to-date spending with the portion of the annual budget expected to have been used by this point in the year.';

// Recommended status colors (Tailwind class fragments).
export const STATUS_STYLES = {
  [STATUS.UNDER]: { text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  [STATUS.ON]: { text: 'text-stone-600', bg: 'bg-stone-100', border: 'border-stone-200', bar: 'bg-stone-400', dot: 'bg-stone-400' },
  [STATUS.OVER]: { text: 'text-rose-800', bg: 'bg-rose-50', border: 'border-rose-300', bar: 'bg-rose-500', dot: 'bg-rose-700' },
  [STATUS.EXCEEDED]: { text: 'text-rose-900', bg: 'bg-rose-100', border: 'border-rose-400', bar: 'bg-rose-700', dot: 'bg-rose-900' },
};

// "Annual Budget Exceeded" may appear ONLY when Actual YTD > full Annual Budget.
export function paceStatus({ actualYtd, annualBudget, varianceToPace }) {
  const actual = n(actualYtd);
  const annual = n(annualBudget);
  if (annual > 0 && actual > annual) return STATUS.EXCEEDED;
  const v = round2(varianceToPace);
  if (v === 0) return STATUS.ON;
  return v > 0 ? STATUS.UNDER : STATUS.OVER;
}

export const isFavorable = (varianceAmount) => round2(varianceAmount) > 0;
export const isUnfavorable = (varianceAmount) => round2(varianceAmount) < 0;

// Year-to-date figures for a single line or an aggregated group.
export function computeYtd({ actualYtd, annualBudget }, elapsedMonths) {
  const actual = n(actualYtd);
  const annual = n(annualBudget);
  const pacePct = expectedPacePct(elapsedMonths);
  const remaining = annual - actual;
  const percentUsed = annual !== 0 ? actual / annual : 0;
  const expectedYtdBudget = annual * pacePct;
  const varianceToPace = expectedYtdBudget - actual; // + favorable, - unfavorable
  const variancePct = pacePct - percentUsed; // + favorable, - unfavorable
  return {
    mode: 'ytd',
    actual,
    annual,
    remaining,
    percentUsed,
    pacePct,
    expectedYtdBudget,
    varianceToPace,
    variancePct,
    favorable: varianceToPace > 0,
    status: paceStatus({ actualYtd: actual, annualBudget: annual, varianceToPace }),
  };
}

// Current-month figures. The comparison is the monthly budget / expected
// monthly allocation (an explicitly imported monthly budget when available,
// otherwise Annual Budget / 12). Current Month is never Actual YTD, and a
// blank/zero Current Month stays zero — callers show "$0.00" or
// "No current-month activity imported." rather than substituting YTD.
export function computeMonth({ monthActual, annualBudget, monthlyBudget }) {
  const actual = n(monthActual);
  const annual = n(annualBudget);
  const monthly = monthlyBudget != null && monthlyBudget !== '' ? n(monthlyBudget) : annual / MONTHS_IN_YEAR;
  const remaining = monthly - actual;
  const percentUsed = monthly !== 0 ? actual / monthly : 0;
  const varianceToBudget = monthly - actual; // + favorable, - unfavorable
  const variancePct = monthly !== 0 ? varianceToBudget / monthly : 0;
  return {
    mode: 'month',
    actual,
    monthlyBudget: monthly,
    remaining,
    percentUsed,
    varianceToBudget,
    variancePct,
    favorable: varianceToBudget > 0,
    hasActivity: round2(actual) !== 0,
  };
}

// Dispatch helper mirroring the dashboard's YTD / This Month toggle.
export function computeLine(line, { elapsedMonths = MONTHS_IN_YEAR, month = false } = {}) {
  if (month) {
    return computeMonth({
      monthActual: line.month_actual,
      annualBudget: line.annual_budget,
      monthlyBudget: line.monthly_budget,
    });
  }
  return computeYtd({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, elapsedMonths);
}

// Sum a set of lines, then run the YTD math on the totals.
export function aggregateYtd(lines, elapsedMonths) {
  const totals = (lines || []).reduce(
    (acc, l) => {
      acc.actualYtd += n(l.ytd_actual);
      acc.annualBudget += n(l.annual_budget);
      acc.monthActual += n(l.month_actual);
      return acc;
    },
    { actualYtd: 0, annualBudget: 0, monthActual: 0 }
  );
  return { ...computeYtd(totals, elapsedMonths), monthActual: totals.monthActual, count: (lines || []).length };
}

// Flag reasons for "Categories Needing Attention" / detail status.
export const FLAG = {
  OVER_PACE: 'over_expected_pace',
  EXCEEDED: 'annual_budget_exceeded',
  UNRESOLVED_WARNING: 'unresolved_validation_warning',
};

export const FLAG_TEXT = {
  [FLAG.OVER_PACE]: 'Above expected year-to-date pace',
  [FLAG.EXCEEDED]: 'Actual YTD exceeds the full annual budget',
  [FLAG.UNRESOLVED_WARNING]: 'Imported source data has an unresolved validation warning',
};

// Decide whether a monitored category should be flagged, and why.
export function flagsForCategory({ actualYtd, annualBudget }, elapsedMonths, hasUnresolvedWarning = false) {
  const c = computeYtd({ actualYtd, annualBudget }, elapsedMonths);
  const reasons = [];
  if (c.status === STATUS.EXCEEDED) reasons.push(FLAG.EXCEEDED);
  if (c.varianceToPace < 0 && c.status !== STATUS.EXCEEDED) reasons.push(FLAG.OVER_PACE);
  if (hasUnresolvedWarning) reasons.push(FLAG.UNRESOLVED_WARNING);
  return { computed: c, reasons, flagged: reasons.length > 0 };
}
