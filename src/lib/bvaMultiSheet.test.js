import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';

// Multi-sheet and layout-drift parsing. Every name and figure below is
// fictional; only the shapes mirror the layouts the workbook has used:
//   A. one sheet, simplified (no EXPENSE / DETAIL headers, label-first transfers)
//   B. two sheets: summary + a "Detail & Notes" sheet holding the watch list,
//      transfers, an over/under block, off-balance accounts and notes
//   C. one sheet, labelled blocks with column headers on the section row

const book = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, rows, origin] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, origin ? { origin } : undefined), name);
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
};

const META = 'Sample Household | Reporting Cutoff Date: 08/31/2026 | Data through August 31, 2026 (08/31/2026) | USD';
const summaryTop = () => [
  ['BVA September 2026'],
  [META],
  [''],
  ['CASH — Current Bank Balances', '', '', 'Distributions 2026'],
  ['Account', '08/31/2026', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'],
  ['First Checking', 100, '', 'Alpha', 10, 20, 0, '', 30],
  ['Second Savings', 250, '', 'Beta', 5, 5, 5, '', 15],
  ['Total Cash', 350, '', 'Total', 15, 25, 5, 0, 45],
  [''],
  ['INCOME'],
  ['Category', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining', '% of Budget'],
  ['Interest Earned', 1, 7, 12, 5, 0.58],
  ['Monthly Income', 800, 6400, 9600, 3200, 0.67],
  ['Total Income', 801, 6407, 9612, 3205, 0.67],
];
const DETAIL = [
  ['6100', 'Landscaping', 3, 35, 60],
  ['6300', 'Clothing', 0, 70, 60],
  ['8030', 'Monthly Savings', 0, 400, 600],
];
const TRANSFERS = [
  ['Tax Savings', '8030', 500],
  ['Insurance Reserve', '8030', 1500],
  ['Auto Lease', '6400', 750],
];

// Layout B: summary sheet + "Detail & Notes" sheet.
function twoSheet({ extraSheet = null, detailOnBoth = null } = {}) {
  const s1 = [
    ...summaryTop(),
    [''],
    ['EXPENSES'],
    ['Category', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining', '% of Budget'],
    ['FIXED', 10, 720, 1200, 480, 0.6],
    ['VARIABLE', 5, 540, 1200, 660, 0.45],
    ['DISCRETIONARY', 8, 890, 1200, 310, 0.74],
    ['Total Expenses', 23, 2150, 3600, 1450, 0.6],
  ];
  if (detailOnBoth) {
    s1.push([''], ['DETAIL — WATCH LIST'], ['Code', 'Category', 'Current Month', 'Actual YTD', 'Annual Budget']);
    for (const r of detailOnBoth) s1.push(r);
  }
  const s2 = [
    ['DETAIL — WATCH LIST CATEGORIES'],
    [''],
    ['Code', 'Category', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining', '% of Budget', 'YTD Budget Pace', 'Over/Under $ (vs pace)'],
    ...DETAIL.map((r) => [...r, 1, 0.5, 40, -5]),
    [''],
    ['MONTHLY TRANSFERS / RECURRING DEBITS (report month)'],
    [''],
    ['Item', 'QBO Account', 'Current Month Amount'],
    ...TRANSFERS,
    [''],
    ['OVER/UNDER BUDGET (Income − Expenses, Actual YTD vs YTD Budget Pace)'],
    ['Amount', 123],
    ['% of Annual Expense Budget', 0.03],
    [''],
    ["CASH ACCOUNTS OUTSIDE 'TOTAL CASH' (excluded — internal transfers/reserves/claims)"],
    [''],
    ['Account', 'Balance'],
    ['1000 Cash on hand', 20],
    ['1090 Reserve', 900],
    [''],
    ['NOTES'],
    ['Income total excludes distributions.'],
  ];
  const sheets = [['Summary', s1], ['Detail & Notes', s2]];
  if (extraSheet) sheets.push(extraSheet);
  return book(sheets);
}

// Layout A: the same figures on one simplified sheet.
function simplified() {
  const rows = summaryTop();
  rows[10] = ['Category', 'Month Actual', 'Actual YTD', 'Annual Budget'];
  rows.push(['FIXED', 10, 720, 1200], ['VARIABLE', 5, 540, 1200], ['DISCRETIONARY', 8, 890, 1200], ['Total Expenses', 23, 2150, 3600]);
  for (const [code, name, m, y, b] of DETAIL) rows.push([`${code} ${name}`, m, y, b]);
  rows.push(['']);
  // Label-first transfer rows: source, purpose, (blank), amount.
  rows.push(['Acct 8030', 'Tax Savings', '', 500], ['Acct 8030', 'Insurance Reserve', '', 1500], ['Acct 6400', 'Auto Lease', '', 750]);
  return book([['BVA September 2026', rows]]);
}

// Layout C: labelled blocks, headers on the section row, transfers with the
// amount in column D and a note in column F.
function labelledSingle() {
  const rows = summaryTop();
  rows.splice(9, 2, ['INCOME', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining', '% of Budget']);
  rows.push(
    [''],
    ['EXPENSES', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining', '% of Budget', 'Over/Under Budget vs YTD Pace'],
    ['1. FIXED COSTS', 10, 720, 1200, 480, 0.6, 'Over/under amount', '', 12],
    ['2. VARIABLE COSTS', 5, 540, 1200, 660, 0.45, '% of annual budget', '', 0.01],
    ['3. DISCRETIONARY COSTS', 8, 890, 1200, 310, 0.74],
    ['Total Expenses', 23, 2150, 3600, 1450, 0.6],
    [''],
    ['DETAIL — WATCH LIST'],
    ['Category', 'Current Month', 'Actual YTD', 'Annual Budget', 'Remaining'],
    ...DETAIL.map(([c, n, m, y, b]) => [`${c} ${n}`, m, y, b, b - y]),
    [''],
    ['Monthly Transfers / Recurring Debits', '', '', '', '', 'Report Notes'],
    ['Tax Savings', '', '', 500, '', 'a note'],
    ['Insurance Reserve', '', '', 1500],
    ['Auto Lease', '', '', 750],
    [''],
    ['Outside Total Cash — excluded from bank balances'],
    ['1000 Cash on hand', '', '', 20, '1090 Reserve', '', '', '', 900]
  );
  return book([['BVA September 2026', rows]]);
}

const figures = (p) => ({
  cutoff: p.meta.cutoffDate,
  cash: p.cash.accounts.map((a) => [a.name, a.balance]),
  cashTotal: p.cash.reportedTotal,
  dist: p.distributions.entities.map((e) => [e.name, e.q1, e.q2, e.q3, e.q4]),
  distTotal: p.distributions.reportedTotal,
  income: p.income.categories.map((c) => [c.name, c.monthActual, c.actualYtd, c.annualBudget]),
  groups: p.expenseSummary.groups.map((g) => [g.key, g.monthActual, g.actualYtd, g.annualBudget]),
  detail: p.detail.categories.map((d) => [d.code, d.monthActual, d.actualYtd, d.annualBudget]),
  transferAmounts: p.transfers.items.map((t) => t.amount),
});
const codes = (p) => p.parseWarnings.map((w) => w.code);

describe('multi-sheet workbooks: blocks are found by label on every sheet', () => {
  const p = parseBvaWorkbook(twoSheet());

  it('reads the watch list and transfers from the second sheet', () => {
    expect(p.detail.categories.map((d) => d.code)).toEqual(['6100', '6300', '8030']);
    expect(p.detail.categories[1]).toMatchObject({ name: 'Clothing', monthActual: 0, actualYtd: 70, annualBudget: 60 });
    expect(p.transfers.items.map((t) => [t.purpose, t.source, t.amount])).toEqual([
      ['Tax Savings', '8030', 500],
      ['Insurance Reserve', '8030', 1500],
      ['Auto Lease', '6400', 750],
    ]);
    expect(p.sections.detail).toMatchObject({ status: 'parsed', sheet: 1, row: 1 });
    expect(p.sections.transfers).toMatchObject({ status: 'parsed', sheet: 1 });
  });

  it('records where each row came from', () => {
    expect(p.detail.categories[0].src).toEqual({ sheet: 1, row: 4 });
    expect(p.income.categories[0].src).toEqual({ sheet: 0, row: 12 });
  });

  it('reports the additional sheet, and recognizes (without importing) the informational blocks', () => {
    expect(codes(p)).toContain('additional_sheets');
    expect(p.parseWarnings.find((w) => w.code === 'additional_sheets').blocksFinalize).toBe(false);
    expect(p.sections.informational.map((i) => i.type).sort()).toEqual(['cash_outside', 'notes', 'over_under']);
    expect(p.workbook.sheets.every((s) => s.unrecognizedRows.length === 0)).toBe(true);
  });

  it('produces the same financial data as the single-sheet and labelled layouts', () => {
    expect(figures(p)).toEqual(figures(parseBvaWorkbook(simplified())));
    expect(figures(p)).toEqual(figures(parseBvaWorkbook(labelledSingle())));
  });

  it('keeps real zeros as 0 and blank quarters as null', () => {
    expect(p.detail.categories.find((d) => d.code === '8030').monthActual).toBe(0);
    expect(p.distributions.entities[0]).toMatchObject({ q3: 0, q4: null });
  });
});

describe('labelled single-sheet layout (headers on the section row)', () => {
  const p = parseBvaWorkbook(labelledSingle());

  it('reads the cutoff from the "data through" meta line and the cash header', () => {
    expect(p.meta.cutoffDate).toBe('2026-08-31');
    expect(p.meta.cutoffSources.map((c) => c.source)).toEqual(expect.arrayContaining(['meta: data through', 'cash header date']));
  });

  it('keeps the over/under side summary and off-balance accounts as recognized, not-imported blocks', () => {
    expect(p.sections.informational.map((i) => i.type).sort()).toEqual(['cash_outside', 'over_under']);
    expect(p.workbook.sheets[0].unrecognizedRows).toEqual([]);
  });

  it('reads label-first transfers with the amount in column D and ignores the note column', () => {
    expect(p.transfers.items.map((t) => [t.source, t.amount])).toEqual([
      ['Tax Savings', 500],
      ['Insurance Reserve', 1500],
      ['Auto Lease', 750],
    ]);
  });
});

describe('figures outside every recognized section are reported, never dropped silently', () => {
  it('an extra sheet of figures is highlighted for review (named rows; never blocking)', () => {
    const p = parseBvaWorkbook(twoSheet({ extraSheet: ['Scratch', [['Something'], ['Row A', 5, 6], ['Row B', 7, 8]]] }));
    const w = p.parseWarnings.find((x) => x.code === 'unrecognized_content:3');
    expect(w).toMatchObject({ blocksFinalize: false });
    expect(w.message).toContain('rows 2, 3');
    const v = validateBva(p, { cutoffDate: '2026-08-31' });
    expect(v.warnings.map((x) => x.code)).toContain('unrecognized_content:3');
    expect(v.openReconciliations).not.toContain('unrecognized_content:3');
  });

  it('a watch list the parser cannot recognize surfaces as unrecognized figures', () => {
    const rows = [...summaryTop(), ['EXPENSES'], ['Category', 'Current Month', 'Actual YTD', 'Annual Budget'], ['FIXED', 1, 2, 3], ['VARIABLE', 1, 2, 3], ['DISCRETIONARY', 1, 2, 3], ['Total Expenses', 3, 6, 9]];
    const p = parseBvaWorkbook(book([['S', rows], ['Other', [['Spending we watch'], ['Landscaping', 3, 35, 60]]]]));
    expect(p.detail.categories).toEqual([]);
    expect(codes(p)).toContain('unrecognized_content:2');
  });
});

describe('duplicate sections', () => {
  it('identical duplicates are imported once, with a notice', () => {
    const p = parseBvaWorkbook(twoSheet({ detailOnBoth: DETAIL }));
    expect(p.detail.categories).toHaveLength(3);
    expect(codes(p)).toContain('duplicate_section_identical:detail');
    expect(p.sections.detail.count).toBe(2);
  });

  it('conflicting duplicates are neither combined nor chosen between: nothing imported, not overridable', () => {
    const changed = DETAIL.map((r) => (r[0] === '6300' ? ['6300', 'Clothing', 0, 71, 60] : r));
    const p = parseBvaWorkbook(twoSheet({ detailOnBoth: changed }));
    expect(p.detail.categories).toEqual([]);
    expect(p.sections.detail.status).toBe('conflict');
    const w = p.parseWarnings.find((x) => x.code === 'duplicate_section_conflict:detail');
    expect(w).toMatchObject({ blocksFinalize: true, overridable: false });
    const v = validateBva(p, { cutoffDate: '2026-08-31', overrides: { 'duplicate_section_conflict:detail': { reason: 'try' } } });
    expect(v.openReconciliations).toContain('duplicate_section_conflict:detail');
  });
});

describe('robustness', () => {
  it('a sheet shifted wholly to B2 reads the same figures, with true row numbers', () => {
    const rows = [...summaryTop(), ['EXPENSES'], ['Category', 'Current Month', 'Actual YTD', 'Annual Budget'], ['FIXED', 1, 2, 3], ['VARIABLE', 1, 2, 3], ['DISCRETIONARY', 1, 2, 3], ['Total Expenses', 3, 6, 9]];
    const plain = parseBvaWorkbook(book([['S', rows]]));
    const shifted = parseBvaWorkbook(book([['S', rows, 'B2']]));
    expect(figures(shifted)).toEqual(figures(plain));
    expect(shifted.income.categories[0].src.row).toBe(plain.income.categories[0].src.row + 1);
  });

  it('a block whose columns cannot be identified is reported as unparsed and blocks', () => {
    const rows = [...summaryTop(), ['EXPENSES'], ['Category', 'Spent', 'Plan'], ['FIXED', 1, 2]];
    const p = parseBvaWorkbook(book([['S', rows]]));
    expect(p.sections.expenseSummary.status).toBe('unparsed');
    expect(p.parseWarnings.find((w) => w.code === 'section_unparsed:expenseSummary')).toMatchObject({ blocksFinalize: true, overridable: false });
  });

  it('conflicting cutoff dates are not chosen between', () => {
    const rows = summaryTop();
    rows[4] = ['Account', '09/30/2026', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'];
    const p = parseBvaWorkbook(book([['S', rows]]));
    expect(p.meta.cutoffDate).toBe(null);
    expect(p.parseWarnings.find((w) => w.code === 'cutoff_date_conflict')).toMatchObject({ blocksFinalize: true, overridable: false });
  });
});
