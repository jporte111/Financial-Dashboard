import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';

// One test group per documented defect in the simplified (September-style)
// layout fallbacks. All names and figures are fictional.

const book = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
};

// The simplified layout, with hooks to vary the parts under test.
function simplified({ groups, detail, tail, incomeHeader, noTotalExpenses = false, title = 'BVA September 2026' } = {}) {
  const rows = [
    [title],
    ['Sample | Reporting Cutoff Date: 08/31/2026 | Data through August 31, 2026 (08/31/2026) | USD'],
    [''],
    ['CASH — Current Bank Balances', '', '', 'Distributions 2026'],
    ['Account', '08/31/2026', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'],
    ['First Checking', 100, '', 'Alpha', 10, 10, 10, '', 30],
    ['Total Cash', 100, '', 'Total', 10, 10, 10, 0, 30],
    [''],
    ['INCOME'],
    incomeHeader || ['Category', 'Month Actual', 'Actual YTD', 'Annual Budget'],
    ['Interest Earned', 1, 7, 12],
    ['Monthly Income', 800, 6400, 9600],
    ['Total Income', 801, 6407, 9612],
    ...(groups || [['FIXED', 10, 720, 1200], ['VARIABLE', 5, 540, 1200], ['DISCRETIONARY', 8, 890, 1200]]),
    ...(noTotalExpenses ? [] : [['Total Expenses', 23, 2150, 3600]]),
    ...(detail || [['6100 Landscaping', 3, 35, 60], ['6300 Clothing', 7, 70, 60]]),
    [''],
    ...(tail || [['Acct A', 'Tax Savings', '', 500], ['Lease Co', 'Auto', '', 750]]),
  ];
  return parseBvaWorkbook(book(rows));
}

describe('defect 1: blank YTD / budget cells stay missing (never 0)', () => {
  const p = simplified({
    groups: [['FIXED', 10, '', 1200], ['VARIABLE', 5, 540, ''], ['DISCRETIONARY', 8, 890, 1200]],
    detail: [['6100 Landscaping', 3, '', 60], ['6300 Clothing', 7, 70, 60]],
  });

  it('the parser keeps the blanks as null', () => {
    expect(p.expenseSummary.groups[0].actualYtd).toBe(null);
    expect(p.expenseSummary.groups[1].annualBudget).toBe(null);
    expect(p.detail.categories[0].actualYtd).toBe(null);
  });

  it('validation leaves the affected totals missing and blocks, without an override', () => {
    const v = validateBva(p, { cutoffDate: '2026-08-31', overrides: { 'source_value_missing:expenses': { reason: 'x' } } });
    expect(v.reconciled.expenses.actualTotal).toBe(null);
    expect(v.reconciled.expenses.budgetTotal).toBe(null);
    expect(v.reconciled.expenses.groups[0]).toMatchObject({ actual: null, remaining: null, status: null });
    const w = v.warnings.find((x) => x.code === 'source_value_missing:expenses');
    expect(w).toMatchObject({ blocksFinalize: true, overridable: false });
    expect(v.warnings.find((x) => x.code === 'source_value_missing:detail')).toMatchObject({ overridable: false });
  });

  it('the plan writes no null and no 0 for them, and lists the period totals as missing', () => {
    const v = validateBva(p, { cutoffDate: '2026-08-31' });
    const plan = planBvaImport({ parsed: p, validation: v, confirm: { month: 9, year: 2026, cutoffDate: '2026-08-31' } });
    const fixed = plan.budgetLines.toCreate.find((l) => l.budget_group === 'fixed');
    expect('ytd_actual' in fixed).toBe(false);
    expect(plan.periodWrite.ytd_expenses).toBeUndefined();
    expect(plan.periodWrite.source_missing_fields).toEqual(expect.arrayContaining(['ytd_expenses', 'annual_budgeted_expenses']));
  });
});

describe('defect 2: a detail row without an account code does not end the watch list', () => {
  const p = simplified({ detail: [['6100 Landscaping', 3, 35, 60], ['Unnumbered Gifts', 1, 20, 40], ['6300 Clothing', 7, 70, 60]] });

  it('every row is a detail row; the code-less one is flagged; none become transfers', () => {
    expect(p.detail.categories.map((d) => d.name)).toEqual(['Landscaping', 'Unnumbered Gifts', 'Clothing']);
    expect(p.detail.categories[1].code).toBe(null);
    expect(p.parseWarnings.some((w) => w.code.startsWith('detail_code_missing:'))).toBe(true);
    expect(p.transfers.items.map((t) => t.amount)).toEqual([500, 750]);
  });
});

describe('defect 3: the header-less transfer fallback cannot pick up the wrong rows', () => {
  it('without a "Total Expenses" row, no rows are taken as transfers; the loose figures are reported', () => {
    const p = simplified({ noTotalExpenses: true });
    expect(p.transfers.items).toEqual([]);
    expect(p.cash.accounts).toHaveLength(1);
    expect(p.parseWarnings.some((w) => w.code.startsWith('unrecognized_content:'))).toBe(true);
  });

  it('a trailing total row is read as the reported total, not as a transfer', () => {
    const p = simplified({ tail: [['Acct A', 'Tax Savings', '', 500], ['Lease Co', 'Auto', '', 750], ['Total', '', '', 1250]] });
    expect(p.transfers.items.map((t) => t.amount)).toEqual([500, 750]);
    expect(p.transfers.reportedTotal).toBe(1250);
  });
});

describe('defect 4: detail columns come from the header labels, not fixed positions', () => {
  it('an extra column before Month Actual moves every figure with it', () => {
    const p = simplified({
      incomeHeader: ['Category', 'Note', 'Month Actual', 'Actual YTD', 'Annual Budget'],
      groups: [['FIXED', '', 10, 720, 1200], ['VARIABLE', '', 5, 540, 1200], ['DISCRETIONARY', '', 8, 890, 1200]],
      detail: [['6100 Landscaping', 'x', 3, 35, 60]],
      tail: [['Acct A', 'Tax Savings', '', '', 500]],
    });
    expect(p.detail.categories[0]).toMatchObject({ monthActual: 3, actualYtd: 35, annualBudget: 60 });
    expect(p.expenseSummary.groups[0]).toMatchObject({ monthActual: 10, actualYtd: 720, annualBudget: 1200 });
  });
});

describe('defect 5: the header-less expense fallback runs only without an EXPENSE header', () => {
  it('a labelled EXPENSE block with unrecognized group labels stays empty and blocks', () => {
    const rows = [
      ['BVA August 2026'],
      ['CASH', '', '', 'Distributions 2026'],
      ['Current Bank Balances'],
      ['2026-07-31', '', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'],
      ['Checking', 100, '', 'Alpha', 10, 10, 10, '', 30],
      ['Total Cash:', 100, '', 'Total', 10, 10, 10, '', 30],
      ['INCOME', '', '', 'Budget'],
      ['Category', 'Current Month', 'Actual YTD'],
      ['4010 - Interest', '', 1, 2],
      ['Total Income', '', 1, 2],
      ['FIXED', '', 70, 120], // would be picked up by the header-less fallback
      ['EXPENSE', '', '', 'Budget'],
      ['', 'Current Month', 'Actual YTD'],
      ['Housing', '', 70, 120],
      ['Total Expenses', '', 70, 120],
    ];
    const p = parseBvaWorkbook(book(rows));
    expect(p.expenseSummary.groups).toEqual([]);
    expect(p.sections.expenseSummary.status).toBe('empty');
    const v = validateBva(p, { cutoffDate: '2026-07-31' });
    expect(v.openReconciliations).toContain('section_missing:expenseSummary');
  });
});

describe('defect 6: missing-vs-zero in the simplified layout', () => {
  it('a blank Month Actual column is missing (hasMonthColumn false); zeros are real', () => {
    const blank = simplified({
      groups: [['FIXED', '', 720, 1200], ['VARIABLE', '', 540, 1200], ['DISCRETIONARY', '', 890, 1200]],
      detail: [['6100 Landscaping', '', 35, 60]],
    });
    expect(blank.expenseSummary.hasMonthColumn).toBe(false);
    expect(blank.detail.hasMonthColumn).toBe(false);
    const zero = simplified({ groups: [['FIXED', 0, 720, 1200], ['VARIABLE', 0, 540, 1200], ['DISCRETIONARY', 0, 890, 1200]] });
    expect(zero.expenseSummary.hasMonthColumn).toBe(true);
    expect(zero.expenseSummary.groups[0].monthActual).toBe(0);
  });
});

describe('defect 7: title month vs cutoff date', () => {
  // Titled by report month: "BVA September 2026" with data through Aug 31.
  const p = simplified();

  it('the title month is only a suggestion; the cutoff is read separately', () => {
    expect(p.meta.suggestedMonth).toBe(9);
    expect(p.meta.cutoffDate).toBe('2026-08-31');
  });

  it('importing as the report month (cutoff = previous month end) is accepted and stated', () => {
    const v = validateBva(p, { cutoffDate: '2026-08-31', period: { month: 9, year: 2026 } });
    expect(v.warnings.find((w) => w.code === 'period_follows_cutoff_month')).toMatchObject({ blocksFinalize: false });
    expect(v.openReconciliations.filter((c) => /month|cutoff/.test(c))).toEqual([]);
  });

  it('importing into a month the title does not name needs a reason', () => {
    const v = validateBva(p, { cutoffDate: '2026-08-31', period: { month: 8, year: 2026 } });
    expect(v.warnings.find((w) => w.code === 'title_month_mismatch')).toMatchObject({ blocksFinalize: true, overridable: true });
    expect(v.warnings.find((w) => w.code === 'period_is_cutoff_month')).toBeDefined();
  });

  it('a period that is neither the cutoff month nor the month after is refused outright', () => {
    const v = validateBva(p, { cutoffDate: '2026-08-31', period: { month: 11, year: 2026 } });
    expect(v.warnings.find((w) => w.code === 'reporting_month_mismatch')).toMatchObject({ blocksFinalize: true, overridable: false });
  });
});
