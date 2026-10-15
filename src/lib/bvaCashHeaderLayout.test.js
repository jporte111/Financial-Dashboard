// Cash blocks whose header row names the columns (the October workbook layout):
// balances must come from the report's dated column, never from "Last Month".
// All banks, entities and figures are fictional.
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from './bvaParser.js';

const book = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
};

// A minimal simplified-layout workbook around a given cash header + rows.
function workbook({ header, accounts, total, stated = '09/30/2030' }) {
  return parseBvaWorkbook(book([
    ['BVA Sample 2030'],
    [`Sample | Reporting Cutoff Date: ${stated} | USD`],
    [''],
    ['CASH — Current Bank Balances', '', '', 'Distributions 2030'],
    [...header, ...Array(Math.max(0, 3 - header.length)).fill(''), 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'],
    ...accounts.map(([name, ...cells], i) => [name, ...cells, ...Array(Math.max(0, 2 - cells.length)).fill(''), i === 0 ? 'Alpha' : '', i === 0 ? 10 : '', i === 0 ? 10 : '', i === 0 ? 10 : '', '', i === 0 ? 30 : '']),
    ['Total Cash', ...total, ...Array(Math.max(0, 2 - total.length)).fill(''), 'Total', 10, 10, 10, 0, 30],
    [''],
    ['INCOME'],
    ['Category', 'Month Actual', 'Actual YTD', 'Annual Budget'],
    ['Interest Earned', 1, 9, 12],
    ['Monthly Income', 801, 7209, 9612],
    ['Total Income', 802, 7218, 9624],
    ['FIXED', 10, 90, 120],
    ['VARIABLE', 5, 45, 60],
    ['DISCRETIONARY', 8, 72, 96],
    ['Total Expenses', 23, 207, 276],
  ]));
}
const balances = (p) => p.cash.accounts.map((a) => a.balance);

describe('cash header layouts', () => {
  it('October layout "Bank | Last Month | Sept 30 2030": balances come from the dated column', () => {
    const p = workbook({ header: ['Bank', 'Last Month', 'Sept 30 2030'], accounts: [['Test Checking', 111, 222], ['Test Savings', 333, 444]], total: [444, 666] });
    expect(balances(p)).toEqual([222, 444]);
    expect(p.cash.reportedTotal).toBe(666);
    expect(p.meta.cutoffDate).toBe('2030-09-30');
  });

  it('"September 30, 2030" spelled out, and the dated header is a cutoff source', () => {
    const p = workbook({ header: ['Bank', 'Last Month', 'September 30, 2030'], accounts: [['Test Checking', 111, 222]], total: [111, 222] });
    expect(balances(p)).toEqual([222]);
    expect(p.meta.cutoffDate).toBe('2030-09-30');
  });

  it('a real Excel date in the header works the same', () => {
    const p = workbook({ header: ['Bank', 'Last Month', new Date(Date.UTC(2030, 8, 30))], accounts: [['Test Checking', 111, 222]], total: [111, 222] });
    expect(balances(p)).toEqual([222]);
  });

  it('two dated columns: the latest date is this report\'s balance', () => {
    const p = workbook({ header: ['Bank', 'Aug 31 2030', 'Sept 30 2030'], accounts: [['Test Checking', 111, 222]], total: [111, 222] });
    expect(balances(p)).toEqual([222]);
  });

  it('the older layout "Account | 08/31/2030" keeps reading its single dated column', () => {
    const p = workbook({ header: ['Account', '08/31/2030'], accounts: [['Test Checking', 555]], total: [555], stated: '08/31/2030' });
    expect(balances(p)).toEqual([555]);
    expect(p.meta.cutoffDate).toBe('2030-08-31');
  });

  it('"Bank | Last Month | Current" (no date): balances come from "Current", never "Last Month"', () => {
    const p = workbook({ header: ['Bank', 'Last Month', 'Current'], accounts: [['Test Checking', 111, 222]], total: [111, 222] });
    expect(balances(p)).toEqual([222]);
  });

  it('a header date that disagrees with the stated cutoff is reported, not silently used', () => {
    const p = workbook({ header: ['Bank', 'Last Month', 'Sept 30 2030'], accounts: [['Test Checking', 111, 222]], total: [111, 222], stated: '08/31/2030' });
    expect(p.parseWarnings.map((w) => w.code)).toContain('cutoff_date_conflict');
  });

  it('a blank balance under the dated column stays missing (never $0.00)', () => {
    const p = workbook({ header: ['Bank', 'Last Month', 'Sept 30 2030'], accounts: [['Test Checking', 111, ''], ['Test Savings', 333, 444]], total: [444, ''] });
    expect(balances(p)).toEqual([null, 444]);
    expect(p.cash.reportedTotal).toBe(null);
  });
});

// ---- report titles (item 4) -------------------------------------------------
import { validateBva } from './bvaValidation.js';
describe('workbook title: report month or data month', () => {
  const titled = (title) => parseBvaWorkbook(book([
    [title], ['Sample | Reporting Cutoff Date: 09/30/2030 | USD'], [''],
    ['CASH — Current Bank Balances'], ['Account', '09/30/2030'], ['Test Checking', 100], ['Total Cash', 100], [''],
    ['INCOME'], ['Category', 'Month Actual', 'Actual YTD', 'Annual Budget'], ['Monthly Income', 1, 9, 12], ['Total Income', 1, 9, 12],
    ['FIXED', 1, 9, 12], ['VARIABLE', 1, 9, 12], ['DISCRETIONARY', 1, 9, 12], ['Total Expenses', 3, 27, 36],
  ]));
  const codes = (title, period) => validateBva(titled(title), { cutoffDate: '2030-09-30', period }).warnings.map((w) => [w.code, !!w.blocksFinalize]);
  it('titled by the report month (October, data through September): fine', () => {
    expect(codes('BVA October 2030', { month: 10, year: 2030 }).map((c) => c[0])).not.toContain('title_month_mismatch');
  });
  it('titled by the data month (September) and imported as the October report: accepted, noted, not blocking', () => {
    const c = codes('BVA September 2030', { month: 10, year: 2030 });
    expect(c.map((x) => x[0])).not.toContain('title_month_mismatch');
    expect(c).toContainEqual(['title_names_data_month', false]);
  });
  it('a title naming neither month is a warning (the title is only text; the cutoff decides)', () => {
    expect(codes('BVA July 2030', { month: 10, year: 2030 })).toContainEqual(['title_month_mismatch', false]);
  });
  it('a data-month title the cutoff does not support is a warning too', () => {
    expect(codes('BVA August 2030', { month: 10, year: 2030 })).toContainEqual(['title_month_mismatch', false]);
  });
});
