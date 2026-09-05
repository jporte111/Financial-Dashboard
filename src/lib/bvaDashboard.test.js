import { describe, it, expect } from 'vitest';
import { buildBvaDashboard, SECTION_STATE } from './bvaDashboard.js';
import { round2 } from './bva.js';

// Fully synthetic fixture. Names and numbers are invented; no client data.
// Reporting period: cutoff 2026-07-31 -> 7 elapsed months, pace = 7/12.
// Expense totals: actual 300,000 / annual 492,000; expected YTD 287,000;
// overall variance -13,000 (-2.64%). Income totals: actual 93,100 / annual
// 159,600 (exactly 58.33% used). Cash totals to 1,000,000.
function baseData() {
  return {
    period: {
      id: 'p1',
      label: 'August 2026', // deliberately not the reporting month
      month: 8,
      year: 2026,
      end_date: '2026-08-31',
      reporting_cutoff_date: '2026-07-31',
      status: 'draft',
      last_updated: '2026-09-03',
      total_cash: 1000000,
      ytd_income: 93100,
      ytd_expenses: 300000,
      month_income: 0,
      month_expenses: 0,
      distributions_ytd: 8000,
      savings_in_ytd: 40000,
      savings_spend_ytd: 15000,
      bva_validation_warnings: [],
    },
    budgetLines: [
      { id: 'f', category: 'Fixed', budget_group: 'fixed', month_actual: 0, ytd_actual: 90000, annual_budget: 144000 },
      { id: 'v', category: 'Variable', budget_group: 'variable', month_actual: 0, ytd_actual: 70000, annual_budget: 168000 },
      { id: 'd', category: 'Discretionary', budget_group: 'discretionary', month_actual: 0, ytd_actual: 140000, annual_budget: 180000 },
      { id: 'i1', category: 'Client Retainer', budget_group: 'income', qb_code: '4010', month_actual: 0, ytd_actual: 87500, annual_budget: 150000 },
      { id: 'i2', category: 'Consulting Fees', budget_group: 'income', qb_code: '4020', month_actual: 0, ytd_actual: 4900, annual_budget: 8400 },
      { id: 'i3', category: 'Interest Income', budget_group: 'income', qb_code: '4000', month_actual: 0, ytd_actual: 700, annual_budget: 1200 },
      { id: 'c1', category: 'Grounds Care', budget_group: 'variable', bva_detail: true, group_confirmed: true, month_actual: 0, ytd_actual: 35000, annual_budget: 60000, qb_code: '8001' },
      { id: 'c2', category: 'Apparel', budget_group: 'discretionary', bva_detail: true, group_confirmed: true, month_actual: 0, ytd_actual: 72000, annual_budget: 60000, qb_code: '8002' },
      { id: 'c3', category: 'Wellness', budget_group: 'discretionary', bva_detail: true, group_confirmed: true, month_actual: 0, ytd_actual: 44000, annual_budget: 60000, qb_code: '8003' },
      { id: 'c4', category: 'Education', budget_group: 'fixed', bva_detail: true, group_confirmed: true, month_actual: 0, ytd_actual: 6000, annual_budget: 60000, qb_code: '8004' },
    ],
    cashAccounts: [
      { id: 'ca1', name: 'Operating Checking', balance: 120000, sort_order: 1, account_type: 'bank' },
      { id: 'ca2', name: 'Reserve Savings', balance: 380000, sort_order: 2, account_type: 'bank' },
      { id: 'ca3', name: 'Money Market', balance: 25000, sort_order: 3, account_type: 'investment' },
      { id: 'ca4', name: 'Brokerage', balance: 475000, sort_order: 4, account_type: 'investment' },
    ],
    distributions: [
      { id: 'e1', entity_name: 'Entity One', q1: 1000, q2: 1000, q3: 1000, q4: 0 },
      { id: 'e2', entity_name: 'Entity Two', q1: 5000, q2: 5000, q3: 0, q4: 0 },
    ],
    transfers: [
      { id: 't1', amount: 500, source: 'Account A', purpose: 'Transfer 1', visible_to_client: true },
      { id: 't2', amount: 1500, source: 'Account A', purpose: 'Transfer 2', visible_to_client: true },
      { id: 't3', amount: 750, source: 'Account B', purpose: 'Transfer 3', visible_to_client: true },
    ],
    savingsSpends: [],
  };
}

describe('headline pace variance is across all expense groups, not discretionary alone (root-cause bug)', () => {
  const vm = buildBvaDashboard(baseData(), { month: false });

  it('overall variance = total expected YTD - total actual YTD', () => {
    expect(vm.snapshot.ytdExpenses).toBe(300000);
    expect(vm.snapshot.annualExpenseBudget).toBe(492000);
    expect(vm.snapshot.remainingAnnualBudget).toBe(192000);
    expect(round2(vm.snapshot.overallVarianceAmount)).toBe(-13000); // 287000 - 300000
    expect(round2(vm.snapshot.overallVariancePct * 100)).toBe(-2.64);
    expect(vm.snapshot.favorable).toBe(false);
  });

  it('is NOT the discretionary group figure', () => {
    const disc = vm.groups.find((g) => g.key === 'discretionary');
    expect(round2(disc.ytd.varianceToPace)).toBe(-35000); // discretionary alone (105000 - 140000)
    expect(vm.snapshot.overallVarianceAmount).not.toBe(round2(disc.ytd.varianceToPace));
  });

  it('snapshot carries every required field', () => {
    const s = vm.snapshot;
    for (const k of [
      'totalCash', 'ytdIncome', 'annualBudgetedIncome', 'remainingIncomeBudget', 'incomeBudgetUsedPct',
      'ytdExpenses', 'annualExpenseBudget', 'remainingAnnualBudget', 'expenseBudgetUsedPct',
      'expectedPacePct', 'overallVarianceAmount', 'overallVariancePct', 'favorable', 'status',
    ]) {
      expect(s[k], k).toBeDefined();
    }
  });

  it('income budget is the independently calculated sum of the lines', () => {
    // 150000 + 8400 + 1200
    expect(vm.snapshot.annualBudgetedIncome).toBe(159600);
    expect(vm.snapshot.ytdIncome).toBe(93100);
    expect(vm.snapshot.remainingIncomeBudget).toBe(66500);
    expect(round2(vm.snapshot.incomeBudgetUsedPct * 100)).toBe(58.33);
  });
});

describe('requirement 17: QuickBooks data cannot influence BVA dashboard figures', () => {
  it('ignores any QuickBooks-shaped input entirely', () => {
    const a = buildBvaDashboard(baseData(), { month: false });
    const withQb = baseData();
    // things a caller might wrongly try to pass through
    withQb.liveAccounts = [{ account_name: 'x', live_ytd: 9_999_999, annual_budget: 1 }];
    withQb.liveRows = [{ category: 'Fixed', live_ytd: 9_999_999 }];
    withQb.quickbooksTransactions = [{ amount: 9_999_999 }];
    withQb.budgetLines = withQb.budgetLines.map((l) => ({ ...l, live_ytd: 9_999_999, quickbooks_actual: 9_999_999 }));
    const b = buildBvaDashboard(withQb, { month: false });
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.groups.map((g) => g.ytd.actual)).toEqual(a.groups.map((g) => g.ytd.actual));
  });
});

describe('This Month vs Year to Date', () => {
  it('YTD mode uses ytd fields and ytd labels', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    expect(vm.mode).toBe('ytd');
    expect(vm.groups[0].view).toBe(vm.groups[0].ytd);
    expect(vm.labels.incomeThrough).toMatch(/Income received through July 2026/);
  });

  it('This Month mode uses month fields; a zero-activity period is flagged, not back-filled with YTD', () => {
    const vm = buildBvaDashboard(baseData(), { month: true });
    expect(vm.mode).toBe('month');
    expect(vm.groups[0].view.mode).toBe('month');
    expect(vm.groups[0].view.actual).toBe(0); // month_actual, not ytd_actual
    expect(vm.states.groups).toBe(SECTION_STATE.NO_MONTH_ACTIVITY);
    expect(vm.snapshot.monthExpenses).toBe(0);
  });

  it('This Month mode with real month activity is OK', () => {
    const d = baseData();
    d.budgetLines = d.budgetLines.map((l) => (l.budget_group === 'fixed' && !l.bva_detail ? { ...l, month_actual: 1234 } : l));
    const vm = buildBvaDashboard(d, { month: true });
    expect(vm.states.groups).toBe(SECTION_STATE.OK);
    expect(vm.groups.find((g) => g.key === 'fixed').view.actual).toBe(1234);
  });
});

describe('section states never show a silent zero', () => {
  it('reports NOT_IMPORTED when no budget lines exist', () => {
    const vm = buildBvaDashboard({ period: { id: 'p', status: 'draft' } }, { month: false });
    expect(vm.states.groups).toBe(SECTION_STATE.NOT_IMPORTED);
    expect(vm.states.detail).toBe(SECTION_STATE.NOT_IMPORTED);
  });

  it('an unconfirmed detail row is Unassigned regardless of any stored budget_group, and drives NEEDS_REVIEW', () => {
    const d = baseData();
    // even with a stale budget_group of 'discretionary', an unconfirmed row is Unassigned
    d.budgetLines.push({
      id: 'x', category: '9999 UNMAPPED', budget_group: 'discretionary', bva_detail: true, group_confirmed: false,
      month_actual: 0, ytd_actual: 100, annual_budget: 200, qb_code: '9999',
    });
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.states.detail).toBe(SECTION_STATE.NEEDS_REVIEW);
    const row = vm.detail.find((r) => r.code === '9999');
    expect(row.group).toBe('unassigned');
    expect(row.groupConfirmed).toBe(false);
    expect(row.groupLabel).toBe('Unassigned');
    expect(vm.unassignedDetailCount).toBe(1);
  });

  it('savings/distributions-in mapping is always NEEDS_REVIEW (unverified) but values preserved', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    expect(vm.states.savings).toBe(SECTION_STATE.NEEDS_REVIEW);
    expect(vm.savingsDistributions.savingsIn).toBe(40000);
    expect(vm.savingsDistributions.savingsSpend).toBe(15000);
    expect(vm.savingsDistributions.netSavings).toBe(25000);
    expect(vm.savingsDistributions.savingsInVerified).toBe(false);
  });
});

describe('cash reconciliation', () => {
  it('sums accounts and matches the reported total', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    expect(vm.cash.calculatedTotal).toBe(1000000);
    expect(vm.cash.reconciles).toBe(true);
    expect(vm.states.cash).toBe(SECTION_STATE.OK);
    expect(vm.cash.accounts[0].asOf).toMatch(/July 31, 2026/);
  });

  it('flags a discrepancy when accounts do not match the reported total', () => {
    const d = baseData();
    d.period.total_cash = 1100000;
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.cash.reconciles).toBe(false);
    expect(vm.states.cash).toBe(SECTION_STATE.DISCREPANCY);
    expect(vm.cash.total).toBe(1000000); // calculated value is shown
  });
});

describe('distributions: dashboard flags drift between the stored total and a fresh entity recompute', () => {
  it('flags a mismatch when the stored period total does not match a live recompute of the Distribution records', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    expect(vm.distributions.total).toBe(8000); // stored on the period (e.g. a stale scalar, or a legacy period)
    expect(vm.distributions.entitySum).toBe(13000); // 3000 + 10000 from quarters, recomputed live
    expect(vm.distributions.reconciles).toBe(false);
    expect(vm.states.distributions).toBe(SECTION_STATE.DISCREPANCY);
  });

  it('shows no discrepancy once the stored total matches the entity-quarter sum (the normal case after import)', () => {
    const d = baseData();
    d.period.distributions_ytd = 13000; // what bvaImport now stores: the calculated entity-quarter sum
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.distributions.total).toBe(13000);
    expect(vm.distributions.entitySum).toBe(13000);
    expect(vm.distributions.reconciles).toBe(true);
    expect(vm.states.distributions).toBe(SECTION_STATE.OK);
  });
});

describe('Categories Needing Attention', () => {
  it('lists flagged detail rows, largest Over Budget dollar variance first', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    const codes = vm.attention.map((a) => a.code);
    // 8002 Apparel (exceeded, ~-37k) is worse than 8003 Wellness (~-9k);
    // 8001 Grounds Care is on pace and 8004 Education is under pace -> not flagged.
    expect(codes).toEqual(['8002', '8003']);
    expect(vm.attention[0].reasons).toContain('annual_budget_exceeded');
  });
});

describe('reporting labels come from the confirmed cutoff, not the filename', () => {
  it('uses July 2026 even though the period label says August', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    expect(vm.labels.displayMonth).toBe('July 2026');
    expect(vm.labels.reportingCutoffDate).toBe('July 31, 2026');
    expect(vm.labels.statusLabel).toBe('Draft');
    expect(vm.elapsedMonths).toBe(7);
  });
});

describe('unmapped DETAIL categories are Unassigned and inert (requirement: no discretionary fallback)', () => {
  // baseData has four confirmed detail rows. Add one unmapped monitored row
  // that, if it leaked into a group, would swing that group hard.
  function withUnmapped() {
    const d = baseData();
    d.budgetLines.push({
      id: 'u1', category: '7777 UNMAPPED BIG', bva_detail: true, group_confirmed: false,
      month_actual: 0, ytd_actual: 500000, annual_budget: 100000, qb_code: '7777',
    });
    return d;
  }

  it('an unmapped row never appears in a Fixed / Variable / Discretionary filter', () => {
    const vm = buildBvaDashboard(withUnmapped(), { month: false });
    for (const g of ['fixed', 'variable', 'discretionary']) {
      expect(vm.detail.filter((x) => x.group === g).some((x) => x.code === '7777')).toBe(false);
    }
  });

  it('an unmapped row appears only under the Unassigned filter', () => {
    const vm = buildBvaDashboard(withUnmapped(), { month: false });
    const unassigned = vm.detail.filter((x) => x.group === 'unassigned');
    expect(unassigned.map((x) => x.code)).toContain('7777');
  });

  it('an unmapped row does NOT alter the Fixed / Variable / Discretionary summary totals', () => {
    const base = buildBvaDashboard(baseData(), { month: false });
    const withU = buildBvaDashboard(withUnmapped(), { month: false });
    expect(withU.groups.map((g) => g.ytd.actual)).toEqual(base.groups.map((g) => g.ytd.actual));
    expect(withU.groups.map((g) => g.ytd.annual)).toEqual(base.groups.map((g) => g.ytd.annual));
    expect(withU.snapshot.ytdExpenses).toBe(base.snapshot.ytdExpenses);
    expect(withU.snapshot.annualExpenseBudget).toBe(base.snapshot.annualExpenseBudget);
    expect(withU.snapshot.overallVarianceAmount).toBe(base.snapshot.overallVarianceAmount);
  });

  it('a confirmed detail row keeps its group and is filterable normally', () => {
    const vm = buildBvaDashboard(baseData(), { month: false });
    const apparel = vm.detail.find((x) => x.code === '8002');
    expect(apparel.group).toBe('discretionary');
    expect(apparel.groupConfirmed).toBe(true);
    expect(vm.detail.filter((x) => x.group === 'discretionary').some((x) => x.code === '8002')).toBe(true);
  });
});

describe('period provenance: legacy vs BVA-validated', () => {
  it('a period with no BVA import is legacy and is not claimed as validated', () => {
    const d = baseData();
    delete d.period.bva_import_status;
    delete d.period.bva_parsed_source;
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.provenance.mode).toBe('legacy');
    expect(vm.provenance.isLegacy).toBe(true);
    expect(vm.provenance.isBvaValidated).toBe(false);
    expect(vm.provenance.label).toMatch(/Legacy period — not validated through BVA import/);
  });

  it('a draft BVA import is not yet validated', () => {
    const d = baseData();
    d.period.bva_import_status = 'draft';
    d.period.bva_parsed_source = { meta: {} };
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.provenance.mode).toBe('bva_draft');
    expect(vm.provenance.isBvaValidated).toBe(false);
  });

  it('a finalized BVA import is BVA-validated with no legacy banner', () => {
    const d = baseData();
    d.period.bva_import_status = 'final';
    const vm = buildBvaDashboard(d, { month: false });
    expect(vm.provenance.mode).toBe('bva_final');
    expect(vm.provenance.isBvaValidated).toBe(true);
    expect(vm.provenance.isLegacy).toBe(false);
    expect(vm.provenance.label).toBe(null);
  });
});
