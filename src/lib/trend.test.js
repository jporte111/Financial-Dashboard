// Month-over-month trend (Phase 7a/7b): one calculation shared with the month
// view, current published versions only, aligned by data month, gaps never
// zero. Fictional data only.
import { describe, it, expect } from 'vitest';
import { buildTrend } from '../../base44/shared/trendCore.ts';
import { monthFigures } from '../../base44/shared/monthFigures.ts';
import { buildPublicDashboard, buildPublicTrend, publicPeriod, publicBudgetLine, publicCashAccount, publicDistribution, trendReadOptions } from '../../base44/shared/publicDashboardCore.ts';
import { buildBvaDashboard } from './bvaDashboard.js';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';
import { cleanParsed, workbookLikeParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { fakeService } from './__fixtures__/fakeService.js';

const mm = (m) => String(m).padStart(2, '0');
const lines = (k, over = {}) => [
  { id: `i${k}`, category: 'ZZ Income', budget_group: 'income', bva_detail: false, ytd_actual: 1000 * k, annual_budget: 12000, ...over.income },
  { id: `f${k}`, category: 'FIXED', budget_group: 'fixed', bva_detail: false, ytd_actual: 200 * k, annual_budget: 2400, ...over.fixed },
  { id: `v${k}`, category: 'VARIABLE', budget_group: 'variable', bva_detail: false, ytd_actual: 300 * k, annual_budget: 3600, ...over.variable },
  { id: `d${k}`, category: 'DISCRETIONARY', budget_group: 'discretionary', bva_detail: false, ytd_actual: 100 * k, annual_budget: 1200, ...over.discretionary },
];
// A BVA month: report month m, data through the end of m-1 (the convention).
const bva = (m, over = {}) => ({
  id: `b${m}`, label: `Month ${m} 2030`, month: m, year: 2030, legacy: false,
  period: { id: `b${m}`, label: `Month ${m} 2030`, month: m, year: 2030, reporting_cutoff_date: `2030-${mm(m - 1)}-28`, months_elapsed: m - 1, total_cash: 5000 + m, distributions_ytd: 10 * m, annual_budgeted_expenses: 7200, annual_budgeted_income: 12000, printed_totals: true, ytd_income: 1000 * (m - 1), ytd_expenses: 600 * (m - 1), ...over.period },
  lines: over.lines || lines(m - 1, over.line || {}),
  cashAccounts: [{ id: `c${m}`, name: 'ZZ Checking', balance: 5000 + m }],
  distributions: [],
});
// A legacy month: its own month's data, no cutoff or annual budgets.
const legacy = (m, over = {}) => ({
  id: `l${m}`, label: `Month ${m} 2030`, month: m, year: 2030, legacy: true,
  period: { id: `l${m}`, label: `Month ${m} 2030`, month: m, year: 2030, months_elapsed: m, total_cash: 4000 + m, distributions_ytd: 5 * m, ytd_income: 1000 * m, ytd_expenses: 600 * m, ...over.period },
  lines: lines(m, { income: { annual_budget: undefined }, fixed: { annual_budget: undefined }, variable: { annual_budget: undefined }, discretionary: { annual_budget: undefined } }),
  cashAccounts: [{ id: `lc${m}`, name: 'ZZ Checking', balance: 4000 + m }],
  distributions: [],
});

describe('alignment, one point per data month, the later report wins', () => {
  const t = buildTrend([legacy(6), legacy(7), bva(8), bva(9)]);
  it('points are data months, in order; the August report is the July point', () => {
    expect(t.points.map((p) => p.dataMonth)).toEqual(['Jun 2030', 'Jul 2030', 'Aug 2030']);
    expect(t.points[1].reportLabel).toBe('Month 8 2030');
    expect(t.points[1].supersedes).toEqual(['Month 7 2030']);
  });
  it('the superseded legacy snapshot is explained', () => {
    expect(t.explanations).toContainEqual('Jul 2030 data is shown from the Month 8 2030 report (BVA); it supersedes the earlier legacy Month 7 2030 snapshot.');
  });
  it('legacy months are marked and have no pace; BVA months do', () => {
    expect(t.points.map((p) => p.beforeBva)).toEqual([true, false, false]);
    expect(t.points[0].expectedPacePct).toBe(null);
    expect(t.points[0].expenses.pctUsed).toBe(null);
    expect(t.points[1].expectedPacePct).toBeCloseTo(7 / 12);
    expect(t.points[1].expenses.pctUsed).toBeCloseTo(4200 / 7200);
  });
});

describe('missing is a gap, never zero', () => {
  it('a missing figure stays null and is explained; a real 0 stays 0', () => {
    // no printed Total Cash and no balances: cash is unknown (a printed-total
    // month with balances would show their sum instead)
    const sep = { ...bva(9, { period: { total_cash: null, ytd_expenses: 0 }, lines: lines(8, { variable: { ytd_actual: null } }) }), cashAccounts: [] };
    const t = buildTrend([bva(8), sep]);
    const p = t.points[1];
    expect(p.cash).toBe(null);
    expect(p.expenses.ytd).toBe(0);
    expect(p.groups.variable.ytd).toBe(null);
    expect(p.groups.variable.pctUsed).toBe(null);
    expect(t.explanations.some((e) => /never counted as \$0/.test(e))).toBe(true);
    expect(t.cashSinceLast).toBe(null); // one side unknown: no delta
  });
});

describe('budget revisions and cash since the last report', () => {
  it('a revised annual budget is explained against the previous point that had one', () => {
    const t = buildTrend([bva(8), bva(9, { period: { annual_budgeted_expenses: 7300 }, line: { variable: { annual_budget: 3700 } } })]);
    expect(t.explanations.filter((e) => /revised/.test(e))).toEqual(['Annual budget revised in the Month 9 2030 report (Aug 2030 data): expenses, Variable.']);
  });
  it('budgets are not compared across the switch from legacy to BVA reporting', () => {
    const withBudgets = (m) => ({ ...legacy(m), lines: lines(m) }); // a legacy month whose lines carry budgets
    const t = buildTrend([withBudgets(5), withBudgets(6), { ...bva(8), lines: lines(7, { variable: { annual_budget: 9999 } }) }]);
    expect(t.explanations.filter((e) => /revised/.test(e))).toEqual([]);
  });
  it('cash since the previous report', () => {
    expect(buildTrend([bva(8), bva(9)]).cashSinceLast).toEqual({ amount: 1, current: 5009, sinceReport: 'Month 8 2030', sinceDataMonth: 'Jul 2030', toReport: 'Month 9 2030' });
  });
});

describe('year-to-date restarts each year', () => {
  it('only the latest data year is shown', () => {
    const dec = bva(1, { period: { year: 2031, label: 'Month 1 2031', reporting_cutoff_date: '2030-12-31', months_elapsed: 12 } });
    const jan = bva(2, { period: { year: 2031, label: 'Month 2 2031', reporting_cutoff_date: '2031-01-31', months_elapsed: 1 } });
    const t = buildTrend([bva(12), { ...dec, year: 2031, label: 'Month 1 2031' }, { ...jan, year: 2031, label: 'Month 2 2031' }]);
    expect(t.year).toBe(2031);
    expect(t.points.map((p) => p.dataMonth)).toEqual(['Jan 2031']);
  });
});

// ---- the trend equals the month view, for every fixture -----------------------
function imported(parsedFactory, mutate = () => {}) {
  const parsed = parsedFactory();
  mutate(parsed);
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF } });
  const withIds = (rows, k) => rows.map((r, i) => ({ id: `${k}${i}`, period_id: 'p', ...r }));
  return { period: { id: 'p', label: 'July 2026', ...plan.periodData, status: 'final', published: true, bva_import_status: 'final' }, budgetLines: withIds(plan.budgetLines.toCreate, 'l'), cashAccounts: withIds(plan.cashAccounts.toCreate, 'c'), distributions: withIds(plan.distributions.toCreate, 'd') };
}
describe('one calculation: the trend point is exactly what the month page shows', () => {
  const cases = {
    clean: imported(cleanParsed),
    'workbook-like (known defects)': imported(workbookLikeParsed),
    'printed totals differ': imported(cleanParsed, (p) => { p.cash.reportedTotal = 41000; p.income.reportedActualTotal = 999; }),
    'blank balance': imported(cleanParsed, (p) => { p.cash.accounts[0].balance = null; p.cash.reportedTotal = null; }),
  };
  for (const [name, d] of Object.entries(cases)) {
    for (const marker of [true, undefined]) {
      it(`${name}${marker ? '' : ' (stored before the printed-total rule)'}`, () => {
        // Through the public payload, as the client receives it.
        const period = publicPeriod({ ...d.period, printed_totals: marker });
        const pub = { period, budgetLines: d.budgetLines.map(publicBudgetLine), cashAccounts: d.cashAccounts.map(publicCashAccount), distributions: d.distributions.map(publicDistribution) };
        const vm = buildBvaDashboard(pub, { month: false });
        const pt = buildTrend([{ id: 'p', label: 'July 2026', month: 7, year: 2026, legacy: false, period, lines: pub.budgetLines, cashAccounts: pub.cashAccounts, distributions: pub.distributions }]).points[0];
        expect(pt.income.ytd).toBe(vm.snapshot.ytdIncome);
        expect(pt.income.budget).toBe(vm.snapshot.annualBudgetedIncome);
        expect(pt.expenses.ytd).toBe(vm.snapshot.ytdExpenses);
        expect(pt.expenses.budget).toBe(vm.snapshot.annualExpenseBudget);
        expect(pt.cash).toBe(vm.cash.total);
        expect(pt.distributionsYtd).toBe(vm.distributions.total);
        for (const g of vm.groups) {
          expect(pt.groups[g.key].ytd, g.key).toBe(g.ytd.missing ? g.ytd.actual ?? null : g.ytd.actual);
          expect(pt.groups[g.key].budget, g.key).toBe(g.ytd.annual ?? null);
        }
        // the month view's own figures come from the same function
        expect(monthFigures({ period, lines: pub.budgetLines, cashAccounts: pub.cashAccounts, distributions: pub.distributions }).cash.total).toBe(vm.cash.total);
      });
    }
  }
});

// ---- the server: current published versions only; fail closed -----------------
const P = (id, month, extra = {}) => ({ id, label: `Month ${month} 2030`, month, year: 2030, status: 'final', bva_import_status: 'final', published: true, reporting_cutoff_date: `2030-${mm(month - 1)}-28`, months_elapsed: month - 1, total_cash: 100 * month, distributions_ytd: month, ytd_income: month, ytd_expenses: month, ...extra });
const seed = (periods) => ({
  ReportingPeriod: periods,
  BudgetLine: periods.flatMap((p) => lines(p.month).map((l) => ({ ...l, id: `${p.id}-${l.id}`, period_id: p.id }))),
  CashAccount: periods.map((p) => ({ id: `${p.id}-c`, period_id: p.id, name: 'ZZ Checking', balance: 100 * p.month })),
  Distribution: [], RecurringTransfer: [], SavingsSpend: [],
});

describe('publicDashboard trend', () => {
  it('uses only the current published version of each month (no drafts, superseded or discarded versions)', async () => {
    const periods = [
      P('aug', 8), P('sep-old', 9, { published: false, superseded: true, superseded_by: 'sep' }), P('sep', 9, { supersedes: 'sep-old', revision_number: 2 }),
      P('oct-draft', 10, { status: 'draft', bva_import_status: 'draft', published: false }),
      P('sep-x', 9, { status: 'draft', published: false, supersedes: 'sep', revision_number: 3, revision_status: 'discarded' }),
    ];
    const out = await buildPublicDashboard(fakeService(seed(periods)).base44.asServiceRole, {});
    expect(out.trend.points.map((p) => p.reportId)).toEqual(['aug', 'sep']);
  });
  it('a read that keeps failing leaves the trend out (null), never partial; the page is still served', async () => {
    trendReadOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([P('aug', 8), P('sep', 9)]));
    db.base44.asServiceRole.entities.CashAccount.filter = async () => { throw new Error('rate limited'); };
    expect(await buildPublicTrend(db.base44.asServiceRole, [P('aug', 8), P('sep', 9)])).toBe(null);
    trendReadOptions.delaysMs = [300, 800, 1500];
  });
  it('legacy months are marked before BVA reporting', async () => {
    const out = await buildPublicDashboard(fakeService(seed([P('jun', 6, { bva_import_status: undefined, reporting_cutoff_date: undefined, months_elapsed: 6 }), P('aug', 8)])).base44.asServiceRole, {});
    expect(out.trend.points.map((p) => [p.dataMonth, p.beforeBva])).toEqual([['Jun 2030', true], ['Jul 2030', false]]);
  });
});
