// Report wording shared by the client view and the internal report pages, so
// one figure has one name everywhere. Presentation only: every figure comes
// from the view model (src/lib/bvaDashboard.js) unchanged.
import { fmtCurrency, fmtPct, pct100, isMissingNumber } from '@/lib/finance';

export const LABEL = {
  totalCash: 'Total Cash',
  distributionsYtd: 'Distributions (YTD)',
  savingsIn: 'Savings In (incl. distributions)',
  savingsSpend: 'Expenses Paid From Savings',
  netSavings: 'Net Savings',
  incomeYtd: 'Total Income (YTD)',
  expensesYtd: 'Total Expenses (YTD)',
};

// The caption under a missing value (the value itself shows as "—").
export const NOT_PROVIDED = 'Not provided for this report';

// One plain sentence from figures the report already shows, e.g.
// "Through June 30, 9102, spending is $1,200 below expected pace and income is
// at 50.00% of its annual budget (50.00% expected by now)." Parts whose figures are
// missing are left out; with none, there is no sentence.
export function heroTakeaway(vm) {
  if (!vm) return null;
  const s = vm.snapshot || {};
  const parts = [];
  const v = s.overallVarianceAmount;
  if (!isMissingNumber(v)) {
    const r = Math.round(Number(v) * 100) / 100; // "on pace" exactly when the card says so
    parts.push(r === 0 ? 'spending is on expected pace' : `spending is ${fmtCurrency(Math.abs(r), { cents: false })} ${r > 0 ? 'below' : 'above'} expected pace`);
  }
  if (!isMissingNumber(s.incomeBudgetUsedPct) && !isMissingNumber(vm.pacePct)) {
    parts.push(`income is at ${fmtPct(pct100(s.incomeBudgetUsedPct))} of its annual budget (${fmtPct(pct100(vm.pacePct))} expected by now)`);
  }
  if (!parts.length) return null;
  const when = vm.labels?.reportingCutoffDate ? `Through ${vm.labels.reportingCutoffDate}, ` : '';
  const text = `${when}${parts.join(' and ')}.`;
  return when ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
