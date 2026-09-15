import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';

// Mirrors the simplified September 2026 workbook layout:
//   - cutoff date in a meta line ("Reporting Cutoff Date: ..."),
//   - "Month Actual" / "Annual Budget" sub-headers instead of
//     "Current Month" / header-row "Budget",
//   - no EXPENSE or DETAIL section headers — bare FIXED / VARIABLE /
//     DISCRETIONARY rows and code-prefixed detail rows sit directly under
//     the income table,
//   - headerless recurring-transfer rows with the amount in the last column.
// All names and numbers are fabricated; only the shape mirrors the real file.
function buildSimplifiedWorkbook() {
  const rows = [];
  rows[0] = ['BVA October 2026'];
  rows[1] = ['Sample Client | Reporting Cutoff Date: 09/30/2026 | Data through September 30, 2026 (09/30/2026) | USD'];
  rows[2] = [''];
  rows[3] = ['CASH — Current Bank Balances', '', '', 'Distributions 2026'];
  rows[4] = ['Account', '09/30/2026', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'];
  rows[5] = ['First Checking', 100, '', 'Alpha', 10, 10, 10, 0, 30];
  rows[6] = ['Second Savings', 250, '', 'Total', 10, 10, 10, 0, 30];
  rows[7] = ['Total Cash', 350];
  rows[8] = [''];
  rows[9] = ['INCOME'];
  rows[10] = ['Category', 'Month Actual', 'Actual YTD', 'Annual Budget'];
  rows[11] = ['Interest Earned', 1, 7, 12];
  rows[12] = ['Monthly Income', 800, 7200, 12000];
  rows[13] = ['Total Income', 801, 7207, 12012];
  rows[14] = ['FIXED', 10, 720, 1200];
  rows[15] = ['VARIABLE', 5, 540, 1200];
  rows[16] = ['DISCRETIONARY', 8, 890, 1200];
  rows[17] = ['Total Expenses', 23, 2150, 3600];
  rows[18] = ['6100 Landscaping', 3, 35, 60];
  rows[19] = ['6300 Clothing', 7, 70, 60];
  rows[20] = [''];
  rows[21] = ['Acct A', 'Tax Savings', '', 500];
  rows[22] = ['Acct A', 'Insurance', '', 1500];
  rows[23] = ['Lease Co', 'Auto', '', 750];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('parseBvaWorkbook (simplified September-style layout)', () => {
  const parsed = parseBvaWorkbook(buildSimplifiedWorkbook());

  it('reads the cutoff date from the meta line when it is not under the cash header', () => {
    expect(parsed.meta.cutoffDate).toBe('2026-09-30');
    expect(parsed.parseWarnings.find((w) => w.code === 'cutoff_date_missing')).toBeUndefined();
  });

  it('parses income categories with the Annual Budget column and Month Actual figures', () => {
    expect(parsed.income.categories.map((c) => c.name)).toEqual(['Interest Earned', 'Monthly Income']);
    expect(parsed.income.categories[0]).toMatchObject({ code: null, monthActual: 1, actualYtd: 7, annualBudget: 12 });
    expect(parsed.income.categories[1]).toMatchObject({ monthActual: 800, actualYtd: 7200, annualBudget: 12000 });
    expect(parsed.income.reportedActualTotal).toBe(7207);
    expect(parsed.income.reportedBudgetTotal).toBe(12012);
    expect(parsed.income.hasMonthColumn).toBe(true);
  });

  it('derives the pace proxy from the Monthly income line', () => {
    expect(parsed.expenseSummary.pacePctProxy).toBe(7200 / 12000);
  });

  it('recognizes bare FIXED / VARIABLE / DISCRETIONARY rows without an EXPENSE header', () => {
    expect(parsed.expenseSummary.groups.map((g) => g.key)).toEqual(['fixed', 'variable', 'discretionary']);
    expect(parsed.expenseSummary.groups[0]).toMatchObject({ monthActual: 10, actualYtd: 720, annualBudget: 1200 });
    expect(parsed.expenseSummary.reportedActualTotal).toBe(2150);
    expect(parsed.expenseSummary.reportedBudgetTotal).toBe(3600);
  });

  it('treats code-prefixed rows after Total Expenses as monitored detail categories', () => {
    expect(parsed.detail.categories.map((d) => d.code)).toEqual(['6100', '6300']);
    expect(parsed.detail.categories[1]).toMatchObject({
      code: '6300',
      name: 'Clothing',
      group: 'unassigned',
      groupConfirmed: false,
      monthActual: 7,
      actualYtd: 70,
      annualBudget: 60,
    });
  });

  it('parses headerless transfer rows with the amount in the last column', () => {
    expect(parsed.transfers.items.map((t) => t.amount)).toEqual([500, 1500, 750]);
    expect(parsed.transfers.items[0]).toMatchObject({ source: 'Acct A', purpose: 'Tax Savings', labelsNeedReview: true });
    expect(parsed.parseWarnings.find((w) => w.code === 'transfer_labels_misaligned')).toBeDefined();
  });

  it('still parses cash and distributions from the shared two-column block', () => {
    expect(parsed.cash.accounts.map((a) => a.name)).toEqual(['First Checking', 'Second Savings']);
    expect(parsed.cash.reportedTotal).toBe(350);
    expect(parsed.distributions.entities).toHaveLength(1);
    expect(parsed.distributions.reportedTotal).toBe(30);
  });
});