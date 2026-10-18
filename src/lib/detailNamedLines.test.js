// Watch-list (DETAIL) lines without an account number (owner, 2026-10-18):
// the BVA import carries their confirmed group by exact name, and the Phase 5b
// drill-down matches them to the confirmed number-less account with exactly
// that client-facing name, children included. FICTIONAL data only.
import { describe, it, expect } from 'vitest';
import { reconcileDetail, rowsForLine, clientDetail, detailWarnings, plainAccountName, topGroup, pathNumbers, normPath } from '../../base44/shared/detailReport.ts';
import { carriedGroupMap, groupMapFromLines, planBvaImport } from './bvaImport.js';
import { detailGroupKey } from './bvaCorrections.js';

const own = (p) => { const s = normPath(p).split(':'); return (s[s.length - 1].match(/^(\d{4})(?=\D|$)/) || [])[1] || ''; };
// A stored detail row (compact keys), as buildDetailRows writes it.
let seq = 1;
const row = (path, cents, confirmedName = null) => {
  const p = normPath(path); const n = own(p); const g = topGroup(p) || '';
  return { r: seq++, d: '9102-03-01', py: 'Test Payee', a: cents, ac: plainAccountName(p, n ? null : confirmedName), p, n, ns: pathNumbers(p), g, ok: !!(g && (n || confirmedName)), ty: 'Expense', no: '', m: 'internal memo', pm: 'Test Card' };
};
const groupLine = (g, ytd) => ({ id: `g-${g}`, category: g.toUpperCase(), budget_group: g, bva_detail: false, ytd_actual: ytd });
const watch = (id, category, ytd, budget_group = 'discretionary', qb_code = '') => ({ id, category, qb_code, budget_group, bva_detail: true, ytd_actual: ytd });

const WED = '3. DISCRETIONARY COSTS:Example Wedding';
const rowsWith = (confirmed) => [
  row(WED, 500000, confirmed),
  row(`${WED}:Flowers`, 20000, confirmed ? 'Example Wedding – Flowers' : null),
  row(`${WED}:9810 - Venue`, 30000),
  row('3. DISCRETIONARY COSTS:9720 - Clothing', 12345),
  row('3. DISCRETIONARY COSTS:Other Event', 7000, 'Other Event'),
];
const LINES = [groupLine('discretionary', 5693.45), watch('w-wed', 'Example Wedding', 5500), watch('w-clo', 'CLOTHING', 123.45, 'discretionary', '9720')];
const entryOf = (rec, id) => rec.lines.find((e) => e.line_id === id);

describe('Phase 5b: a DETAIL line without an account number', () => {
  it('matches the confirmed account named exactly like the line, its children included', () => {
    const rows = rowsWith('Example Wedding');
    const e = entryOf(reconcileDetail(rows, LINES), 'w-wed');
    expect(e).toMatchObject({ kind: 'watch', code: null, accounts: [normPath(WED)], status: 'reconciled', detail_total: 550000, bva_total: 550000, rows: 3, withheld: 0 });
    expect(rowsForLine(rows, e).map((r) => r.p)).toEqual([normPath(WED), normPath(`${WED}:Flowers`), normPath(`${WED}:9810 - Venue`)]);
  });
  it('the client sees its rows (four fields) under the account name, and the matching note', () => {
    const rows = rowsWith('Example Wedding');
    const c = clientDetail(rows, entryOf(reconcileDetail(rows, LINES), 'w-wed'));
    expect(c.transactions.map((t) => Object.keys(t).sort())).toEqual(Array(3).fill(['account', 'amount', 'date', 'payee']));
    expect(c.transactions.map((t) => t.account)).toEqual(['Example Wedding', 'Example Wedding – Flowers', 'Venue']);
    expect(c.note).toBe('Listed transactions total $5,500.00, matching the report.');
  });
  it('case and spacing aside, the name must match exactly -- never partially', () => {
    const rows = rowsWith('Example Wedding');
    expect(entryOf(reconcileDetail(rows, [watch('w', '  example   WEDDING ', 5500)]), 'w').accounts).toEqual([normPath(WED)]);
    for (const label of ['Wedding', 'Example Wedding Costs', 'Example']) {
      expect(entryOf(reconcileDetail(rows, [watch('w', label, 5500)]), 'w')).toMatchObject({ accounts: [], rows: 0, status: 'no_detail' });
    }
  });
  it('an unconfirmed account with that name counts for nothing, is withheld, and is named in the warning', () => {
    const rows = rowsWith(null);
    const rec = reconcileDetail(rows, LINES);
    const e = entryOf(rec, 'w-wed');
    expect(e).toMatchObject({ accounts: [], rows: 0, status: 'no_detail', withheld: 1 });
    expect(clientDetail(rows, e).transactions).toEqual([]);
    const w = detailWarnings(rec).find((x) => x.code === 'detail_difference:watch:w-wed');
    expect(w.message).toMatch(/no account number, so it matches only a confirmed account named exactly "Example Wedding" \(one with that name is not confirmed yet\)/);
  });
  it('a line in another cost group does not take an account from this one', () => {
    const rows = rowsWith('Example Wedding');
    expect(entryOf(reconcileDetail(rows, [watch('w', 'Example Wedding', 5500, 'variable')]), 'w')).toMatchObject({ accounts: [], status: 'no_detail' });
  });
  it('a difference hides the rows (watch-line rule), and the group total is unaffected', () => {
    const rows = rowsWith('Example Wedding');
    const rec = reconcileDetail(rows, [groupLine('discretionary', 5693.45), watch('w-wed', 'Example Wedding', 5400)]);
    expect(entryOf(rec, 'w-wed')).toMatchObject({ status: 'difference', difference: 10000 });
    expect(clientDetail(rows, entryOf(rec, 'w-wed')).transactions).toEqual([]);
    const g = rec.lines.find((e) => e.key === 'group:discretionary');
    expect(g).toMatchObject({ detail_total: 569345, bva_total: 569345, status: 'reconciled', listed_total: 569345 });
  });
  it('numbered watch lines are unchanged', () => {
    const rows = rowsWith('Example Wedding');
    expect(entryOf(reconcileDetail(rows, LINES), 'w-clo')).toMatchObject({ code: '9720', status: 'reconciled', rows: 1 });
    expect(entryOf(reconcileDetail(rows, LINES), 'w-clo').accounts).toBeUndefined();
  });
});

describe('BVA import: the group of a DETAIL row without a code', () => {
  const prev = [
    { id: 'a', bva_detail: true, qb_code: '', category: 'Example Wedding', budget_group: 'discretionary', group_confirmed: true },
    { id: 'b', bva_detail: true, qb_code: '9720', category: 'Test Clothing', budget_group: 'discretionary', group_confirmed: true },
    { id: 'c', bva_detail: true, qb_code: '', category: 'Unconfirmed Event', budget_group: 'discretionary', group_confirmed: false },
  ];
  it('the key is the code, or the exact normalized name for a row without one', () => {
    expect(detailGroupKey(' 9720 ', 'Test Clothing')).toBe('9720');
    expect(detailGroupKey('', '  Example   WEDDING ')).toBe('name:example wedding');
    expect(detailGroupKey('', '')).toBe('');
  });
  it('is carried from last month by exact name, never by a code-less rename, never if unconfirmed', () => {
    expect(carriedGroupMap(prev, [{ code: '', name: 'example wedding' }])).toEqual({ 'name:example wedding': 'discretionary' });
    expect(carriedGroupMap(prev, [{ code: '', name: 'Example Wedding Costs' }, { code: '', name: 'Unconfirmed Event' }])).toEqual({});
    // a code-less row never takes the group of a coded row with the same name, or the reverse
    expect(carriedGroupMap(prev, [{ code: '', name: 'Test Clothing' }, { code: '9811', name: 'Example Wedding' }])).toEqual({});
  });
  it('a confirmed code-less line on the draft is kept on re-import', () => {
    expect(groupMapFromLines(prev)).toEqual({ 'name:example wedding': 'discretionary', 9720: 'discretionary' });
  });
  it('the import writes it as a confirmed Discretionary watch line', () => {
    const detail = { categories: [{ code: '', name: 'Example Wedding', actual: 5500, annual: 6000 }] };
    const parsed = { meta: {}, income: { categories: [] }, expenseSummary: { groups: [] }, detail, cash: { accounts: [] }, distributions: { entities: [] }, transfers: { items: [] } };
    const R = { income: { categories: [] }, expenses: { groups: [] }, detail, cash: { accounts: [] }, distributions: { entities: [] }, transfers: { items: [] } };
    const plan = planBvaImport({ parsed, validation: { reconciled: R, warnings: [] }, confirm: { month: 10, year: 9102, cutoffDate: '9102-09-30' }, groupMap: carriedGroupMap(prev, detail.categories) });
    expect(plan.budgetLines.toCreate.find((l) => l.category === 'Example Wedding')).toMatchObject({ qb_code: '', budget_group: 'discretionary', group_confirmed: true, bva_detail: true });
  });
});
