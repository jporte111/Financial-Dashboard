// Phase 5b: QuickBooks Transaction Report (Excel) as drill-down detail.
// FICTIONAL data only (src/lib/__fixtures__/detailWorkbook.js).
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  readDetailReport, validateDetailReport, buildDetailRows, reconcileDetail, clientDetail, rowsForLine, detailWarnings,
  plainAccountName, topGroup, pathNumbers, normPath, validationPackage, modelFromPackage, chunkRows, CHUNK_ROWS, PUBLIC_DETAIL_FIELDS,
} from '../../base44/shared/detailReport.ts';
import { sheetModel, formulaRows } from './detailWorkbook.js';
import { makeDetailModel, detailWorkbookBytes } from './__fixtures__/detailWorkbook.js';

const clone = (x) => structuredClone(x);
const fresh = (o) => makeDetailModel({ scale: 1, ...o });
const sumCents = (rows) => rows.reduce((s, r) => s + r.a, 0);

describe('reading the Excel export', () => {
  it('the parser reads the workbook (values and formula references) into the sheet model', () => {
    const m = fresh();
    const parsed = sheetModel(XLSX.read(detailWorkbookBytes(m), { type: 'array', cellFormula: true }).Sheets.Sheet1);
    const read = readDetailReport(parsed);
    expect(read.errors).toEqual([]);
    expect(read.transactions.length).toBe(readDetailReport(m).transactions.length);
    expect(Object.keys(parsed.formulas).length).toBe(Object.keys(m.formulas).length);
    expect(read.meta).toMatchObject({ title: 'Transaction Report', year: 9102, startsJanuary: true, basis: 'Cash Basis' });
  });
  it('formula references: sums and ranges', () => {
    expect(formulaRows('I7+I8+I9')).toEqual([7, 8, 9]);
    expect(formulaRows('SUM(I7:I9)')).toEqual([7, 8, 9]);
    expect(formulaRows('$I$290+I1338')).toEqual([290, 1338]);
  });
  it('the fictional report passes all checks', () => {
    const v = validateDetailReport(readDetailReport(fresh({ scale: 3 })));
    expect(v.checks.map((c) => [c.key, c.ok])).toEqual([['layout', true], ['sum', true], ['balances', true], ['subtotals', true], ['structure', true]]);
  });
});

describe('the checks fail safely', () => {
  const failing = (mutate) => { const m = fresh(); mutate(m); return validateDetailReport(readDetailReport(m)); };
  const firstTx = (m) => m.rows.find((x) => /^\d\d\/\d\d\/\d{4}$/.test(String(x.B || '')));
  it('a changed amount breaks the sum, the running balance and the subtotal', () => {
    const v = failing((m) => { firstTx(m).I += 1; });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.key === 'sum').ok).toBe(false);
    expect(v.checks.find((c) => c.key === 'balances').ok).toBe(false);
  });
  it('a missing transaction row breaks the running balance', () => {
    const v = failing((m) => { const t = firstTx(m); const i = m.rows.indexOf(t); m.rows.splice(i, 1); });
    expect(v.checks.find((c) => c.key === 'balances').ok).toBe(false);
  });
  it('a subtotal that does not recompute fails', () => {
    const v = failing((m) => { const t = m.rows.find((x) => String(x.A || '').startsWith('Total for')); t.I += 5; });
    expect(v.checks.find((c) => c.key === 'subtotals').ok).toBe(false);
  });
  it('subtotals exported without formulas fail (they cannot be recomputed)', () => {
    const v = failing((m) => { m.formulas = {}; });
    expect(v.checks.find((c) => c.key === 'subtotals').ok).toBe(false);
  });
  it('a renamed column heading or a missing TOTAL fails the layout', () => {
    expect(failing((m) => { m.rows.find((x) => x.B === 'Transaction date').E = 'Payee'; }).checks[0].ok).toBe(false);
    expect(failing((m) => { m.rows = m.rows.filter((x) => x.A !== 'TOTAL'); }).ok).toBe(false);
  });
  it('a transaction under the wrong heading fails the structure check', () => {
    const v = failing((m) => { const t = firstTx(m); t.G = '1. FIXED COSTS:6210 - ZZ Mortgage'; });
    expect(v.ok).toBe(false);
  });
  it('the server re-checks the compact package and gets the same verdict', () => {
    const m = fresh({ scale: 2 });
    expect(validateDetailReport(readDetailReport(modelFromPackage(validationPackage(m)))).ok).toBe(true);
    const pkg = validationPackage(m);
    expect(JSON.stringify(pkg)).not.toMatch(/ZZ Payee|ZZ MEMO|ZZ Card 0001/); // no payees, memos or cards travel twice
    const bad = clone(pkg); bad.rows.find((x) => /^\d\d\//.test(String(x.B || ''))).I += 0.01;
    expect(validateDetailReport(readDetailReport(modelFromPackage(bad))).ok).toBe(false);
  });
});

describe('cutoff, signs and mapping', () => {
  const m = fresh({ scale: 2 });
  const read = readDetailReport(m);
  const built = buildDetailRows(read, { cutoff: m.cutoff, year: m.year });
  it('strictly through the cutoff; later rows are counted, not stored', () => {
    expect(built.rows.every((r) => r.d <= m.cutoff)).toBe(true);
    const later = read.transactions.filter((t) => t.date > m.cutoff);
    expect(built.after.count).toBe(later.length);
    expect(built.after.count).toBeGreaterThan(0);
    expect(built.rows.length + built.after.count).toBe(read.transactions.length);
  });
  it('signed amounts are kept exactly (credits negative, whole cents)', () => {
    expect(built.rows.some((r) => r.a < 0)).toBe(true);
    expect(built.rows.every((r) => Number.isInteger(r.a))).toBe(true);
    const fromSheet = read.transactions.filter((t) => t.date <= m.cutoff).reduce((s, t) => s + t.amount, 0);
    expect(sumCents(built.rows)).toBe(fromSheet);
  });
  it('the two-space group name is normalised; groups by top-level segment', () => {
    expect(topGroup('2.  VARIABLE COSTS:6215 - ZZ Nanny')).toBe('variable');
    expect(normPath('2.  VARIABLE  COSTS:6215 -  ZZ Nanny')).toBe('2. VARIABLE COSTS:6215 - ZZ Nanny');
    expect(topGroup('7215 - ZZ Card Interest')).toBe(null);
  });
  it('plain account names', () => {
    expect(plainAccountName('2. VARIABLE COSTS:6105 - ZZ Household:6115 - ZZ Flowers')).toBe('ZZ Flowers');
    expect(plainAccountName('2. VARIABLE COSTS:6550 - ZZ Medical:6575 - ZZ Doctor Visits:ZZ Person A')).toBe('ZZ Doctor Visits – ZZ Person A');
    expect(plainAccountName('3. DISCRETIONARY COSTS:6845 - ZZ Personal:ZZ SPA (deleted)')).toBe('ZZ Personal – ZZ SPA');
    expect(plainAccountName('3. DISCRETIONARY COSTS:ZZ Event')).toBe('ZZ Event');
    expect(plainAccountName('2.  VARIABLE COSTS')).toBe('Variable Costs – general'); // posted to the group itself
    expect(plainAccountName('x:6575 - ZZ Doctor Visits:ZZ Person A', 'Doctor visits (A)')).toBe('Doctor visits (A)');
    expect(pathNumbers('2. VARIABLE COSTS:6550 - ZZ Medical:6575 - ZZ Doctor Visits:ZZ Person A')).toEqual(['6550', '6575']);
  });
  it('accounts without their own number are internal until confirmed; outside the groups is unmapped', () => {
    const person = built.rows.filter((r) => r.p.endsWith('ZZ Person A'));
    expect(person.length).toBeGreaterThan(0);
    expect(person.every((r) => r.ok === false)).toBe(true);
    expect(built.rows.filter((r) => r.p.startsWith('7215')).every((r) => r.ok === false && r.g === '')).toBe(true);
    const confirmed = new Map([[normPath('2.  VARIABLE COSTS:6550 - ZZ Medical:6575 - ZZ Doctor Visits:ZZ Person A'), 'Doctor visits (A)']]);
    const again = buildDetailRows(read, { cutoff: m.cutoff, year: m.year }, confirmed);
    const pa = again.rows.filter((r) => r.p.endsWith('ZZ Person A'));
    expect(pa.every((r) => r.ok && r.ac === 'Doctor visits (A)')).toBe(true);
  });
  it('a report for another year, or not starting in January, is refused', () => {
    expect(buildDetailRows(read, { cutoff: '9103-06-30', year: 9103 }).issues.length).toBeGreaterThan(0);
    const r2 = readDetailReport({ ...m, rows: m.rows.map((x) => (x.r === 2 ? { ...x, A: 'March-December, 9102' } : x)) });
    expect(buildDetailRows(r2, { cutoff: m.cutoff, year: m.year }).issues.join(' ')).toMatch(/January 1/);
  });
  it('chunks of at most CHUNK_ROWS rows', () => {
    const big = buildDetailRows(readDetailReport(makeDetailModel({ scale: 30 })), { cutoff: '9102-06-30', year: 9102 });
    expect(big.rows.length).toBeGreaterThan(1000);
    expect(chunkRows(big.rows).every((c) => c.length <= CHUNK_ROWS)).toBe(true);
    expect(chunkRows(big.rows).flat().length).toBe(big.rows.length);
  });
});

describe('reconciliation and what the client sees', () => {
  const m = fresh({ scale: 2 });
  const read = readDetailReport(m);
  const rows = buildDetailRows(read, { cutoff: m.cutoff, year: m.year }).rows;
  const groupCents = (g) => sumCents(rows.filter((r) => r.g === g));
  const watchCents = (code) => sumCents(rows.filter((r) => r.ns.includes(code) && (r.n ? true : r.ok)));
  const lines = [
    { id: 'gf', category: 'FIXED', budget_group: 'fixed', ytd_actual: groupCents('fixed') / 100 },
    { id: 'gv', category: 'VARIABLE', budget_group: 'variable', ytd_actual: groupCents('variable') / 100 + 12 }, // BVA leaves out $12
    { id: 'gd', category: 'DISCRETIONARY', budget_group: 'discretionary', ytd_actual: null },
    { id: 'w1', category: '6215 ZZ NANNY', qb_code: '6215', bva_detail: true, budget_group: 'variable', ytd_actual: watchCents('6215') / 100 },
    { id: 'w2', category: '6550 ZZ MEDICAL', qb_code: '6550', bva_detail: true, budget_group: 'variable', ytd_actual: watchCents('6550') / 100 + 1 },
    { id: 'w3', category: '6999 ZZ NONE', qb_code: '6999', bva_detail: true, budget_group: 'variable', ytd_actual: 50 },
  ];
  const rec = reconcileDetail(rows, lines);
  const e = (k) => rec.lines.find((x) => x.key === k);
  it('per line: BVA total, detail total, difference and status (cents)', () => {
    expect(e('group:fixed')).toMatchObject({ status: 'reconciled', difference: 0 });
    expect(e('group:variable')).toMatchObject({ status: 'difference', difference: -1200 });
    expect(e('group:discretionary')).toMatchObject({ status: 'bva_missing', difference: null, bva_total: null });
    expect(e('watch:w1')).toMatchObject({ status: 'reconciled', code: '6215' });
    expect(e('watch:w2')).toMatchObject({ status: 'difference', difference: -100 });
    expect(e('watch:w3')).toMatchObject({ status: 'no_detail', detail_total: 0 });
  });
  it('a watch line includes child accounts, and counts unconfirmed no-number children as withheld', () => {
    const med = rowsForLine(rows, e('watch:w2'));
    expect(med.some((r) => r.p.includes('6630 - ZZ Prescriptions'))).toBe(true);
    expect(med.some((r) => r.p.endsWith('ZZ Person A'))).toBe(false);
    expect(e('watch:w2').withheld).toBeGreaterThan(0);
  });
  it('unmapped and unconfirmed are summarised for the admin', () => {
    expect(rec.unmapped.count).toBeGreaterThan(0);
    expect(rec.unmapped.accounts.map((a) => a.path)).toEqual(['7215 - ZZ Card Interest']);
    expect(rec.unconfirmed.map((a) => a.path)).toEqual(expect.arrayContaining(['2. VARIABLE COSTS:6550 - ZZ Medical:6575 - ZZ Doctor Visits:ZZ Person A', '3. DISCRETIONARY COSTS:ZZ Event']));
  });
  it('client: only date, payee, signed amount and plain account name', () => {
    const c = clientDetail(rows, e('watch:w1'));
    expect(c.transactions.length).toBeGreaterThan(0);
    for (const t of c.transactions) expect(Object.keys(t).sort()).toEqual([...PUBLIC_DETAIL_FIELDS].sort());
    expect(c.note).toMatch(/matching the report/);
  });
  it('client: a group that differs shows its rows with a neutral note', () => {
    const c = clientDetail(rows, e('group:variable'));
    expect(c.transactions.length).toBeGreaterThan(0);
    expect(c.note).toMatch(/^The listed transactions total .*; the report shows .*\. The report figure is the one used on this dashboard\.$/);
    expect(c.transactions.some((t) => t.account.includes('ZZ Person'))).toBe(false); // unconfirmed: internal
  });
  it('client: a watch line that does not reconcile shows no rows, only the note', () => {
    const c = clientDetail(rows, e('watch:w2'));
    expect(c.transactions).toEqual([]);
    expect(c.note).toMatch(/isn't shown for this category/);
  });
  it('client: a reconciled group with withheld (unconfirmed) rows does not claim to match', () => {
    const fixed = clientDetail(rows, e('group:fixed'));
    expect(e('group:fixed').withheld).toBeGreaterThan(0); // ZZ Security Reimb has no number
    expect(fixed.note).not.toMatch(/matching the report/);
  });
  it('differences become warnings (codes the review groups under one cause)', () => {
    const w = detailWarnings(rec);
    expect(w.map((x) => x.code)).toEqual(expect.arrayContaining(['detail_difference:group:variable', 'detail_difference:watch:w2', 'detail_unmapped', 'detail_unconfirmed']));
    expect(w.some((x) => x.code === 'detail_difference:group:fixed')).toBe(false);
  });
});
