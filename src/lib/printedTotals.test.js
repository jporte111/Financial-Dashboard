// Printed totals (owner decision, October 2026): when the workbook's printed
// total disagrees with the sum of its rows, the dashboard shows the PRINTED
// total, keeps the calculated one for checking, and warns that the workbook
// does not add up. With no printed total, the calculated one is shown; a blank
// stays missing. Fictional data only.
import { describe, it, expect } from 'vitest';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';
import { buildBvaDashboard } from './bvaDashboard.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { publicPeriod, publicDistribution } from '../../base44/shared/publicDashboardCore.ts';

const confirm = { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF };
function imported(mutate) {
  const parsed = cleanParsed();
  mutate(parsed);
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const plan = planBvaImport({ parsed, validation, confirm });
  const period = { id: 'p', label: 'July 2026', ...plan.periodData, status: 'final', published: true, bva_import_status: 'final' };
  const budgetLines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i}`, period_id: 'p', ...l }));
  const cashAccounts = plan.cashAccounts.toCreate.map((l, i) => ({ id: `c${i}`, period_id: 'p', ...l }));
  const distributions = plan.distributions.toCreate.map((l, i) => ({ id: `d${i}`, period_id: 'p', ...l }));
  const vm = buildBvaDashboard({ period, budgetLines, cashAccounts, distributions });
  return { parsed, validation, plan, period, vm, distributions };
}
const codes = (v) => v.warnings.map((w) => w.code);

describe('a clean workbook: printed and calculated agree, nothing changes', () => {
  it('shows the same figures and raises no "does not add up" warning', () => {
    const { validation, vm } = imported(() => {});
    expect(codes(validation).filter((c) => /mismatch|corrected/.test(c))).toEqual([]);
    expect(vm.cash.total).toBe(vm.cash.calculatedTotal);
    expect(vm.snapshot.ytdIncome).toBe(vm.snapshot.incomeCalculatedYtd);
    expect(vm.snapshot.ytdExpenses).toBe(vm.snapshot.expensesCalculatedYtd);
  });
});

describe('each printed total is shown when the rows do not add up to it', () => {
  it('Total Cash', () => {
    const { validation, vm, period } = imported((p) => { p.cash.reportedTotal = 41000; });
    expect(period.total_cash).toBe(41000);
    expect(vm.cash.total).toBe(41000);
    expect(vm.cash.calculatedTotal).toBe(40000);
    expect(vm.cash.reconciles).toBe(false);
    expect(validation.warnings.find((w) => w.code === 'cash_total_mismatch')).toMatchObject({ sourceValue: 41000, calculatedValue: 40000, blocksFinalize: false });
  });
  it('Total Income', () => {
    const { vm, period } = imported((p) => { p.income.reportedActualTotal = 999; });
    expect(period.ytd_income).toBe(999);
    expect(vm.snapshot.ytdIncome).toBe(999);
    expect(vm.snapshot.incomeCalculatedYtd).not.toBe(999);
  });
  it('Total Expenses and its budget', () => {
    const { vm, period, validation } = imported((p) => { p.expenseSummary.reportedActualTotal = 1; p.expenseSummary.reportedBudgetTotal = 2; });
    expect([period.ytd_expenses, period.annual_budgeted_expenses]).toEqual([1, 2]);
    expect([vm.snapshot.ytdExpenses, vm.snapshot.annualExpenseBudget]).toEqual([1, 2]);
    expect(codes(validation)).toEqual(expect.arrayContaining(['expense_actual_mismatch', 'expense_budget_mismatch']));
  });
  it('Distributions YTD, an entity\'s YTD and a quarter total', () => {
    const { vm, period, validation, distributions } = imported((p) => {
      p.distributions.reportedTotal = 1;
      p.distributions.entities[0].reportedYtd = 2;
      p.distributions.reportedQuarterTotals = { q1: 3 };
    });
    expect(period.distributions_ytd).toBe(1);
    expect(vm.distributions.total).toBe(1);
    expect(distributions[0].workbook_ytd).toBe(2);
    expect(vm.distributions.entities[0]).toMatchObject({ ytd: 2, ytdReconciles: false });
    expect(vm.distributions.printedQuarterTotals).toEqual({ q1: 3 });
    expect(codes(validation)).toEqual(expect.arrayContaining(['distribution_workbook_total_corrected', 'distribution_entity_ytd_mismatch', 'distribution_quarter_total_mismatch']));
  });
});

describe('with no printed total, the calculated total is shown; a blank stays missing', () => {
  it('no printed Total Cash: the sum of the balances', () => {
    const { vm, period } = imported((p) => { p.cash.reportedTotal = null; });
    expect(period.total_cash).toBe(40000);
    expect(vm.cash.total).toBe(40000);
  });
  it('a blank balance and no printed total: Total Cash is missing (never $0.00)', () => {
    const { plan } = imported((p) => { p.cash.reportedTotal = null; p.cash.accounts[0].balance = null; });
    expect(plan.periodWrite.total_cash).toBeUndefined();
    expect(plan.periodWrite.source_missing_fields).toContain('total_cash');
  });
  it('a blank balance with a printed total: the printed total is shown', () => {
    const { vm } = imported((p) => { p.cash.reportedTotal = 39000; p.cash.accounts[0].balance = null; });
    expect(vm.cash.total).toBe(39000);
  });
});

describe('periods stored before the rule are displayed exactly as they were published', () => {
  it('without the printed_totals marker, the calculated totals are shown even when stored totals differ', () => {
    const { period, plan } = imported((p) => { p.cash.reportedTotal = 41000; p.income.reportedActualTotal = 999; p.distributions.entities[0].reportedYtd = 2; p.distributions.reportedQuarterTotals = { q1: 3 }; });
    expect(period.printed_totals).toBe(true);
    const old = { ...period, printed_totals: undefined };
    const budgetLines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i}`, ...l }));
    const cashAccounts = plan.cashAccounts.toCreate.map((l, i) => ({ id: `c${i}`, ...l }));
    const distributions = plan.distributions.toCreate.map((l, i) => ({ id: `d${i}`, ...l }));
    const vm = buildBvaDashboard({ period: old, budgetLines, cashAccounts, distributions });
    expect(vm.cash.total).toBe(40000);
    expect(vm.snapshot.ytdIncome).toBe(vm.snapshot.incomeCalculatedYtd);
    expect(vm.distributions.entities[0].ytd).toBe(vm.distributions.entities[0].ytdCalculated);
    expect(vm.distributions.printedQuarterTotals).toEqual({});
    expect(vm.distributions.printedTotals).toBe(false);
  });
});

describe('the public payload carries the printed figures (numbers only)', () => {
  it('quarter totals and an entity\'s printed YTD', () => {
    expect(publicPeriod({ id: 'p', distribution_quarter_totals: { q1: 5, q2: 'x', bogus: 1 } }).distribution_quarter_totals).toEqual({ q1: 5 });
    expect(publicPeriod({ id: 'p' }).distribution_quarter_totals).toEqual({});
    expect(publicPeriod({ id: 'p', printed_totals: true }).printed_totals).toBe(true);
    expect(publicPeriod({ id: 'p' }).printed_totals).toBe(false);
    expect(publicDistribution({ id: 'd', entity_name: 'Alpha', workbook_ytd: 7 }).workbook_ytd).toBe(7);
    expect(publicDistribution({ id: 'd', entity_name: 'Alpha' }).workbook_ytd).toBe(null);
  });
});
