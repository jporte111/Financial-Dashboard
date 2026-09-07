import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';
import { buildBvaDashboard, SECTION_STATE } from './bvaDashboard.js';

// A missing / unmapped source value must never render as a confirmed $0.00.
// A source value that really is 0 must still render as $0.00. Every fixture
// here is fully synthetic — no client names or figures.

const CUTOFF = '2026-07-31'; // 7 elapsed months, pace 7/12

// ---------------------------------------------------------------------------
// Parser: a blank "Current Month" column stays null; a populated one is read.
// ---------------------------------------------------------------------------
function workbookBytes({ monthCells }) {
  // monthCells: the three values for the income rows' "Current Month" column
  // and the expense groups' column ('' = blank cell, number = real value).
  const [im1, im2, ex1, ex2, ex3] = monthCells;
  const rows = [];
  rows[0] = ['BVA Sample August 2026'];
  rows[1] = ['CASH', '', '', 'Distributions 2026'];
  rows[2] = ['Current Bank Balances'];
  rows[3] = ['2026-07-31', '', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'];
  rows[4] = ['Checking', 100, '', 'Alpha', 10, 10, 10, '', 30];
  rows[5] = ['Total Cash:', 100, '', 'Total', '', '', '', '', 30];
  rows[6] = [];
  rows[7] = ['INCOME', '', '', 'Budget', 'Remaining', '% of Budget'];
  rows[8] = ['Category', 'Current Month', 'Actual YTD'];
  rows[9] = ['   4000 - Interest', im1, 1, 2];
  rows[10] = ['   4050 - Monthly', im2, 700, 1200];
  rows[11] = ['Total Income', '', 701, 1202];
  rows[12] = [];
  rows[13] = ['EXPENSE', '', '', 'Budget', 'Remaining', '% of Budget', 'Over/Under Budget'];
  rows[14] = ['', 'Current Month', 'Actual YTD'];
  rows[15] = [' 1. FIXED ', ex1, 70, 120];
  rows[16] = [' 2. VARIABLE', ex2, 50, 120];
  rows[17] = [' 3. DISCRETIONARY ', ex3, 95, 120];
  rows[18] = ['Total Expenses', '', 215, 360];
  rows[19] = ['Over/Under Budget', -0.0139, -5];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'June');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('parser: blank current-month column vs a real zero', () => {
  it('a fully blank Current Month column → monthActual null, hasMonthColumn false', () => {
    const p = parseBvaWorkbook(workbookBytes({ monthCells: ['', '', '', '', ''] }));
    expect(p.income.categories.every((c) => c.monthActual == null)).toBe(true);
    expect(p.income.hasMonthColumn).toBe(false);
    expect(p.expenseSummary.groups.every((g) => g.monthActual == null)).toBe(true);
    expect(p.expenseSummary.hasMonthColumn).toBe(false);
  });

  it('a Current Month column filled with zeros → monthActual 0, hasMonthColumn true', () => {
    const p = parseBvaWorkbook(workbookBytes({ monthCells: [0, 0, 0, 0, 0] }));
    expect(p.income.categories.every((c) => c.monthActual === 0)).toBe(true);
    expect(p.income.hasMonthColumn).toBe(true);
    expect(p.expenseSummary.hasMonthColumn).toBe(true);
  });

  it('a partially populated column is read verbatim (blank stays null, value stays value)', () => {
    const p = parseBvaWorkbook(workbookBytes({ monthCells: ['', 250, '', '', ''] }));
    expect(p.income.categories[0].monthActual).toBe(null);
    expect(p.income.categories[1].monthActual).toBe(250);
    expect(p.income.hasMonthColumn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate + plan: the import stores null (not 0) when the workbook has no
// current-month figures, and never invents Savings / Distributions In.
// ---------------------------------------------------------------------------
describe('import planning: missing current-month totals are stored as null', () => {
  const confirm = { month: 7, year: 2026, cutoffDate: CUTOFF, filename: 'x.xlsx', importedBy: 't' };

  it('blank month column → periodData.month_income / month_expenses are null, not 0', () => {
    const parsed = parseBvaWorkbook(workbookBytes({ monthCells: ['', '', '', '', ''] }));
    const v = validateBva(parsed, { cutoffDate: CUTOFF });
    expect(v.reconciled.income.monthActualTotal).toBe(null);
    expect(v.reconciled.expenses.monthActualTotal).toBe(null);
    const plan = planBvaImport({ parsed, validation: v, confirm, existingPeriods: [], existing: {}, groupMap: {} });
    expect(plan.periodData.month_income).toBe(null);
    expect(plan.periodData.month_expenses).toBe(null);
    // every group / income budget line also carries null, not a fabricated 0
    expect(plan.budgetLines.toCreate.every((l) => l.month_actual == null)).toBe(true);
  });

  it('a real zero month column → month_income / month_expenses are 0', () => {
    const parsed = parseBvaWorkbook(workbookBytes({ monthCells: [0, 0, 0, 0, 0] }));
    const v = validateBva(parsed, { cutoffDate: CUTOFF });
    const plan = planBvaImport({ parsed, validation: v, confirm, existingPeriods: [], existing: {}, groupMap: {} });
    expect(plan.periodData.month_income).toBe(0);
    expect(plan.periodData.month_expenses).toBe(0);
  });

  it('never writes Savings / Distributions In or Expenses Paid From Savings (not in the workbook)', () => {
    const parsed = parseBvaWorkbook(workbookBytes({ monthCells: ['', '', '', '', ''] }));
    const v = validateBva(parsed, { cutoffDate: CUTOFF });
    const plan = planBvaImport({ parsed, validation: v, confirm, existingPeriods: [], existing: {}, groupMap: {} });
    expect(Object.prototype.hasOwnProperty.call(plan.periodData, 'savings_in_ytd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plan.periodData, 'savings_spend_ytd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dashboard view model: null → explicit missing state; 0 → "$0.00".
// ---------------------------------------------------------------------------
function period(extra = {}) {
  return {
    id: 'p1', label: 'August 2026', month: 8, year: 2026,
    end_date: '2026-08-31', reporting_cutoff_date: CUTOFF, status: 'draft',
    total_cash: 100000, ytd_income: 70000, ytd_expenses: 90000,
    distributions_ytd: 4000, bva_validation_warnings: [],
    ...extra,
  };
}
const expenseLine = (id, group, month) => ({ id, category: group, budget_group: group, month_actual: month, ytd_actual: 30000, annual_budget: 60000 });
const incomeLine = (id, month) => ({ id, category: id, budget_group: 'income', qb_code: id, month_actual: month, ytd_actual: 20000, annual_budget: 40000 });
function linesWithMonth(month) {
  return [
    expenseLine('f', 'fixed', month), expenseLine('v', 'variable', month), expenseLine('d', 'discretionary', month),
    incomeLine('i1', month), incomeLine('i2', month),
  ];
}

describe('dashboard: current-month income / expenses — missing vs zero', () => {
  it('all month_actual null AND period scalars null → monthIncome / monthExpenses are null', () => {
    const vm = buildBvaDashboard(
      { period: period({ month_income: null, month_expenses: null }), budgetLines: linesWithMonth(null) },
      { month: true }
    );
    expect(vm.snapshot.monthIncome).toBe(null);
    expect(vm.snapshot.monthExpenses).toBe(null);
    expect(vm.snapshot.monthIncomeMissing).toBe(true);
    expect(vm.snapshot.monthExpensesMissing).toBe(true);
    expect(vm.states.snapshot).toBe(SECTION_STATE.MISSING);
    expect(vm.states.income).toBe(SECTION_STATE.MISSING);
  });

  it('all month_actual a real 0 → monthIncome / monthExpenses are 0 (not missing)', () => {
    const vm = buildBvaDashboard({ period: period(), budgetLines: linesWithMonth(0) }, { month: true });
    expect(vm.snapshot.monthIncome).toBe(0);
    expect(vm.snapshot.monthExpenses).toBe(0);
    expect(vm.snapshot.monthIncomeMissing).toBe(false);
    expect(vm.states.snapshot).toBe(SECTION_STATE.NO_MONTH_ACTIVITY);
  });

  it('a real current-month figure flows through unchanged', () => {
    const vm = buildBvaDashboard({ period: period(), budgetLines: linesWithMonth(1500) }, { month: true });
    expect(vm.snapshot.monthIncome).toBe(3000); // 2 income lines * 1500
    expect(vm.snapshot.monthExpenses).toBe(4500); // 3 expense lines * 1500
    expect(vm.snapshot.monthIncomeMissing).toBe(false);
  });

  it('no budget lines, period.month_income is a real 0 → 0, not missing', () => {
    const vm = buildBvaDashboard({ period: period({ month_income: 0, month_expenses: 0 }), budgetLines: [] }, { month: true });
    expect(vm.snapshot.monthIncome).toBe(0);
    expect(vm.snapshot.monthExpenses).toBe(0);
    expect(vm.snapshot.monthIncomeMissing).toBe(false);
  });

  it('YTD-mode income table still exposes the missing flag for the current-month column', () => {
    const vm = buildBvaDashboard(
      { period: period({ month_income: null }), budgetLines: linesWithMonth(null) },
      { month: false }
    );
    expect(vm.snapshot.monthIncomeMissing).toBe(true);
    expect(vm.incomeRows.every((r) => r.monthActual == null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Savings / Distributions In, Expenses Paid From Savings, Net Savings.
// ---------------------------------------------------------------------------
describe('dashboard: savings fields — unverified/missing vs confirmed', () => {
  it('unset scalars → savingsIn / savingsSpend / netSavings all null', () => {
    const vm = buildBvaDashboard({ period: period(), budgetLines: [] });
    expect(vm.savingsDistributions.savingsIn).toBe(null);
    expect(vm.savingsDistributions.savingsSpend).toBe(null);
    expect(vm.savingsDistributions.netSavings).toBe(null);
    expect(vm.savingsDistributions.netSavingsMissing).toBe(true);
  });

  it('only one input present → netSavings still null (not a false $0.00)', () => {
    const vm = buildBvaDashboard({ period: period({ savings_in_ytd: 5000 }), budgetLines: [] });
    expect(vm.savingsDistributions.savingsIn).toBe(5000);
    expect(vm.savingsDistributions.savingsSpend).toBe(null);
    expect(vm.savingsDistributions.netSavings).toBe(null);
  });

  it('both inputs confirmed → netSavings = savingsIn − savingsSpend', () => {
    const vm = buildBvaDashboard({ period: period({ savings_in_ytd: 5000, savings_spend_ytd: 1200 }), budgetLines: [] });
    expect(vm.savingsDistributions.savingsIn).toBe(5000);
    expect(vm.savingsDistributions.savingsSpend).toBe(1200);
    expect(vm.savingsDistributions.netSavings).toBe(3800);
    expect(vm.savingsDistributions.netSavingsMissing).toBe(false);
  });

  it('a confirmed zero is preserved as 0, not treated as missing', () => {
    const vm = buildBvaDashboard({ period: period({ savings_in_ytd: 0, savings_spend_ytd: 0 }), budgetLines: [] });
    expect(vm.savingsDistributions.savingsIn).toBe(0);
    expect(vm.savingsDistributions.savingsSpend).toBe(0);
    expect(vm.savingsDistributions.netSavings).toBe(0);
    expect(vm.savingsDistributions.netSavingsMissing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Distribution zeros are legitimate and must be preserved.
// ---------------------------------------------------------------------------
describe('dashboard: legitimate distribution zeros are kept, not flagged as missing', () => {
  const distributions = [
    // Q4 is 0 for every entity (year is still in Q3); one entity has Q1 & Q2 = 0.
    { id: 'e1', entity_name: 'Alpha', q1: 100, q2: 200, q3: 150, q4: 0 },
    { id: 'e2', entity_name: 'Beta', q1: 0, q2: 0, q3: 500, q4: 0 },
  ];

  it('entity YTD sums its own quarters including the zero quarters', () => {
    const vm = buildBvaDashboard({ period: period({ distributions_ytd: 1450 }), budgetLines: [], distributions });
    const beta = vm.distributions.entities.find((e) => e.name === 'Beta');
    expect(beta.ytd).toBe(500); // 0 + 0 + 500 + 0
    const alpha = vm.distributions.entities.find((e) => e.name === 'Alpha');
    expect(alpha.ytd).toBe(450); // 100 + 200 + 150 + 0
    expect(vm.distributions.entitySum).toBe(950);
  });

  it('the stored Distributions YTD is shown as-is and reconciles against the entity sum', () => {
    const vm = buildBvaDashboard({ period: period({ distributions_ytd: 950 }), budgetLines: [], distributions });
    expect(vm.distributions.total).toBe(950);
    expect(vm.distributions.reconciles).toBe(true);
    expect(vm.states.distributions).not.toBe(SECTION_STATE.MISSING);
  });
});
