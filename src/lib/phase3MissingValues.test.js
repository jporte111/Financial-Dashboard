import { describe, it, expect } from 'vitest';
import { fmtCurrency, fmtPct, fmtVariance, fmtSignedPct, pct100, numericInput, MISSING_TEXT } from './finance.js';
import { buildBvaDashboard, SECTION_STATE, QUARTER_STATE } from './bvaDashboard.js';
import { publicBudgetLine, publicCashAccount, publicDistribution, publicTransfers, publicSavingsSpend } from '../../base44/shared/publicDashboardCore.ts';

// Phase 3 — missing values on screen. Fictional figures only.
//   missing (unknown)         -> null / "—" / "Source value missing"
//   explicit, confirmed zero  -> 0 / "$0.00"
//   not-yet-applicable quarter -> "—" with context (from the REPORT's cutoff)
//   incomplete totals          -> flagged partial, never presented as complete

describe('formatters', () => {
  it('render missing as "—" and a real zero as $0.00 / 0.00%', () => {
    for (const v of [null, undefined, '', 'abc', NaN]) {
      expect(fmtCurrency(v)).toBe(MISSING_TEXT);
      expect(fmtPct(v)).toBe(MISSING_TEXT);
      expect(fmtVariance(v)).toBe(MISSING_TEXT);
      expect(fmtSignedPct(v)).toBe(MISSING_TEXT);
    }
    expect(fmtCurrency(0)).toBe('$0.00');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtCurrency(1234.5)).toBe('$1,234.50');
  });

  it('pct100 keeps a missing ratio missing (null * 100 would be 0)', () => {
    expect(pct100(null)).toBe(null);
    expect(pct100(0)).toBe(0);
    expect(pct100(0.25)).toBe(25);
  });

  it('numericInput: blank / invalid -> null (write nothing); 0 is a value', () => {
    expect(numericInput('')).toBe(null);
    expect(numericInput('  ')).toBe(null);
    expect(numericInput('x')).toBe(null);
    expect(numericInput('0')).toBe(0);
    expect(numericInput('12.5')).toBe(12.5);
  });
});

describe('public output keeps missing values unknown', () => {
  it('missing figures are served as null; stored zeros as 0', () => {
    expect(publicBudgetLine({ id: 'l', month_actual: null, ytd_actual: 10, annual_budget: 0 })).toMatchObject({ month_actual: null, ytd_actual: 10, annual_budget: 0 });
    expect(publicBudgetLine({ id: 'l' })).toMatchObject({ month_actual: null, ytd_actual: null, annual_budget: null });
    expect(publicCashAccount({ id: 'c', name: 'Acct A' }).balance).toBe(null);
    expect(publicCashAccount({ id: 'c', name: 'Acct A', balance: 0 }).balance).toBe(0);
    expect(publicDistribution({ id: 'd', entity_name: 'Alpha', q1: 5, q2: 0, q3: null })).toMatchObject({ q1: 5, q2: 0, q3: null, q4: null });
    expect(publicSavingsSpend({ id: 's', category: 'x' }).ytd_amount).toBe(null);
    expect(publicTransfers([{ id: 't', source: 'Acct A', purpose: 'Reserve' }])[0].amount).toBe(null);
    expect(publicCashAccount({ id: 'c', balance: '' }).balance).toBe(null); // a blank is not 0
  });
});

const PERIOD = {
  id: 'p', label: 'September 2026', month: 9, year: 2026, months_elapsed: 8, reporting_cutoff_date: '2026-08-31',
  status: 'final', published: true, bva_import_status: 'final', total_cash: 300, distributions_ytd: 45,
};
const line = (id, group, ytd, annual, month, extra = {}) => ({ id, category: id, budget_group: group, bva_detail: false, group_confirmed: true, ytd_actual: ytd, annual_budget: annual, month_actual: month, ...extra });
const build = (over = {}, opts = {}) =>
  buildBvaDashboard(
    {
      period: { ...PERIOD, ...(over.period || {}) },
      budgetLines: over.lines || [line('inc', 'income', 6000, 9000, null), line('fix', 'fixed', 700, 1200, null), line('var', 'variable', 500, 1200, null), line('dis', 'discretionary', 300, 600, null)],
      cashAccounts: over.cash || [],
      distributions: over.dist || [],
      transfers: over.transfers || [],
      savingsSpends: [],
    },
    opts
  );

describe('current month: missing vs partial vs zero', () => {
  it('no line carries a month figure -> missing everywhere (the live September case), never $0.00', () => {
    const vm = build({}, { month: true });
    expect(vm.snapshot.monthIncome).toBe(null);
    expect(vm.snapshot.monthExpenses).toBe(null);
    expect(vm.states.snapshot).toBe(SECTION_STATE.MISSING);
    expect(vm.states.groups).toBe(SECTION_STATE.MISSING);
    expect(vm.states.income).toBe(SECTION_STATE.MISSING);
    for (const g of vm.groups) {
      expect(g.monthActual).toBe(null);
      expect(g.month.missing).toBe(true);
      expect(g.month.actual).toBe(null);
    }
    expect(vm.incomeRows[0].monthActual).toBe(null);
  });

  it('some lines missing -> a known value flagged partial', () => {
    const vm = build({ lines: [line('inc', 'income', 6000, 9000, 800), line('fix', 'fixed', 700, 1200, 60), line('var', 'variable', 500, 1200, null), line('dis', 'discretionary', 300, 600, 25)] }, { month: true });
    expect(vm.snapshot.monthExpenses).toBe(85);
    expect(vm.snapshot.monthExpensesPartial).toBe(true);
    expect(vm.snapshot.monthIncomePartial).toBe(false);
    expect(vm.groups.find((g) => g.key === 'variable').month.missing).toBe(true);
  });

  it('explicit zeros -> $0 with "no current-month activity", not missing', () => {
    const vm = build({ lines: [line('inc', 'income', 6000, 9000, 0), line('fix', 'fixed', 700, 1200, 0), line('var', 'variable', 500, 1200, 0), line('dis', 'discretionary', 300, 600, 0)] }, { month: true });
    expect(vm.snapshot.monthIncome).toBe(0);
    expect(vm.snapshot.monthExpenses).toBe(0);
    expect(vm.snapshot.monthExpensesPartial).toBe(false);
    expect(vm.states.snapshot).toBe(SECTION_STATE.NO_MONTH_ACTIVITY);
  });
});

describe('distribution quarters use the report cutoff, not today', () => {
  const dist = [
    { id: 'a', entity_name: 'Alpha', q1: 10, q2: 0, q3: 20, q4: null },
    { id: 'b', entity_name: 'Beta', q1: 5, q2: 5, q3: null, q4: null },
  ];

  it('cutoff Aug 31: Q4 not yet applicable; a blank Q3 is missing and makes the total partial; a stored 0 is confirmed', () => {
    const d = build({ dist }).distributions;
    expect(d.quarterApplicable).toEqual({ q1: true, q2: true, q3: true, q4: false });
    const [a, b] = d.entities;
    expect(a.quarterState).toEqual({ q1: QUARTER_STATE.VALUE, q2: QUARTER_STATE.VALUE, q3: QUARTER_STATE.VALUE, q4: QUARTER_STATE.NOT_YET });
    expect(a.q2).toBe(0);
    expect(a.ytd).toBe(30);
    expect(a.ytdPartial).toBe(false); // Q4 not yet applicable does not make it partial
    expect(b.quarterState.q3).toBe(QUARTER_STATE.MISSING);
    expect(b.ytd).toBe(10);
    expect(b.ytdPartial).toBe(true);
    expect(d.partial).toBe(true);
    expect(d.reconciles).toBe(null); // a partial recompute cannot confirm the stored total
  });

  it('a December cutoff makes Q4 applicable: a blank Q4 is then missing', () => {
    const d = build({ dist, period: { reporting_cutoff_date: '2026-12-31', months_elapsed: 12 } }).distributions;
    expect(d.quarterApplicable.q4).toBe(true);
    expect(d.entities[0].quarterState.q4).toBe(QUARTER_STATE.MISSING);
  });

  it('does not depend on the current date', () => {
    const a = JSON.stringify(build({ dist }).distributions);
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2030-12-31T00:00:00Z'])); } static now() { return new RealDate('2030-12-31').getTime(); } };
    try { expect(JSON.stringify(build({ dist }).distributions)).toBe(a); } finally { globalThis.Date = RealDate; }
  });
});

describe('partial totals are labelled, never complete', () => {
  it('cash: a missing balance is missing and the total is partial (no reconciliation claim)', () => {
    const vm = build({ cash: [{ id: 'c1', name: 'Acct A', balance: 100, sort_order: 1 }, { id: 'c2', name: 'Acct B', sort_order: 2 }] });
    expect(vm.cash.accounts[1].balance).toBe(null);
    expect(vm.cash.total).toBe(100);
    expect(vm.cash.partial).toBe(true);
    expect(vm.cash.reconciles).toBe(null);
  });

  it('transfers: a missing amount is missing and the total is partial', () => {
    const vm = build({ transfers: [{ id: 't1', amount: 500, source: 'Acct A', purpose: 'Reserve' }, { id: 't2', source: 'Acct B', purpose: 'Lease' }] });
    expect(vm.transfers.items[1].amount).toBe(null);
    expect(vm.transfers.total).toBe(500);
    expect(vm.transfers.partial).toBe(true);
  });

  it('a group with a missing YTD figure shows no pace comparison (missing), not a $0 one', () => {
    const vm = build({ lines: [line('inc', 'income', 6000, 9000, null), line('fix', 'fixed', null, 1200, null), line('var', 'variable', 500, 1200, null), line('dis', 'discretionary', 300, 600, null)] });
    const fixed = vm.groups.find((g) => g.key === 'fixed');
    expect(fixed.ytd.missing).toBe(true);
    expect(fixed.ytd.partial).toBe(true);
    expect(fixed.ytd.varianceToPace).toBe(null);
    expect(vm.snapshot.ytdExpenses).toBe(null); // overall total is incomplete
  });
});

describe('legacy period without stored annual budgets', () => {
  it('shows the budget figures as missing, not $0.00 / 0%', () => {
    const vm = buildBvaDashboard({ period: { id: 'j', label: 'January 2026', month: 1, year: 2026, months_elapsed: 1, ytd_income: 500, ytd_expenses: 400, status: 'final', published: true }, budgetLines: [] });
    expect(vm.snapshot.annualBudgetedIncome).toBe(null);
    expect(vm.snapshot.annualBudgetedIncomeMissing).toBe(true);
    expect(vm.snapshot.incomeBudgetUsedPct).toBe(null);
    expect(vm.snapshot.remainingIncomeBudget).toBe(null);
    expect(vm.snapshot.annualExpenseBudget).toBe(null);
    expect(vm.snapshot.overallVarianceAmount).toBe(null);
    expect(vm.snapshot.ytdIncome).toBe(500);
  });
});
