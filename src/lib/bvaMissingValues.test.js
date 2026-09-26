import { describe, it, expect } from 'vitest';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';
import { totalsWrite } from './periodTotals.js';
import { buildBvaDashboard } from './bvaDashboard.js';
import { effectiveRecord, isSourceMissing, withoutNulls, nextMissingList } from '../../base44/shared/sourceMissing.ts';
import { evaluateFinalize, evaluatePublish, PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { publicPeriod } from '../../base44/shared/publicDashboardCore.ts';

// Missing values without null (Base44 rejects null in number / string fields),
// and the expected-section checks. Fictional figures only.

// Base44 rejects null as a FIELD value. Nulls nested inside a plain JSON
// object / array field (bva_parsed_source, warnings) are accepted -- the
// production September record already stores some.
const topLevelNull = (rec) => Object.values(rec).some((v) => v === null);
const hasNull = (x) => (Array.isArray(x) ? x.some(topLevelNull) : topLevelNull(x));

// A minimal parse in the multi-sheet parser's output shape.
function parsed({ detail = true, transfers = true, groupsYtd = [720, 540, 890], month = true } = {}) {
  const sec = (on) => ({ status: on ? 'parsed' : 'absent', sheet: 0, row: 1, layout: 'labelled' });
  return {
    meta: { titleText: 'BVA September 2026', titleMonth: 9, titleYear: 2026, suggestedMonth: 9, suggestedYear: 2026, cutoffDate: '2026-08-31', cutoffSources: [] },
    cash: { accounts: [{ name: 'Checking', balance: 100 }], reportedTotal: 100 },
    distributions: { entities: [{ name: 'Alpha', q1: 10, q2: 10, q3: null, q4: null, reportedYtd: 20 }], reportedTotal: 20, reportedQuarterTotals: null },
    income: { categories: [{ code: null, name: 'Monthly Income', monthActual: month ? 800 : null, actualYtd: 6400, annualBudget: 9600 }], reportedActualTotal: 6400, reportedBudgetTotal: 9600, hasMonthColumn: month },
    expenseSummary: {
      groups: ['fixed', 'variable', 'discretionary'].map((key, i) => ({ key, name: key.toUpperCase(), monthActual: month ? 10 : null, actualYtd: groupsYtd[i], annualBudget: 1200 })),
      reportedActualTotal: null,
      reportedBudgetTotal: null,
      pacePctProxy: null,
      hasMonthColumn: month,
    },
    detail: { categories: detail ? [{ code: '6100', name: 'Landscaping', monthActual: 0, actualYtd: 35, annualBudget: 60 }] : [], hasMonthColumn: detail },
    transfers: { items: transfers ? [{ amount: 500, source: 'Acct A', purpose: 'Tax Savings' }] : [], reportedTotal: null },
    sections: { cash: sec(true), distributions: sec(true), income: sec(true), expenseSummary: sec(true), detail: sec(detail), transfers: sec(transfers), informational: [] },
    workbook: { sheets: [] },
    parseWarnings: [],
  };
}
const PREVIOUS = { label: 'August 2026', month: 8, year: 2026, cutoffDate: '2026-07-31', detailCodes: ['6100', '6300'], transferCount: 3 };
const v = (p, extra = {}) => validateBva(p, { cutoffDate: '2026-08-31', period: { month: 9, year: 2026 }, ...extra });
const find = (val, code) => val.warnings.find((w) => w.code === code);

describe('expected sections: absent, empty, or missing rows compared with the previous period', () => {
  it('no watch list when the previous period had one blocks (overridable with a reason)', () => {
    const val = v(parsed({ detail: false }), { previous: PREVIOUS });
    expect(find(val, 'detail_section_expected')).toMatchObject({ blocksFinalize: true, overridable: true });
    expect(val.warnings.find((w) => w.code === 'detail_section_expected').message).toContain('2 watch-list categories');
  });

  it('no watch list and none expected is a notice only (a genuinely optional section)', () => {
    const val = v(parsed({ detail: false }), { previous: { ...PREVIOUS, detailCodes: [] } });
    expect(find(val, 'detail_section_absent')).toMatchObject({ blocksFinalize: false });
    expect(find(val, 'detail_section_expected')).toBeUndefined();
  });

  it('a found-but-empty watch list blocks', () => {
    const p = parsed({ detail: false });
    p.sections.detail.status = 'empty';
    expect(find(v(p), 'detail_section_empty')).toMatchObject({ blocksFinalize: true });
  });

  it('watch-list categories present last period but missing now are named', () => {
    const val = v(parsed(), { previous: PREVIOUS });
    expect(find(val, 'detail_rows_missing_vs_prior').message).toContain('6300');
  });

  it('no transfers when the previous period had some blocks; none expected is a notice', () => {
    expect(find(v(parsed({ transfers: false }), { previous: PREVIOUS }), 'transfers_section_expected')).toMatchObject({ blocksFinalize: true });
    expect(find(v(parsed({ transfers: false })), 'transfers_section_absent')).toMatchObject({ blocksFinalize: false });
  });

  it('a transfer row without an amount is a missing value, not $0.00', () => {
    const p = parsed();
    p.transfers.items.push({ amount: null, source: 'Acct B', purpose: 'Insurance' });
    const val = v(p);
    expect(val.reconciled.transfers.total).toBe(null);
    expect(find(val, 'source_value_missing:transfers')).toMatchObject({ overridable: false });
  });

  it('a stored parse from before the multi-sheet parser (no section inventory) is not re-judged for sections', () => {
    const p = parsed({ detail: false });
    delete p.sections;
    expect(v(p, { previous: PREVIOUS }).warnings.some((w) => /section/.test(w.code))).toBe(false);
  });
});

describe('cutoff and reporting convention', () => {
  it('a cutoff that is not a month end needs a reason', () => {
    expect(find(validateBva(parsed(), { cutoffDate: '2026-08-30' }), 'cutoff_not_month_end')).toMatchObject({ blocksFinalize: true, overridable: true });
  });

  it('no cutoff date blocks and cannot be overridden; pace is missing, not zero months', () => {
    const p = parsed();
    p.meta.cutoffDate = null;
    const val = validateBva(p, {});
    expect(val.elapsedMonths).toBe(null);
    expect(find(val, 'cutoff_date_required')).toMatchObject({ overridable: false });
  });

  it('the same cutoff as the previous period, or a changed convention, needs a reason', () => {
    expect(find(v(parsed(), { previous: { ...PREVIOUS, cutoffDate: '2026-08-31' } }), 'cutoff_already_reported')).toMatchObject({ blocksFinalize: true });
    const sameMonth = validateBva(parsed(), { cutoffDate: '2026-08-31', period: { month: 8, year: 2026 }, previous: { ...PREVIOUS, month: 7, year: 2026, cutoffDate: '2026-06-30' } });
    expect(find(sameMonth, 'reporting_convention_changed')).toMatchObject({ blocksFinalize: true });
  });

  it('a blank distribution cell for a quarter that has begun is pointed out (and adds nothing)', () => {
    const val = v(parsed());
    expect(find(val, 'distribution_quarter_blank').message).toContain('Alpha Q3');
    expect(val.reconciled.distributions.entitySum).toBe(20);
    expect(val.reconciled.distributions.entities[0].q3).toBe(null);
  });
});

describe('import plan: never null, never a manufactured 0', () => {
  const confirm = { month: 9, year: 2026, cutoffDate: '2026-08-31' };

  it('a blank month column: the period write has no null and lists the month totals as missing', () => {
    const p = parsed({ month: false });
    const plan = planBvaImport({ parsed: p, validation: v(p), confirm });
    expect(plan.periodData.month_income).toBe(null);
    expect(hasNull(plan.periodWrite)).toBe(false);
    expect(hasNull(plan.budgetLines.toCreate)).toBe(false);
    expect(hasNull(plan.distributions.toCreate)).toBe(false);
    expect(plan.periodWrite.source_missing_fields).toEqual(['month_expenses', 'month_income']);
    expect(plan.budgetLines.toCreate.filter((l) => !l.bva_detail).every((l) => !('month_actual' in l))).toBe(true);
    // The watch-list row's month figure is a real 0 and is kept.
    expect(plan.budgetLines.toCreate.find((l) => l.bva_detail).month_actual).toBe(0);
  });

  it('a real zero is written as 0', () => {
    const p = parsed();
    const plan = planBvaImport({ parsed: p, validation: v(p), confirm });
    expect(plan.budgetLines.toCreate.find((l) => l.qb_code === '6100').month_actual).toBe(0);
    expect(plan.periodWrite.source_missing_fields).toEqual([]);
  });

  it('re-importing an existing draft: a stored value that is now missing is listed as missing on the period', () => {
    const p = parsed({ month: false });
    const match = { id: 'sep', month: 9, year: 2026, month_income: 801, month_expenses: 23, source_missing_fields: ['savings_in_ytd'] };
    const plan = planBvaImport({ parsed: p, validation: v(p), confirm, existingPeriods: [match] });
    expect(plan.action).toBe('update');
    // Fields the import does not own keep their status.
    expect(plan.periodWrite.source_missing_fields).toEqual(['month_expenses', 'month_income', 'savings_in_ytd']);
    expect('month_income' in plan.periodWrite).toBe(false);
  });

  it('...and a child row whose value became missing is replaced, carrying its admin fields', () => {
    const p = parsed({ month: false });
    const existingLine = { id: 'L1', period_id: 'sep', category: 'FIXED', budget_group: 'fixed', bva_detail: false, month_actual: 10, ytd_actual: 700, annual_budget: 1200, internal_notes: 'keep me', created_date: 'x' };
    const plan = planBvaImport({ parsed: p, validation: v(p), confirm, existingPeriods: [{ id: 'sep', month: 9, year: 2026 }], existing: { budgetLines: [existingLine] } });
    expect(plan.budgetLines.toDelete).toContain('L1');
    expect(plan.budgetLines.replaced).toEqual([{ id: 'L1', cleared: ['month_actual'] }]);
    const fresh = plan.budgetLines.toCreate.find((l) => l.budget_group === 'fixed');
    expect(fresh).toMatchObject({ internal_notes: 'keep me', ytd_actual: 720 });
    expect('month_actual' in fresh).toBe(false);
    expect('id' in fresh || 'created_date' in fresh || 'period_id' in fresh).toBe(false);
  });

  it('expense groups match by group, so a renamed group label updates the same line', () => {
    const p = parsed();
    const existingLine = { id: 'L1', category: 'FIXED COSTS', budget_group: 'fixed', bva_detail: false, month_actual: 1, ytd_actual: 1, annual_budget: 1 };
    const plan = planBvaImport({ parsed: p, validation: v(p), confirm, existingPeriods: [{ id: 'sep', month: 9, year: 2026 }], existing: { budgetLines: [existingLine] } });
    expect(plan.budgetLines.toUpdate.map((u) => u.id)).toEqual(['L1']);
    expect(plan.budgetLines.toDelete).toEqual([]);
  });

  it('without a cutoff date, elapsed months are missing (not guessed from the reporting month)', () => {
    const p = parsed();
    p.meta.cutoffDate = null;
    const plan = planBvaImport({ parsed: p, validation: validateBva(p, {}), confirm: { month: 9, year: 2026, cutoffDate: '' } });
    expect(plan.periodData.months_elapsed).toBe(null);
    expect(plan.periodWrite.source_missing_fields).toContain('months_elapsed');
    expect(plan.periodWrite.reporting_cutoff_date).toBe('');
  });
});

describe('the missing-field list is honoured by every reader', () => {
  const period = { id: 'p', month: 9, year: 2026, total_cash: 999, month_income: 5, source_missing_fields: ['total_cash'] };

  it('helpers', () => {
    expect(isSourceMissing(period, 'total_cash')).toBe(true);
    expect(isSourceMissing(period, 'month_income')).toBe(false);
    expect(effectiveRecord(period).total_cash).toBe(null);
    expect(withoutNulls({ a: 0, b: null, c: undefined, d: '' })).toEqual({ a: 0, d: '' });
    expect(nextMissingList({ source_missing_fields: ['x', 'a'] }, ['a', 'b'], { a: 1, b: null })).toEqual(['b', 'x']);
  });

  it('the public period serves a listed field as missing and never serves the list', () => {
    const out = publicPeriod({ ...period, published: true, status: 'final' });
    expect(out.total_cash).toBe(null);
    expect(out.month_income).toBe(5);
    expect('source_missing_fields' in out).toBe(false);
  });

  it('the dashboard model treats a listed field as missing', () => {
    const vm = buildBvaDashboard({ period: { ...period, distributions_ytd: 7, source_missing_fields: ['distributions_ytd'] } });
    expect(vm.savingsDistributions.distributionsYtd ?? null).not.toBe(7);
  });

  it('the publish gate treats a listed required total as missing, and cannot be talked out of it', () => {
    const p = { ...period, label: 'September 2026', status: 'final', published: false, bva_import_status: 'final', finalized_at: 't', reporting_cutoff_date: '2026-08-31', months_elapsed: 8, ytd_income: 1, ytd_expenses: 1, annual_budgeted_income: 1, annual_budgeted_expenses: 1, distributions_ytd: 0, checklist: Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true])) };
    const codes = evaluatePublish(p, []).blockers.map((b) => b.code);
    expect(codes).toContain('required_value_missing:total_cash');
  });
});

describe('publish gate additions', () => {
  const base = { id: 'p', label: 'September 2026', month: 9, year: 2026, status: 'draft', published: false, bva_import_status: 'draft', bva_parsed_source: {}, reporting_cutoff_date: '2026-08-31', months_elapsed: 8, total_cash: 1, ytd_income: 1, ytd_expenses: 1, annual_budgeted_income: 1, annual_budgeted_expenses: 1, distributions_ytd: 0 };
  const lines = ['fixed', 'variable', 'discretionary', 'income'].map((g, i) => ({ id: `s${i}`, budget_group: g, bva_detail: false, group_confirmed: true, ytd_actual: 1, annual_budget: 2, category: g }));
  const codes = (r) => r.blockers.map((b) => b.code);

  it('a stored non-overridable warning cannot be cleared with a reason', () => {
    const p = { ...base, bva_validation_warnings: [{ code: 'duplicate_section_conflict:detail', blocksFinalize: true, overridable: false, message: 'm' }] };
    const r = evaluateFinalize(p, lines, { 'open_reconciliation:duplicate_section_conflict:detail': { reason: 'please' } });
    expect(codes(r)).toContain('open_reconciliation:duplicate_section_conflict:detail');
    expect(r.blockers.find((b) => b.code.startsWith('open_reconciliation:')).overridable).toBe(false);
  });

  it('a reporting month two months after the cutoff is refused', () => {
    expect(codes(evaluateFinalize({ ...base, month: 10, months_elapsed: 8 }, lines))).toContain('cutoff_period_mismatch');
    expect(codes(evaluateFinalize(base, lines))).not.toContain('cutoff_period_mismatch');
  });

  it('a watch-list row with only one of YTD / budget blocks; one with neither does not', () => {
    const half = { id: 'd1', bva_detail: true, budget_group: 'variable', group_confirmed: true, ytd_actual: 5, category: 'Half' };
    const none = { id: 'd2', bva_detail: true, budget_group: 'variable', group_confirmed: true, category: 'None' };
    const c = codes(evaluateFinalize(base, [...lines, half, none]));
    expect(c).toContain('required_line_value_missing:d1:annual_budget');
    expect(c.some((x) => x.includes(':d2:'))).toBe(false);
  });
});

describe('Admin monthly totals: blank = missing, never null or 0', () => {
  const period = { id: 'p', total_cash: 10, savings_in_ytd: 4, source_missing_fields: [] };

  it('a blank input is left out of the write and listed as missing', () => {
    const w = totalsWrite(period, { total_cash: '12.5', savings_in_ytd: '', months_elapsed: 8 }, '2026-09-26');
    expect(hasNull(w.data)).toBe(false);
    expect(w.data.total_cash).toBe(12.5);
    expect('savings_in_ytd' in w.data).toBe(false);
    expect(w.data.source_missing_fields).toContain('savings_in_ytd');
    expect(w.data.last_updated).toBe('2026-09-26');
  });

  it('entering a value takes the field off the list; 0 is a real value', () => {
    const w = totalsWrite({ ...period, source_missing_fields: ['savings_in_ytd'] }, { savings_in_ytd: '0' });
    expect(w.data.savings_in_ytd).toBe(0);
    expect(w.data.source_missing_fields).not.toContain('savings_in_ytd');
  });

  it('a non-number is refused', () => {
    expect(totalsWrite(period, { total_cash: 'abc' }).error).toContain('Total Cash');
  });
});
