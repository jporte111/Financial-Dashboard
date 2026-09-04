import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';

// Build a workbook that mirrors the real sheet's quirks: a misleading title,
// a cutoff date under the cash header, DETAIL formula columns shifted down a
// row, an orphan amount-only DETAIL row, and misaligned transfer labels.
function buildWorkbook() {
  const rows = [];
  rows[0] = ['BVA August 2026'];
  rows[1] = ['CASH', '', '', 'Distributions 2026'];
  rows[2] = ['Current Bank Balances'];
  rows[3] = ['2026-07-31', '', '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'];
  rows[4] = ['First Checking', 100, '', 'Alpha', 10, 10, 10, '', 30];
  rows[5] = ['Second Savings', 250, '', 'Beta', 40, '', '', '', 10]; // reported YTD 10 disagrees with quarters (40)
  rows[6] = ['Total Cash:', 350, '', 'Total', '', '', '', '', 40];
  rows[7] = [];
  rows[8] = ['INCOME', '', '', 'Budget', 'Remaining', '% of Budget'];
  rows[9] = ['Category', 'Current Month', 'Actual YTD'];
  rows[10] = ['   4000 - Interest', '', 1, 2];
  rows[11] = ['   4050-Monthly', '', 700, 1200];
  rows[12] = ['Total Income', 0, 701, 1201]; // budget 1201 omits nothing here; keep simple
  rows[13] = [];
  rows[14] = ['EXPENSE', '', '', 'Budget', 'Remaining', '% of Budget', 'Over/Under Budget'];
  rows[15] = ['', 'Current Month', 'Actual YTD'];
  rows[16] = [' 1. FIXED ', '', 70, 120];
  rows[17] = [' 2. VARIABLE', '', 50, 120];
  rows[18] = [' 3. DISCRETIONARY ', '', 95, 120];
  rows[19] = ['Total Expenses', 0, 215, 360];
  rows[20] = ['Over/Under Budget', -0.0139, -5];
  rows[21] = [];
  rows[22] = ['DETAIL'];
  rows[23] = ['', 'Current Month', 'Actual YTD', 'Budget', 'Remaining', '% of Budget', 'Over/Under Budget'];
  // DETAIL rows: cols A, C, D are correct; E/F/G/H are shifted (reference prior row) and must be IGNORED.
  rows[24] = ['6100 Landscaping', '', 35, 60, 25, 0.58, 0.0056, 0]; // first row happens to be self-consistent
  rows[25] = ['6300 Clothing', '', 70, 60, 25 /* wrong: 60-35 */, 0.583 /* wrong: 35/60 */, 0.0, 0.0];
  rows[26] = ['', '', '', 60]; // orphan amount/blank row — must be skipped
  rows[27] = [];
  rows[28] = ['Monthly Transfers/Debits'];
  rows[29] = [500, 'Acct A', 'Tax Savings'];
  rows[30] = [1500, 'Acct A', 'Insurance', 'Dest Acct']; // destination present, shifted
  rows[31] = [750, 'Lease', 'Auto'];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'June');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('parseBvaWorkbook', () => {
  const parsed = parseBvaWorkbook(buildWorkbook());

  it('reads the reporting cutoff from the sheet, not the (misleading) title', () => {
    expect(parsed.meta.cutoffDate).toBe('2026-07-31');
    expect(parsed.meta.suggestedMonth).toBe(8); // title still surfaced for the confirm step
    expect(parsed.meta.suggestedYear).toBe(2026);
    expect(parsed.meta.sheetName).toBe('June');
  });

  it('parses every cash account and the reported total', () => {
    expect(parsed.cash.accounts.map((a) => a.name)).toEqual(['First Checking', 'Second Savings']);
    expect(parsed.cash.accounts.map((a) => a.balance)).toEqual([100, 250]);
    expect(parsed.cash.reportedTotal).toBe(350);
  });

  it('parses distribution entities with quarters and the reported per-entity YTD', () => {
    expect(parsed.distributions.entities).toHaveLength(2);
    const beta = parsed.distributions.entities[1];
    expect(beta).toMatchObject({ name: 'Beta', q1: 40, q2: 0, q3: 0, q4: 0, reportedYtd: 10 });
    expect(parsed.distributions.reportedTotal).toBe(40);
  });

  it('parses income categories and both reported totals', () => {
    expect(parsed.income.categories.map((c) => c.name)).toEqual(['Interest', 'Monthly']);
    expect(parsed.income.reportedActualTotal).toBe(701);
    expect(parsed.income.reportedBudgetTotal).toBe(1201);
    expect(parsed.income.categories[0]).toMatchObject({ code: '4000', actualYtd: 1, annualBudget: 2 });
  });

  it('parses the three expense groups and the reported variance row', () => {
    expect(parsed.expenseSummary.groups.map((g) => g.key)).toEqual(['fixed', 'variable', 'discretionary']);
    expect(parsed.expenseSummary.reportedActualTotal).toBe(215);
    expect(parsed.expenseSummary.reportedBudgetTotal).toBe(360);
    expect(parsed.expenseSummary.reportedVarianceAmount).toBe(-5);
  });

  it('DETAIL: reads only account + Actual YTD + Budget, ignores the shifted formula columns and the orphan row', () => {
    expect(parsed.detail.categories).toHaveLength(2);
    expect(parsed.detail.categories.map((d) => d.code)).toEqual(['6100', '6300']);
    const clothing = parsed.detail.categories[1];
    expect(clothing).toMatchObject({ code: '6300', name: 'Clothing', actualYtd: 70, annualBudget: 60, group: 'unassigned' });
    // nothing from columns E/F/G/H is carried through
    expect(clothing).not.toHaveProperty('remaining');
  });

  it('transfers: amounts parse cleanly; misaligned labels raise a parse warning', () => {
    expect(parsed.transfers.items.map((t) => t.amount)).toEqual([500, 1500, 750]);
    expect(parsed.parseWarnings.find((w) => w.code === 'transfer_labels_misaligned')).toBeDefined();
    expect(parsed.transfers.items.every((t) => t.labelsNeedReview)).toBe(true);
  });
});
