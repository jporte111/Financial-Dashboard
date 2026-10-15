import { fmtCurrency } from './finance.js';

// When the workbook's printed income totals differ from the sum of its lines,
// the printed total is shown and this says so. (A period imported before the
// printed-total rule shows the calculated budget, and says that instead.)
const same = (a, b) => a != null && b != null && Math.round(a * 100) === Math.round(b * 100);
export function incomeNotes(s) {
  const out = [];
  if (s.ytdIncome != null && s.incomeCalculatedYtd != null && !same(s.ytdIncome, s.incomeCalculatedYtd)) {
    out.push(`The workbook does not add up: its income lines total ${fmtCurrency(s.incomeCalculatedYtd)} year to date; the workbook's Total Income of ${fmtCurrency(s.ytdIncome)} is shown.`);
  }
  if (s.annualBudgetedIncome != null && s.incomeCalculatedBudget != null && !same(s.annualBudgetedIncome, s.incomeCalculatedBudget)) {
    out.push(`The workbook does not add up: its income lines' budgets total ${fmtCurrency(s.incomeCalculatedBudget)}; the workbook's annual income budget of ${fmtCurrency(s.annualBudgetedIncome)} is shown.`);
  } else if (s.incomeWorkbookBudget != null && s.annualBudgetedIncome != null && !same(s.incomeWorkbookBudget, s.annualBudgetedIncome)) {
    out.push(`Workbook displayed an annual income budget of ${fmtCurrency(s.incomeWorkbookBudget)}; the independently calculated total ${fmtCurrency(s.annualBudgetedIncome)} is used.`);
  }
  return out;
}
