// Phase 5b server side: stage_detail / commit_detail, Phase 4 version rules,
// finalize/check, and the drill-down endpoints. FICTIONAL data only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handlePeriodTransition, prepareOptions } from '../../base44/shared/periodTransitionCore.ts';
import { copyOptions } from '../../base44/shared/periodRevisionCore.ts';
import { detailOptions } from '../../base44/shared/detailServer.ts';
import { readDetailReport, buildDetailRows, chunkRows, validationPackage, normPath } from '../../base44/shared/detailReport.ts';
import { handlePublicCategoryRequest, handleCategoryTransactionsRequest, PUBLIC_TRANSACTION_FIELDS } from '../../base44/shared/publicDashboardCore.ts';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { fakeService } from './__fixtures__/fakeService.js';
import { makeDetailModel } from './__fixtures__/detailWorkbook.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2026-10-17T12:00:00Z');
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
const DEFAULTS = { prepare: { ...prepareOptions }, copy: { ...copyOptions }, detail: { ...detailOptions } };
beforeEach(() => {
  Object.assign(prepareOptions, { settleDelaysMs: [0, 0, 0, 0] });
  Object.assign(copyOptions, { visibleDelaysMs: [0], verifyDelaysMs: [0] });
  Object.assign(detailOptions, { readDelaysMs: [0, 0] });
});
afterEach(() => { Object.assign(prepareOptions, DEFAULTS.prepare); Object.assign(copyOptions, DEFAULTS.copy); Object.assign(detailOptions, DEFAULTS.detail); });

function seed({ published = false, final = false } = {}) {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const plan = planBvaImport({ parsed, validation, confirm: { month: 8, year: 2026, cutoffDate: SAMPLE_CUTOFF } });
  const rows = (b, prefix) => b.toCreate.map((r, i) => ({ id: `${prefix}${i + 1}`, period_id: 'p1', ...r }));
  return {
    ReportingPeriod: [{ id: 'p1', label: 'August 2026', ...plan.periodData, reporting_cutoff_date: SAMPLE_CUTOFF, bva_parsed_source: parsed, bva_validation_warnings: validation.warnings,
      status: final || published ? 'final' : 'draft', bva_import_status: final || published ? 'final' : 'draft', ...(final || published ? { finalized_at: 'x' } : {}), published, checklist: CHECKLIST, ...(published ? { publication_date: '2026-08-05' } : {}) }],
    BudgetLine: rows(plan.budgetLines, 'l'), CashAccount: rows(plan.cashAccounts, 'c'), Distribution: rows(plan.distributions, 'd'), RecurringTransfer: rows(plan.transfers, 't'),
    SavingsSpend: [], Transaction: [], TransactionDetailChunk: [], DetailAccountMap: [],
  };
}
const MODEL = makeDetailModel({ year: 2026, scale: 3, cutoffMonth: 7 });
let n = 0;
const importId = () => `${String(1760000000000 + (n += 1000))}-abcdef${n}`;
const T = (db, action, period_id, extra = {}) => handlePeriodTransition(db.base44, { action, period_id, ...extra }, ADMIN, NOW);
// What the browser does: build rows (with the confirmations on record), stage in chunks, commit with the package.
async function attach(db, periodId, { model = MODEL, tamperChunk = null, confirmed = null, id = importId() } = {}) {
  const period = db.tables.ReportingPeriod.get(periodId);
  const maps = confirmed || new Map(db.rows('DetailAccountMap').map((m) => [normPath(m.account_path), m.plain_name]));
  const built = buildDetailRows(readDetailReport(model), { cutoff: period.reporting_cutoff_date, year: period.year }, maps);
  const chunks = chunkRows(built.rows);
  for (let seq = 0; seq < chunks.length; seq++) {
    const rows = tamperChunk && seq === 0 ? tamperChunk(structuredClone(chunks[seq])) : chunks[seq];
    const s = await T(db, 'stage_detail', periodId, { import_id: id, seq, rows });
    if (s.status !== 200) return s;
  }
  return T(db, 'commit_detail', periodId, { import_id: id, package: validationPackage(model), file: { name: 'ZZ Transaction Report.xlsx', sha256: 'f'.repeat(64) } });
}
const chunks = (db, pid) => db.rows('TransactionDetailChunk').filter((c) => c.period_id === pid);

describe('attaching detail to a report version', () => {
  it('a draft: staged, re-checked and attached in one switch; per-line reconciliation stored', async () => {
    const db = fakeService(seed());
    const r = await attach(db, 'p1');
    expect(r.status).toBe(200);
    const di = db.tables.ReportingPeriod.get('p1').detail_import;
    expect(di).toMatchObject({ status: 'attached', rows_stored: expect.any(Number), basis: 'Cash Basis', cutoff: SAMPLE_CUTOFF, file_name: 'ZZ Transaction Report.xlsx' });
    expect(di.checks.every((c) => c.ok)).toBe(true);
    expect(di.after_cutoff.count).toBeGreaterThan(0); // counted, not stored
    expect(chunks(db, 'p1').flatMap((c) => c.rows).length).toBe(di.rows_stored);
    for (const e of di.reconciliation.lines) expect(Object.keys(e)).toEqual(expect.arrayContaining(['bva_total', 'detail_total', 'difference', 'status']));
    expect(db.rows('Transaction')).toEqual([]); // no Transaction records written
  });
  it('a final but unpublished report can take detail (its status is unchanged)', async () => {
    const db = fakeService(seed({ final: true }));
    expect((await attach(db, 'p1')).status).toBe(200);
    expect(db.tables.ReportingPeriod.get('p1').status).toBe('final');
  });
  it('a published report is frozen: staging and committing are refused, nothing written', async () => {
    const db = fakeService(seed({ published: true }));
    const r = await attach(db, 'p1');
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('detail_frozen');
    expect(chunks(db, 'p1')).toEqual([]);
    expect(db.tables.ReportingPeriod.get('p1').detail_import).toBeUndefined();
  });
  it('a report whose checks fail is refused and the version keeps its previous detail', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    const before = structuredClone(db.tables.ReportingPeriod.get('p1').detail_import);
    const bad = structuredClone(MODEL); bad.rows.find((x) => /^\d\d\//.test(String(x.B || ''))).I += 0.01;
    const r = await attach(db, 'p1', { model: bad });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('detail_checks_failed');
    expect(db.tables.ReportingPeriod.get('p1').detail_import).toEqual(before);
  });
  it('staged rows that do not match the file are refused (e.g. an altered amount)', async () => {
    const db = fakeService(seed());
    const r = await attach(db, 'p1', { tamperChunk: (rows) => { rows[0].a += 1; return rows; } });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('detail_staged_mismatch');
    expect(db.tables.ReportingPeriod.get('p1').detail_import).toBeUndefined();
  });
  it('the server decides client visibility from the confirmations on record, not the browser', async () => {
    const db = fakeService(seed());
    const path = normPath('2.  VARIABLE COSTS:6550 - ZZ Medical:6575 - ZZ Doctor Visits:ZZ Person A');
    const r = await attach(db, 'p1', { confirmed: new Map([[path, 'Shown anyway']]) }); // not on record
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('detail_staged_mismatch');
    db.tables.DetailAccountMap.set('m1', { id: 'm1', account_path: path, plain_name: 'Doctor visits (A)' });
    expect((await attach(db, 'p1')).status).toBe(200); // now confirmed on record
    const rows = chunks(db, 'p1').flatMap((c) => c.rows).filter((x) => x.p === path);
    expect(rows.every((x) => x.ok && x.ac === 'Doctor visits (A)')).toBe(true);
  });
  it('re-attaching replaces the detail and removes the older import\'s chunks', async () => {
    const db = fakeService(seed());
    const a = importId(); await attach(db, 'p1', { id: a });
    const b = importId(); await attach(db, 'p1', { id: b });
    expect(db.tables.ReportingPeriod.get('p1').detail_import.import_id).toBe(b);
    expect(new Set(chunks(db, 'p1').map((c) => c.import_id))).toEqual(new Set([b]));
  });
  it('an older commit never removes a newer import\'s chunks', async () => {
    const db = fakeService(seed());
    const older = importId(), newer = importId();
    await attach(db, 'p1', { id: newer });
    // a slow older upload commits afterwards: it becomes current (last write wins) ...
    await attach(db, 'p1', { id: older });
    // ... and its cleanup removes only imports older than itself
    expect(chunks(db, 'p1').some((c) => c.import_id === newer)).toBe(true);
  });
  it('stage_detail is safe to repeat (a retried chunk replaces itself)', async () => {
    const db = fakeService(seed());
    const id = importId();
    const rows = chunkRows(buildDetailRows(readDetailReport(MODEL), { cutoff: SAMPLE_CUTOFF, year: 2026 }).rows)[0];
    await T(db, 'stage_detail', 'p1', { import_id: id, seq: 0, rows });
    await T(db, 'stage_detail', 'p1', { import_id: id, seq: 0, rows });
    expect(chunks(db, 'p1').filter((c) => c.seq === 0)).toHaveLength(1);
  });
  it('rows must be whole cents with the required keys', async () => {
    const db = fakeService(seed());
    const r = await T(db, 'stage_detail', 'p1', { import_id: importId(), seq: 0, rows: [{ r: 9, d: '2026-01-02', a: 1.5, p: 'x', ok: true }] });
    expect(r.status).toBe(400);
  });
});

describe('review, finalize and publish with detail attached', () => {
  it('differences are warnings in the review (one cause), never blockers; finalize refreshes the stored reconciliation', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    const chk = await T(db, 'check', 'p1');
    const causes = chk.body.review.causes;
    const detail = causes.filter((c) => c.key === 'transaction_detail');
    expect(detail).toHaveLength(1);
    expect(detail[0].bucket).toBe('warnings');
    expect(causes.filter((c) => c.bucket === 'blockers').some((c) => c.key === 'transaction_detail')).toBe(false);
    const fin = await T(db, 'finalize', 'p1');
    expect(fin.status).toBe(200);
    expect(db.tables.ReportingPeriod.get('p1').detail_import.reconciled_at).toBe(NOW.toISOString());
  });
});

describe('drill-down endpoints', () => {
  async function published(db) {
    await attach(db, 'p1');
    await T(db, 'finalize', 'p1');
    Object.assign(db.tables.ReportingPeriod.get('p1'), { published: true, publication_date: '2026-10-17' });
  }
  const groupLine = (db, g) => db.rows('BudgetLine').find((l) => l.budget_group === g && !l.bva_detail);
  it('public: exactly date, payee, signed amount, plain account name -- nothing internal', async () => {
    const db = fakeService(seed());
    await published(db);
    const line = groupLine(db, 'variable');
    const r = await handlePublicCategoryRequest(db.base44, { period_id: 'p1', budget_line_id: line.id });
    expect(r.status).toBe(200);
    expect(r.body.detail_available).toBe(true);
    expect(r.body.transactions.length).toBeGreaterThan(0);
    for (const t of r.body.transactions) expect(Object.keys(t).sort()).toEqual([...PUBLIC_TRANSACTION_FIELDS].sort());
    expect(JSON.stringify(r.body)).not.toMatch(/ZZ MEMO|ZZ Card 0001|ZZ Bank 0002|VARIABLE COSTS:|Credit Card Credit|ZZ Person A/);
    expect(r.body.note).toMatch(/The report figure is the one used on this dashboard|matching the report/);
  });
  it('public: a draft version is not served', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    const r = await handlePublicCategoryRequest(db.base44, { period_id: 'p1', budget_line_id: groupLine(db, 'fixed').id });
    expect(r.status).toBe(403);
  });
  it('public: a version whose chunks are not all readable answers "try again", never partial rows', async () => {
    const db = fakeService(seed());
    await published(db);
    const one = chunks(db, 'p1')[0];
    db.tables.TransactionDetailChunk.delete(one.id);
    const r = await handlePublicCategoryRequest(db.base44, { period_id: 'p1', budget_line_id: groupLine(db, 'variable').id });
    expect(r.status).toBe(503);
  });
  it('admin: every field plus the reconciliation and the unmapped summary', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    const line = groupLine(db, 'variable');
    const r = await handleCategoryTransactionsRequest(db.base44, { period_id: 'p1', category: line.category }, ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('detail_report');
    expect(r.body.reconciliation).toMatchObject({ key: 'group:variable' });
    expect(r.body.transactions[0]).toEqual(expect.objectContaining({ full_account_path: expect.any(String), payment_account: expect.any(String), client_visible: expect.any(Boolean) }));
    expect(r.body.unmapped.count).toBeGreaterThan(0);
  });
});

describe('no orphaned uploads (found on staging)', () => {
  it('a refused commit removes the chunks its upload staged; the attached import stays', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    const current = db.tables.ReportingPeriod.get('p1').detail_import.import_id;
    const bad = structuredClone(MODEL); bad.rows.find((x) => /^\d\d\//.test(String(x.B || ''))).I += 0.01;
    expect((await attach(db, 'p1', { model: bad })).body.blockers[0].code).toBe('detail_checks_failed');
    expect((await attach(db, 'p1', { tamperChunk: (r) => { r[0].a += 1; return r; } })).body.blockers[0].code).toBe('detail_staged_mismatch');
    expect(new Set(chunks(db, 'p1').map((c) => c.import_id))).toEqual(new Set([current]));
  });
  it('a correction copies only the attached import, never an abandoned upload\'s chunks', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    await T(db, 'finalize', 'p1');
    Object.assign(db.tables.ReportingPeriod.get('p1'), { published: true, publication_date: '2026-10-17' });
    db.tables.TransactionDetailChunk.set('orphan', { id: 'orphan', period_id: 'p1', import_id: `${Date.now()}-orphan01`, seq: 0, rows: [{ r: 1, d: '2026-01-01', a: 1, p: 'x', ok: true }] });
    const prep = await handlePeriodTransition(db.base44, { action: 'prepare_import', month: 8, year: 2026, filename: 'ZZ corrected.xlsx' }, ADMIN, NOW);
    const rev = db.tables.ReportingPeriod.get(prep.body.target_id);
    expect(rev.copy_status).toBe('verified');
    expect(chunks(db, rev.id).every((c) => c.import_id === rev.detail_import.import_id)).toBe(true);
    expect(chunks(db, rev.id).flatMap((c) => c.rows).length).toBe(rev.detail_import.rows_stored);
  });
});

describe('Phase 4: a correction starts with a copy; the published detail never changes', () => {
  it('upload a corrected BVA -> the correction has the detail; re-attaching changes only the correction', async () => {
    const db = fakeService(seed());
    await attach(db, 'p1');
    await T(db, 'finalize', 'p1');
    Object.assign(db.tables.ReportingPeriod.get('p1'), { published: true, publication_date: '2026-10-17' });
    const publishedChunks = structuredClone(chunks(db, 'p1'));
    const prep = await handlePeriodTransition(db.base44, { action: 'prepare_import', month: 8, year: 2026, filename: 'ZZ corrected.xlsx' }, ADMIN, NOW);
    expect(prep.body).toMatchObject({ ok: true, mode: 'correct' });
    const rev = prep.body.target_id;
    expect(chunks(db, rev).flatMap((c) => c.rows).length).toBe(db.tables.ReportingPeriod.get(rev).detail_import.rows_stored);
    // a later QuickBooks export attached to the correction
    const later = makeDetailModel({ year: 2026, scale: 3, cutoffMonth: 7, seed: 99 });
    expect((await attach(db, rev, { model: later })).status).toBe(200);
    expect(chunks(db, 'p1')).toEqual(publishedChunks); // the published version's detail is untouched
    expect((await attach(db, 'p1', { model: later })).body.blockers[0].code).toBe('detail_frozen');
  });
});

describe('full size (about 2,600 fictional rows, like the real export)', () => {
  it('attach, finalize, publish, correction copy and public answer at full size', async () => {
    const big = makeDetailModel({ year: 2026, scale: 30, cutoffMonth: 7 });
    const total = readDetailReport(big).transactions.length;
    expect(total).toBeGreaterThan(2400);
    const db = fakeService(seed());
    const t0 = Date.now();
    const r = await attach(db, 'p1', { model: big });
    expect(r.status).toBe(200);
    const di = db.tables.ReportingPeriod.get('p1').detail_import;
    expect(di.rows_total).toBe(total);
    expect(di.rows_stored + di.after_cutoff.count).toBe(total);
    expect(di.chunks).toBe(Math.ceil(di.rows_stored / 250));
    expect(JSON.stringify(validationPackage(big)).length).toBeLessThan(600000);
    expect((await T(db, 'finalize', 'p1')).status).toBe(200);
    Object.assign(db.tables.ReportingPeriod.get('p1'), { published: true, publication_date: '2026-10-17' });
    const line = db.rows('BudgetLine').find((l) => l.budget_group === 'discretionary' && !l.bva_detail);
    const pub = await handlePublicCategoryRequest(db.base44, { period_id: 'p1', budget_line_id: line.id });
    expect(pub.status).toBe(200);
    expect(pub.body.transactions.length).toBeGreaterThan(500);
    const prep = await handlePeriodTransition(db.base44, { action: 'prepare_import', month: 8, year: 2026, filename: 'ZZ corrected.xlsx' }, ADMIN, NOW);
    expect(prep.body.mode).toBe('correct');
    const rev = db.tables.ReportingPeriod.get(prep.body.target_id);
    expect(rev.copy_status).toBe('verified');
    expect(chunks(db, rev.id).flatMap((c) => c.rows).length).toBe(di.rows_stored);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 30000);
});
