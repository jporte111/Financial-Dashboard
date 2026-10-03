import { describe, it, expect } from 'vitest';
import { savingsStatus, SAVINGS_STATUS, FLAG } from './bva.js';
import { buildBvaDashboard } from './bvaDashboard.js';

const PERIOD = {
  label: 'September 2026',
  month: 9,
  year: 2026,
  months_elapsed: 8,
  reporting_cutoff_date: '2026-08-31',
  status: 'final',
  published: true,
  bva_import_status: 'final',
  ytd_income: 9000,
  ytd_expenses: 7000,
  annual_budgeted_income: 15000,
  annual_budgeted_expenses: 10000,
};

const SAVINGS_LINE = {
  id: 'sav',
  category: 'MONTHLY SAVINGS',
  qb_code: '8030',
  budget_group: 'savings',
  bva_detail: true,
  group_confirmed: true,
  ytd_actual: 5700,
  annual_budget: 11400,
  month_actual: null,
  drilldown_enabled: true,
};

const FIXED_LINE = {
  id: 'fix',
  category: 'FIXED',
  budget_group: 'fixed',
  bva_detail: true,
  group_confirmed: true,
  ytd_actual: 500,
  annual_budget: 1000,
  month_actual: null,
};

// The non-detail group-summary line that carries the Fixed totals (detail rows
// are never summed into group totals).
const FIXED_GROUP_LINE = {
  id: 'fixg',
  category: 'FIXED',
  budget_group: 'fixed',
  bva_detail: false,
  group_confirmed: true,
  ytd_actual: 7000,
  annual_budget: 10000,
  month_actual: null,
};

const build = () =>
  buildBvaDashboard(
    { period: PERIOD, budgetLines: [SAVINGS_LINE, FIXED_GROUP_LINE, FIXED_LINE], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [] },
    {}
  );

describe('savings target status', () => {
  it('marks below-target savings as below_savings_target, not favorable', () => {
    const c = savingsStatus({ actualYtd: 5700, annualBudget: 11400 }, 8);
    expect(c.status).toBe(SAVINGS_STATUS.BELOW);
    expect(c.expectedYtdBudget).toBe(7600);
    expect(c.varianceToPace).toBe(1900);
  });

  it('marks above-target savings as favorable', () => {
    const c = savingsStatus({ actualYtd: 8550, annualBudget: 11400 }, 8);
    expect(c.status).toBe(SAVINGS_STATUS.ABOVE);
  });

  it('marks on-target savings as on_savings_target', () => {
    const c = savingsStatus({ actualYtd: 7600, annualBudget: 11400 }, 8);
    expect(c.status).toBe(SAVINGS_STATUS.ON);
  });
});

describe('savings in the dashboard view model', () => {
  it('classifies the savings detail row under its own group', () => {
    const row = build().detail.find((d) => d.category === 'MONTHLY SAVINGS');
    expect(row.group).toBe('savings');
    expect(row.groupLabel).toBe('Savings');
    expect(row.groupConfirmed).toBe(true);
    expect(row.ytd.status).toBe(SAVINGS_STATUS.BELOW);
    expect(row.ytd.status).not.toBe('under_pace');
  });

  it('flags below-target savings with the below_savings_target reason', () => {
    const row = build().detail.find((d) => d.category === 'MONTHLY SAVINGS');
    expect(row.flagged).toBe(true);
    expect(row.reasons).toContain(FLAG.SAVINGS_BELOW);
    expect(build().attention.some((d) => d.category === 'MONTHLY SAVINGS')).toBe(true);
  });

  it('never counts savings into expense group totals (no double counting)', () => {
    const vm = build();
    expect(vm.snapshot.ytdExpenses).toBe(7000);
    expect(vm.snapshot.annualExpenseBudget).toBe(10000);
    for (const g of vm.groups) expect(g.key).not.toBe('savings');
  });

  it('keeps savings figures missing, never zero, when not provided', () => {
    const vm = build();
    expect(vm.savingsDistributions.savingsIn).toBeNull();
    expect(vm.savingsDistributions.savingsSpend).toBeNull();
    expect(vm.savingsDistributions.netSavings).toBeNull();
    expect(vm.savingsDistributions.savingsInMissing).toBe(true);
    expect(vm.savingsDistributions.savingsSpendMissing).toBe(true);
  });

  it('still classifies expense detail rows by their confirmed group', () => {
    const vm = build();
    const fixed = vm.detail.find((d) => d.category === 'FIXED');
    expect(fixed.group).toBe('fixed');
    expect(fixed.groupLabel).toBe('Fixed');
  });
});