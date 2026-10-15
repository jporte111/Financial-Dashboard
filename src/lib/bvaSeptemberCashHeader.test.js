import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';

// Mirrors the labelled September 2026 layout: the cash block carries a
// "Bank | Last Month | Sept 30 2026" header row (balances under the DATE
// column), a per-entity distribution grid beside it whose Total row is right
// but one entity's own YTD cell is stale, an income block whose Total row
// omits one line's budget, and amount-first transfer rows that can carry a
// destination account. All names and figures are fictional; only the shape
// mirrors the real file.
function buildWorkbook() {
  const rows = [
    ['BVA September 2026'],
    ['CASH', null, null, 'Distributions 2026'],
    ['Current Bank Balances'],
    ['Bank', 'Last Month', 'Sept 30 2026', 'Entity', 'Q1 - 3/30', 'Q2 - 6/30', 'Q3 - 9/30', 'Q4 - 12/31', 'YTD Total'],
    ['First Checking', 100, 90, 'Alpha', 10, 20, null, null, 30],
    ['Second Savings', 250, 240, 'Beta', 5, 5, 5, null, 15],
    ['Third Brokerage', 30, null, 'Gamma', null, null, 9, null, 4],
    ['Total Cash:', 380, 330, 'Total', 15, 25, 14, 0, 54],
    [],
    ['Budget'],
    [],
    ['INCOME'],
    ['Category', 'Last Month', 'Current Month', 'Actual YTD', 'Budget', 'Remaining', '% of Budget Spent'],
    ['4030 - Interest', 0.3, 0.4, 5, 17, 12, 0.29],
    ['RBC Interest', 0.5, null, 0.5, 0.73, null, 0.71],
    ['4050-Monthly ', 1300, 1300, 11700, 15600, 3900, 0.75],
    ['Total Income', 1300.8, 1300.4, 11705.5, 15617.73, 3912.23, 0.749], // budget omits RBC's 0.73
    [],
    ['EXPENSE', 'Last Month', 'Current Month', 'Actual YTD', 'Budget', 'Remaining', '% of Budget', 'Over/Under Budget'],
    [' 1. FIXED ', 330, 290, 2700, 3900, 1200, 0.69, 0.06],
    [' 2. VARIABLE', 310, 380, 2600, 3800, 1200, 0.68, 0.05],
    [' 3. DISCRETIONARY ', 500, 490, 6600, 8900, 2300, 0.74, -0.001],
    ['Total Expenses', 1150, 1170, 11900, 16600, 4700, 0.72, 800],
    [],
    ['Over/Under Budget', 0.05, 800],
    [],
    ['DETAIL'],
    ['Categories', 'Last Month', 'Current Month', 'Actual YTD', 'Budget', 'Remaining', '% of Budget', 'Over/Under Budget'],
    ['6120 Grdng', 220, 88, 2400, 4700, 2300, 0.52, 0.22],
    ['6215 NANNY', 400, 400, 2800, 4800, 2000, 0.58, 0.23],
    ['8030 - MONTHLY SAVINGS', null, null, 1300, 3000, 1700, 0.13, 0.62],
    [],
    ['Monthly Transfers/Debits'],
    [420, 'BofA 5619', 'Property Tax Savings', null],
    [850, 'BofA 5619', 'HO Insurance Savings', 'BofA MM 1082'],
    [500, 'BofA 5619', 'Viviannah', 'Chase Savings '],
    [1020, 'Mortgage', 'wells fargo', null],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'September');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

const parsed = parseBvaWorkbook(buildWorkbook());
const v = validateBva(parsed, {
  cutoffDate: parsed.meta.cutoffDate,
  period: { month: 9, year: 2026 },
});

describe('cash block: "Bank" header row and the dated balance column', () => {
  it('does not read the "Bank" header row as an account', () => {
    expect(parsed.cash.accounts.map((a) => a.name)).toEqual(['First Checking', 'Second Savings', 'Third Brokerage']);
    expect(parsed.cash.accounts.find((a) => a.name === 'Bank')).toBeUndefined();
  });

  it('reads balances from the "Sept 30 2026" column, not "Last Month"', () => {
    expect(parsed.cash.accounts[0].balance).toBe(90);
    expect(parsed.cash.accounts[1].balance).toBe(240);
    // A blank balance stays null ("unknown"), never 0.
    expect(parsed.cash.accounts[2].balance).toBe(null);
    expect(parsed.cash.reportedTotal).toBe(330);
  });

  it('reads the cutoff date from the "Sept 30 2026" header', () => {
    expect(parsed.meta.cutoffDate).toBe('2026-09-30');
    expect(parsed.parseWarnings.find((w) => w.code === 'cutoff_date_missing')).toBeUndefined();
  });

  it('no cash warning for a header row; the genuinely blank balance is still flagged', () => {
    const missing = v.warnings.find((w) => w.code === 'source_value_missing:cash');
    expect(missing).toBeDefined();
    expect(missing.message).toContain('Third Brokerage');
    expect(missing.message).not.toContain('Bank');
    // The calculated total keeps the missing part missing.
    expect(v.reconciled.cash.total).toBe(null);
  });
});

describe('income budget: the workbook Total row omits one line, and the warning names it', () => {
  const w = v.warnings.find((x) => x.code === 'income_budget_workbook_mismatch');
  it('both values are kept, the calculated one wins', () => {
    expect(w.sourceValue).toBe(15617.73); // workbook displayed total
    expect(w.calculatedValue).toBe(15617.73 + 0.73); // lines sum to this
    expect(v.reconciled.income.budgetTotal).toBe(15617.73 + 0.73);
    expect(v.reconciled.income.workbookBudgetTotal).toBe(15617.73);
    expect(w.blocksFinalize).toBe(false);
  });
  it('the message names the omitted line', () => {
    expect(w.message).toContain('RBC Interest ($0.73)');
  });
});

describe('distributions: stale per-entity YTD cell reported on its own', () => {
  // Gamma's workbook YTD cell says 4 but its quarters sum to 9; the grand
  // total (54) still equals the recalculated entity-quarter sum.
  it('no grand-total discrepancy when the totals agree to the cent', () => {
    expect(v.reconciled.distributions.entitySum).toBe(54);
    expect(v.reconciled.distributions.workbookReportedTotal).toBe(54);
    expect(v.warnings.find((x) => x.code === 'distribution_workbook_total_corrected')).toBeUndefined();
  });

  it('the stale entity YTD cell is flagged with that entity\'s figures', () => {
    const w = v.warnings.find((x) => x.code === 'distribution_entity_ytd_mismatch');
    expect(w).toBeDefined();
    expect(w.message).toContain('Gamma');
    expect(w.sourceValue).toBe(4);
    expect(w.calculatedValue).toBe(9);
    expect(w.blocksFinalize).toBe(false);
    // Other entities are not flagged.
    expect(v.reconciled.distributions.entities.find((e) => e.name === 'Alpha').matches).toBe(true);
  });

  it('blank quarters that have begun are listed for confirmation, never auto-zeroed', () => {
    const w = v.warnings.find((x) => x.code === 'distribution_quarter_blank');
    expect(w).toBeDefined();
    expect(w.message).toContain('Alpha Q3');
  });
});

describe('transfers: amount-first rows map source, purpose and destination', () => {
  it('maps the three label columns in order', () => {
    expect(parsed.transfers.items[1]).toMatchObject({
      amount: 850,
      source: 'BofA 5619',
      purpose: 'HO Insurance Savings',
      destination: 'BofA MM 1082',
    });
    expect(parsed.transfers.items[0].destination).toBe(null);
    expect(v.reconciled.transfers.total).toBe(2790);
  });

  it('the confirmation message states the mapping and the destination count', () => {
    const w = parsed.parseWarnings.find((x) => x.code === 'transfer_labels_misaligned');
    expect(w).toBeDefined();
    expect(w.message).toContain('destination account (2 of 4');
  });
});