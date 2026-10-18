// Carrying last month's confirmed watch-list groups forward (item 5).
// Fictional codes and names only.
import { describe, it, expect } from 'vitest';
import { carriedGroupMap, planBvaImport } from './bvaImport.js';

const prevLine = (code, category, budget_group, extra = {}) => ({ id: `l-${code}`, bva_detail: true, qb_code: code, category, budget_group, group_confirmed: true, ...extra });
const PREV = [
  prevLine('9001', 'Test Gardening', 'fixed'),
  prevLine('9002', 'Test Nanny', 'variable'),
  prevLine('9003', 'Test Clothing', 'discretionary'),
  prevLine('9004', 'Test Monthly Savings', 'savings'),
  prevLine('9005', 'Test Travel', 'variable', { group_confirmed: false }),
  prevLine('9006', 'Test Unassigned', 'unassigned'),
  { id: 'sum', bva_detail: false, qb_code: '9007', category: 'FIXED', budget_group: 'fixed', group_confirmed: true },
];

describe('carriedGroupMap', () => {
  it('carries confirmed groups (including Savings) for unchanged code AND name', () => {
    const m = carriedGroupMap(PREV, [{ code: '9001', name: 'Test Gardening' }, { code: '9002', name: '  test   NANNY ' }, { code: '9003', name: 'Test Clothing' }, { code: '9004', name: 'Test Monthly Savings' }]);
    expect(m).toEqual({ 9001: 'fixed', 9002: 'variable', 9003: 'discretionary', 9004: 'savings' });
  });
  it('a renamed row is not carried (stays unassigned)', () => {
    expect(carriedGroupMap(PREV, [{ code: '9003', name: 'Test Personal' }])).toEqual({});
  });
  it('a new code is not carried', () => {
    expect(carriedGroupMap(PREV, [{ code: '9999', name: 'Test New Row' }])).toEqual({});
  });
  it('unconfirmed or unassigned groups last month, and summary lines, are never carried', () => {
    expect(carriedGroupMap(PREV, [{ code: '9005', name: 'Test Travel' }, { code: '9006', name: 'Test Unassigned' }, { code: '9007', name: 'FIXED' }])).toEqual({});
  });
  it('a row without a code never takes the group of a coded row with the same name', () => {
    expect(carriedGroupMap(PREV, [{ code: '', name: 'Test Gardening' }])).toEqual({});
  });
  it('the import uses a carried group as a confirmed group (no hand entry needed)', () => {
    const detail = { categories: [{ code: '9004', name: 'Test Monthly Savings', actual: 10, annual: 120 }] };
    const parsed = { meta: {}, income: { categories: [] }, expenseSummary: { groups: [] }, detail, cash: { accounts: [] }, distributions: { entities: [] }, transfers: { items: [] } };
    const R = { income: { categories: [] }, expenses: { groups: [] }, detail, cash: { accounts: [] }, distributions: { entities: [] }, transfers: { items: [] } };
    const plan = planBvaImport({ parsed, validation: { reconciled: R, warnings: [] }, confirm: { month: 10, year: 2030, cutoffDate: '2030-09-30' }, groupMap: carriedGroupMap(PREV, detail.categories) });
    const line = plan.budgetLines.toCreate.find((l) => l.qb_code === '9004');
    expect(line).toMatchObject({ budget_group: 'savings', group_confirmed: true });
  });
});
