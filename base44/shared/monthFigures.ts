// The headline figures one month's dashboard shows -- the single calculation
// shared by the month view (src/lib/bvaDashboard.js) and the month-over-month
// trend (trendCore.ts), so a trend point is always exactly what that month's
// own page shows. Pure; no reads, no writes.
//
// Rules (unchanged from the month view):
//   - Missing is null, never 0. A stored 0 is a real 0.
//   - Periods imported under the printed-total rule (`printed_totals`) show
//     the stored (workbook) totals, falling back to the sum of the rows.
//     Every period stored before it shows exactly what it was published with:
//     the sum of its lines / balances when it has them, else the stored total.
//   - Group (Fixed / Variable / Discretionary) figures are the group summary
//     lines; a group with a missing part has no complete figure (null).
//   - Distributions YTD is the stored total, else the sum of each entity's
//     shown YTD (its printed YTD under the printed-total rule, else the sum of
//     its quarters that have begun by the report's cutoff).

export const EXPENSE_GROUPS = ['fixed', 'variable', 'discretionary'];
const MONTHS_IN_YEAR = 12;
const QUARTERS = ['q1', 'q2', 'q3', 'q4'];
const QUARTER_START: Record<string, number> = { q1: 1, q2: 4, q3: 7, q4: 10 };

export const num = (v: any) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || !Number.isFinite(Number(v)) ? null : Number(v);
const n0 = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const round2 = (v: any) => Math.round((n0(v) + Number.EPSILON) * 100) / 100;
const r2n = (v: any) => (v == null ? null : round2(v));

// Sum of the known values; `complete` is false when any part is missing.
export function known(values: any[]) {
  const vals = values.map(num);
  const present = vals.filter((v) => v != null) as number[];
  return { value: present.length ? round2(present.reduce((a, v) => a + v, 0)) : null, complete: present.length === vals.length };
}

// Elapsed reporting months, as the month view computes them.
export function elapsedMonthsOf(period: any) {
  if (period.months_elapsed != null && period.months_elapsed !== '') return Math.min(Math.max(n0(period.months_elapsed), 0), MONTHS_IN_YEAR);
  const c = period.reporting_cutoff_date || period.end_date;
  if (!c) return 0;
  const d = new Date(c);
  return Number.isNaN(d.getTime()) ? 0 : Math.min(Math.max(d.getUTCMonth() + 1, 0), MONTHS_IN_YEAR);
}

const isDetail = (l: any) => !!(l.bva_detail || l.detail_flag);

// `period` must already have missing fields applied (effectiveRecord, or the
// public payload, which serves them as null).
export function monthFigures({ period, lines = [], cashAccounts = [], distributions = [] }: { period: any; lines?: any[]; cashAccounts?: any[]; distributions?: any[] }) {
  const printedRule = period.printed_totals === true;
  const elapsedMonths = elapsedMonthsOf(period);
  const expenseLines = lines.filter((l) => EXPENSE_GROUPS.includes(l.budget_group) && !isDetail(l));
  const incomeLines = lines.filter((l) => l.budget_group === 'income' && !isDetail(l));

  // Expenses
  const eY = known(expenseLines.map((l) => l.ytd_actual));
  const eB = known(expenseLines.map((l) => l.annual_budget));
  const expensesCalculated = { ytd: expenseLines.length && eY.complete ? eY.value : null, budget: expenseLines.length && eB.complete ? eB.value : null };
  const expenses = printedRule
    ? { ytd: num(period.ytd_expenses) ?? expensesCalculated.ytd, budget: num(period.annual_budgeted_expenses) ?? expensesCalculated.budget }
    : expenseLines.length
      ? { ytd: expensesCalculated.ytd, budget: expensesCalculated.budget }
      : { ytd: num(period.ytd_expenses), budget: num(period.annual_budgeted_expenses) };

  // Income
  const iY = known(incomeLines.map((l) => l.ytd_actual));
  const iB = known(incomeLines.map((l) => l.annual_budget));
  const incomeCalculated = { ytd: incomeLines.length && iY.complete ? iY.value : null, budget: incomeLines.length && iB.complete ? iB.value : null };
  const useStoredIncome = printedRule || !incomeLines.length;
  const income = {
    ytd: useStoredIncome ? r2n(num(period.ytd_income)) ?? incomeCalculated.ytd : incomeCalculated.ytd,
    budget: useStoredIncome ? r2n(num(period.annual_budgeted_income)) ?? incomeCalculated.budget : incomeCalculated.budget,
  };

  // Groups
  const groups: Record<string, { ytd: number | null; budget: number | null; partial: boolean; count: number }> = {};
  for (const g of EXPENSE_GROUPS) {
    const gl = expenseLines.filter((l) => l.budget_group === g);
    const gY = known(gl.map((l) => l.ytd_actual));
    const gB = known(gl.map((l) => l.annual_budget));
    groups[g] = { ytd: gY.complete ? gY.value : null, budget: gB.complete ? gB.value : null, partial: gl.length > 0 && !(gY.complete && gB.complete), count: gl.length };
  }

  // Cash
  const cK = known(cashAccounts.map((a) => r2n(num(a.balance))));
  const cashCalculated = cK.value;
  const cashPartial = cashAccounts.length > 0 && !cK.complete;
  const cashReported = r2n(num(period.total_cash));
  const cash = printedRule
    ? (cashReported != null ? cashReported : cashAccounts.length ? cashCalculated : null)
    : cashAccounts.length ? cashCalculated : cashReported;

  // Distributions
  const cutoffMonth = (() => {
    const c = period.reporting_cutoff_date;
    if (c) { const d = new Date(c); if (!Number.isNaN(d.getTime())) return d.getUTCMonth() + 1; }
    return elapsedMonths || null;
  })();
  const applicable = (q: string) => cutoffMonth == null || cutoffMonth >= QUARTER_START[q];
  const entityYtd = distributions.map((d) => {
    const printed = printedRule ? r2n(num(d.workbook_ytd)) : null;
    if (printed != null) return printed;
    const counted = QUARTERS.filter((q) => r2n(num(d[q])) != null || applicable(q));
    return known(counted.map((q) => r2n(num(d[q])))).value;
  });
  const dK = known(entityYtd);
  const storedDistributions = r2n(num(period.distributions_ytd));
  const distributionsYtd = storedDistributions != null ? storedDistributions : dK.value;

  return {
    printedRule,
    elapsedMonths,
    pacePct: Math.min(Math.max(elapsedMonths, 0), MONTHS_IN_YEAR) / MONTHS_IN_YEAR,
    income,
    incomeCalculated,
    expenses,
    expensesCalculated,
    groups,
    cash: { total: cash, calculated: cashCalculated, reported: cashReported, partial: cashPartial },
    distributions: { ytd: distributionsYtd, entitySum: dK.value, entityYtd },
  };
}
