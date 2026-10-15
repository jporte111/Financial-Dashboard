import { describe, it, expect } from 'vitest';
import {
  getPath,
  setPath,
  applyCorrections,
  isStaleCorrection,
  makeCorrection,
  correctionKey,
  overridesFromCorrections,
  groupMapFromCorrections,
  savingsFromCorrections,
  periodWriteWithCorrections,
  WARNING_SOURCE_PATHS,
} from './bvaCorrections';
import { validateBva } from './bvaValidation';
import { planBvaImport } from './bvaImport';

// A minimal parsed workbook shaped like parseBvaWorkbook() output.
const workbook = () => ({
  meta: { cutoffDate: '2026-08-31', titleText: 'BVA August 2026' },
  parseWarnings: [],
  sections: {
    cash: { status: 'parsed' },
    income: { status: 'parsed' },
    expenseSummary: { status: 'parsed' },
    distributions: { status: 'parsed' },
    detail: { status: 'parsed' },
    transfers: { status: 'parsed' },
  },
  cash: { accounts: [{ name: 'Acct A', balance: 100 }], reportedTotal: 100 },
  income: {
    categories: [{ code: '4040', name: 'Interest Earned', actualYtd: 10, annualBudget: 20 }],
    reportedActualTotal: 10,
    reportedBudgetTotal: 20,
    hasMonthColumn: false,
  },
  expenseSummary: {
    groups: [
      { key: 'fixed', actualYtd: 5, annualBudget: 10 },
      { key: 'variable', actualYtd: 5, annualBudget: 10 },
      { key: 'discretionary', actualYtd: 5, annualBudget: 10 },
    ],
    reportedActualTotal: 15,
    reportedBudgetTotal: 30,
    hasMonthColumn: false,
  },
  distributions: {
    entities: [{ name: 'Alpha', q1: null, q2: null, q3: 100, q4: null, reportedYtd: 100 }],
    reportedTotal: 100,
  },
  transfers: { items: [{ amount: 500, source: 'Acct A', purpose: 'Property Tax' }], reportedTotal: 500 },
  detail: { categories: [{ code: '6120', name: 'Grdng/LANDSCP', actualYtd: 100, annualBudget: 300 }] },
});

const validate = (parsed, opts = {}) =>
  validateBva(parsed, { cutoffDate: '2026-08-31', period: { month: 9, year: 2026 }, ...opts });

const codes = (v) => (v?.warnings || []).map((w) => w.code);

describe('corrections layer over the preserved workbook', () => {
  it('patches values by path without mutating the original', () => {
    const parsed = workbook();
    const out = applyCorrections(parsed, [
      makeCorrection({ kind: 'source', target: 'cash_total_mismatch', path: 'cash.reportedTotal', originalValue: 100, value: 100 }),
    ]);
    expect(getPath(out, 'cash.reportedTotal')).toBe(100);
    expect(getPath(parsed, 'cash.reportedTotal')).toBe(100); // unchanged
  });

  it('later corrections for the same key win', () => {
    const parsed = workbook();
    const out = applyCorrections(parsed, [
      makeCorrection({ kind: 'source', path: 'cash.reportedTotal', originalValue: 100, value: 90 }),
      makeCorrection({ kind: 'source', path: 'cash.reportedTotal', originalValue: 100, value: 100, reason: 'verified' }),
    ]);
    expect(getPath(out, 'cash.reportedTotal')).toBe(100);
    expect(applyCorrections(parsed, []).cash.reportedTotal).toBe(100);
  });

  it('skips a stale correction when the workbook value changed', () => {
    const parsed = workbook();
    const correction = makeCorrection({ kind: 'source', path: 'cash.reportedTotal', originalValue: 100, value: 999 });
    const changed = setPath(parsed, 'cash.reportedTotal', 150);
    expect(applyCorrections(changed, [correction]).cash.reportedTotal).toBe(150); // not applied
    expect(isStaleCorrection(changed, correction)).toBe(true);
    expect(isStaleCorrection(parsed, correction)).toBe(false);
  });

  it('derives override reasons, group map and savings from corrections', () => {
    const corrections = [
      makeCorrection({ kind: 'override', target: 'title_month_mismatch', reason: 'Workbook titled by report month', by: 'a@b.c' }),
      makeCorrection({ kind: 'override', target: 'blank_reason', reason: '   ', by: 'a@b.c' }),
      makeCorrection({ kind: 'group', target: '6120', value: 'fixed', by: 'a@b.c' }),
      makeCorrection({ kind: 'group', target: '6845', value: 'unassigned', by: 'a@b.c' }),
      makeCorrection({ kind: 'savings', target: 'savings_in_ytd', value: 3210.45, by: 'a@b.c' }),
      makeCorrection({ kind: 'savings', target: 'savings_spend_ytd', value: 'oops', by: 'a@b.c' }),
    ];
    expect(overridesFromCorrections(corrections)).toEqual({
      title_month_mismatch: { reason: 'Workbook titled by report month', by: 'a@b.c', at: expect.any(String) },
    });
    expect(groupMapFromCorrections(corrections)).toEqual({ '6120': 'fixed' });
    expect(savingsFromCorrections(corrections)).toEqual({ savings_in_ytd: 3210.45 });
  });

  it('keys corrections by kind + path/target', () => {
    expect(correctionKey({ kind: 'source', path: 'cash.reportedTotal' })).toBe('source:cash.reportedTotal');
    expect(correctionKey({ kind: 'group', target: '6120' })).toBe('group:6120');
    expect(correctionKey({ kind: 'zero_confirm', path: 'distributions.entities.0.q1' })).toBe(
      'zero_confirm:distributions.entities.0.q1'
    );
  });
});

describe('validation re-runs against corrected values', () => {
  it('clears a mismatch once the workbook total is corrected inline', () => {
    const parsed = workbook();
    const bad = setPath(parsed, 'cash.reportedTotal', 150);
    expect(codes(validate(bad))).toContain('cash_total_mismatch');
    const corrected = applyCorrections(bad, [
      makeCorrection({ kind: 'source', path: WARNING_SOURCE_PATHS.cash_total_mismatch, originalValue: 150, value: 100, reason: 'verified' }),
    ]);
    expect(codes(validate(corrected))).not.toContain('cash_total_mismatch');
  });

  it('resolves confirmed-zero distribution quarters and leaves others unverified', () => {
    const parsed = workbook();
    const before = codes(validate(parsed));
    expect(before).toContain('distribution_quarter_blank');
    // Confirm Q1 as $0; Q2 stays blank (unverified).
    const corrected = applyCorrections(parsed, [
      makeCorrection({ kind: 'zero_confirm', target: 'Alpha Q1', path: 'distributions.entities.0.q1', originalValue: null, value: 0, reason: 'No distribution received', by: 'a@b.c' }),
    ]);
    const after = codes(validate(corrected));
    expect(after).toContain('distribution_quarter_blank'); // Q2 still unverified
    expect(validate(corrected).warnings.find((w) => w.code === 'distribution_quarter_blank').message).toContain('Q2');
    expect(validate(corrected).warnings.find((w) => w.code === 'distribution_quarter_blank').message).not.toContain('Q1');
    // Confirm Q2 too: the warning clears entirely.
    const both = applyCorrections(corrected, [
      makeCorrection({ kind: 'zero_confirm', target: 'Alpha Q2', path: 'distributions.entities.0.q2', originalValue: null, value: 0, reason: 'No distribution received', by: 'a@b.c' }),
    ]);
    expect(codes(validate(both))).not.toContain('distribution_quarter_blank');
  });

  it('uses confirmed group mappings for watch-list categories', () => {
    const parsed = workbook();
    expect(validate(parsed).reconciled.detail.categories[0].group).toBe('unassigned');
    const v = validate(parsed, { groupMap: { '6120': 'fixed' } });
    expect(v.reconciled.detail.categories[0].group).toBe('fixed');
    expect(v.reconciled.detail.categories[0].groupConfirmed).toBe(true);
  });

  it('an income total that does not add up is a warning, not a blocker', () => {
    const parsed = setPath(workbook(), 'income.reportedActualTotal', 999);
    expect(codes(validate(parsed))).toContain('income_actual_mismatch');
    expect(validate(parsed).warnings.find((w) => w.code === 'income_actual_mismatch').blocksFinalize).toBe(false);
  });
});

describe('corrections carry through the import plan', () => {
  it('writes corrected child values, savings fields and preserves the original workbook', () => {
    const parsed = workbook();
    const corrections = [
      makeCorrection({ kind: 'group', target: '6120', value: 'fixed', by: 'a@b.c' }),
      makeCorrection({ kind: 'zero_confirm', target: 'Alpha Q1', path: 'distributions.entities.0.q1', originalValue: null, value: 0, reason: 'None received', by: 'a@b.c' }),
      makeCorrection({ kind: 'transfer', target: 'Transfer 1 source', path: 'transfers.items.0.source', originalValue: 'Acct A', value: 'Bank B', reason: 'Corrected in Import Center', by: 'a@b.c' }),
      makeCorrection({ kind: 'savings', target: 'savings_in_ytd', value: 3210.45, by: 'a@b.c' }),
      makeCorrection({ kind: 'override', target: 'title_month_mismatch', reason: 'Titled by report month', by: 'a@b.c' }),
    ];
    const adjusted = applyCorrections(parsed, corrections);
    const validation = validate(adjusted, { groupMap: groupMapFromCorrections(corrections) });
    const plan = planBvaImport({
      parsed: adjusted,
      validation,
      confirm: { month: 9, year: 2026, cutoffDate: '2026-08-31', filename: 'wb.xlsx', importedBy: 'a@b.c' },
      existingPeriods: [],
      existing: {},
      groupMap: groupMapFromCorrections(corrections),
    });

    // Detail group mapping rides into the desired budget line.
    const detail = plan.budgetLines.toCreate.find((l) => l.bva_detail);
    expect(detail.budget_group).toBe('fixed');
    expect(detail.group_confirmed).toBe(true);

    // Confirmed zero is stored as an explicit 0; the still-blank Q2 stays out.
    const dist = plan.distributions.toCreate[0];
    expect(dist.q1).toBe(0);
    expect(dist.q2).toBeUndefined();

    // Corrected transfer label lands on the desired row.
    expect(plan.transfers.toCreate[0].source).toBe('Bank B');

    // Period write: original workbook preserved, savings carried, corrections recorded.
    const write = periodWriteWithCorrections(plan, parsed, corrections);
    expect(write.bva_parsed_source).toBe(parsed);
    expect(write.bva_corrections).toEqual(corrections);
    expect(write.savings_in_ytd).toBe(3210.45);
    expect(write.source_missing_fields).not.toContain('savings_in_ytd');
    expect(write.source_missing_fields).toEqual(expect.arrayContaining(['month_income', 'month_expenses']));
    // Derived totals stay calculated from the corrected primitives.
    expect(plan.periodData.distributions_ytd).toBe(100);
  });
});