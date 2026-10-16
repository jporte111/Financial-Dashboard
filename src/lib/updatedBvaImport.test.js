// The updated-BVA workflow: uploading a workbook for a month decides where it
// goes (prepare_import), using the Phase 4 revision rules unchanged; the
// published version is never written; a repeated upload never makes a second
// revision. Plus what the screen shows (importIntent) and what changed
// (changeSummary). All data is fictional.
import { describe, it, expect, afterEach } from 'vitest';
import { handlePeriodTransition, updatedWorkbookReason, PREPARE_COPY_ROUNDS } from '../../base44/shared/periodTransitionCore.ts';
import { copyOptions } from '../../base44/shared/periodRevisionCore.ts';
import { monthState } from '../../base44/shared/periodVersions.ts';
import { planBvaImport, importTarget, importIntent } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { changeSummary, planRecords, previousCorrections } from './bvaChangeSummary.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { fakeService } from './__fixtures__/fakeService.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2026-10-16T12:00:00Z');
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
const COPY_DEFAULTS = { ...copyOptions };
afterEach(() => Object.assign(copyOptions, COPY_DEFAULTS));

function planOf(mutate = () => {}) {
  const parsed = cleanParsed();
  mutate(parsed);
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
  return planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
}
function seed({ published = true, final = true, extraPeriods = [] } = {}) {
  const plan = planOf();
  const p = {
    id: 'orig', label: 'July 2026', ...plan.periodData,
    status: final ? 'final' : 'draft', bva_import_status: final ? 'final' : 'draft', ...(final ? { finalized_at: '2026-08-04T00:00:00Z' } : {}),
    published, checklist: CHECKLIST, ...(published ? { publication_date: '2026-08-05' } : {}),
    bva_corrections: [
      { id: 'g1', kind: 'group', target: '6100', value: 'fixed', by: 'a', at: 't' },
      { id: 's1', kind: 'source', target: 'Cash total', path: 'cash.reportedTotal', original_value: 1, value: 2, reason: 'fictional fix', by: 'a', at: 't' },
      { id: 'v1', kind: 'savings', target: 'savings_in_ytd', value: 5, by: 'a', at: 't' },
    ],
  };
  const rows = (b, prefix) => b.toCreate.map((r, i) => ({ id: `${prefix}${i + 1}`, period_id: 'orig', ...r }));
  return {
    ReportingPeriod: [p, ...extraPeriods],
    BudgetLine: rows(plan.budgetLines, 'l'),
    CashAccount: rows(plan.cashAccounts, 'c'),
    Distribution: rows(plan.distributions, 'd'),
    RecurringTransfer: rows(plan.transfers, 't'),
    SavingsSpend: [],
    Transaction: Array.from({ length: 12 }, (_, i) => ({ id: `x${i + 1}`, period_id: 'orig', date: '2026-07-02', amount: i + 1, category: 'ZZ', vendor: `Test vendor ${i}` })),
  };
}
const prepare = (db, extra = {}, user = ADMIN) => handlePeriodTransition(db.base44, { action: 'prepare_import', month: 7, year: 2026, filename: 'BVA Test July.xlsx', ...extra }, user, NOW);
const writesTo = (db, id) => db.log.filter((w) => w.id === id && w.op !== 'create');
const versions = (db) => db.rows('ReportingPeriod').filter((p) => p.month === 7 && p.year === 2026);

describe('prepare_import: where an upload goes', () => {
  it('no report for the month yet: create', async () => {
    const db = fakeService({ ReportingPeriod: [], BudgetLine: [], CashAccount: [], Distribution: [], RecurringTransfer: [], SavingsSpend: [], Transaction: [] });
    const r = await prepare(db);
    expect(r.body).toMatchObject({ ok: true, mode: 'create', target_id: null });
    expect(db.log).toHaveLength(0);
  });

  it('an unpublished draft is updated in place (no revision)', async () => {
    const db = fakeService(seed({ published: false, final: false }));
    const r = await prepare(db);
    expect(r.body).toMatchObject({ ok: true, mode: 'update', target_id: 'orig' });
    expect(db.log).toHaveLength(0);
  });

  it('an unpublished FINAL report is updated in place too (no revision)', async () => {
    const db = fakeService(seed({ published: false, final: true }));
    const r = await prepare(db);
    expect(r.body).toMatchObject({ ok: true, mode: 'update', target_id: 'orig' });
    expect(versions(db)).toHaveLength(1);
  });

  it('a published month: a verified draft revision is created; the published version is never written', async () => {
    const db = fakeService(seed());
    const r = await prepare(db, { note: 'Bookkeeper corrected the cash block.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'correct', source_id: 'orig', revision_number: 2 });
    const rev = db.tables.ReportingPeriod.get(r.body.target_id);
    expect(rev).toMatchObject({ supersedes: 'orig', copy_status: 'verified', revision_status: 'open', published: false });
    expect(rev.revision_reason).toBe('Updated BVA workbook BVA Test July.xlsx uploaded by admin@example.invalid on 2026-10-16. Note: Bookkeeper corrected the cash block.');
    expect(writesTo(db, 'orig')).toEqual([]);
    expect(db.rows('Transaction').filter((x) => x.period_id === rev.id)).toHaveLength(12); // transactions copied, untouched by the import
    // the importer then targets exactly that revision
    expect(importTarget(db.rows('ReportingPeriod'), 7, 2026, rev.id)).toMatchObject({ allowed: true, action: 'update', target: { id: rev.id } });
  });

  it('the note is optional; the automatic reason meets the revision reason minimum', () => {
    const reason = updatedWorkbookReason({ filename: '', who: 'a@b.c', now: NOW });
    expect(reason).toBe('Updated BVA workbook workbook uploaded by a@b.c on 2026-10-16');
    expect(reason.length).toBeGreaterThanOrEqual(10);
  });

  it('uploading again reuses the correction in progress (no second revision)', async () => {
    const db = fakeService(seed());
    const first = await prepare(db);
    const second = await prepare(db);
    expect(second.body).toMatchObject({ ok: true, mode: 'continue', target_id: first.body.target_id });
    expect(monthState(versions(db)).openRevisions).toHaveLength(1);
  });

  it('two uploads at the same moment end with one revision', async () => {
    const db = fakeService(seed());
    const [a, b] = await Promise.all([prepare(db), prepare(db)]);
    const open = monthState(versions(db).filter((p) => p.revision_status !== 'discarded')).openRevisions;
    expect(open).toHaveLength(1);
    for (const r of [a, b]) if (r.status === 200) expect(r.body.target_id).toBe(open[0].id);
  });

  it('a copy that is not finished is continued; nothing is imported until it verifies', async () => {
    copyOptions.batchSize = 1;
    copyOptions.budgetMs = -1; // one batch per round
    const db = fakeService(seed());
    const r = await prepare(db);
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('copy_unverified');
    const rev = db.tables.ReportingPeriod.get(r.body.target_id);
    expect(rev.copy_status).not.toBe('verified');
    expect(importTarget(db.rows('ReportingPeriod'), 7, 2026, rev.id).allowed).toBe(false); // the importer refuses it
    Object.assign(copyOptions, COPY_DEFAULTS);
    const again = await prepare(db);
    expect(again.body).toMatchObject({ ok: true, mode: 'continue', target_id: rev.id });
    expect(db.tables.ReportingPeriod.get(rev.id).copy_status).toBe('verified');
    expect(PREPARE_COPY_ROUNDS).toBeGreaterThan(1);
  });

  it('exceptional states are refused with a pointer to History & recovery', async () => {
    const twoPublished = seed({ extraPeriods: [{ id: 'dup', label: 'July 2026', month: 7, year: 2026, status: 'final', bva_import_status: 'final', published: true, revision_number: 2, supersedes: 'orig' }] });
    const r = await prepare(fakeService(twoPublished));
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].message).toMatch(/History & recovery/);
  });

  it('only admins', async () => {
    expect((await prepare(fakeService(seed()), {}, { role: 'user', email: 'u@example.invalid' })).status).toBe(403);
  });
});

describe('importIntent: what the screen says', () => {
  const P = (id, extra) => ({ id, label: 'July 2026', month: 7, year: 2026, ...extra });
  it.each([
    ['nothing yet', [], 'create'],
    ['a draft', [P('a', { status: 'draft', bva_import_status: 'draft', published: false })], 'update'],
    ['a final, unpublished', [P('a', { status: 'final', bva_import_status: 'final', published: false, finalized_at: 'x' })], 'update'],
    ['published', [P('a', { status: 'final', bva_import_status: 'final', published: true })], 'correct'],
    ['published + correction in progress', [P('a', { status: 'final', bva_import_status: 'final', published: true }), P('b', { status: 'draft', published: false, supersedes: 'a', revision_number: 2, revision_status: 'open', copy_status: 'verified' })], 'continue'],
  ])('%s -> %s', (_, periods, mode) => {
    expect(importIntent(periods, 7, 2026).mode).toBe(mode);
  });
});

describe('changeSummary: what changed in the updated workbook', () => {
  const before = (() => { const p = planOf(); return planRecords(p); })();
  it('the same workbook: identical (nothing to correct)', () => {
    expect(changeSummary(before, planRecords(planOf())).identical).toBe(true);
  });
  it('a changed balance and line are listed, before -> after; the headline follows the month page', () => {
    const after = planRecords(planOf((p) => { p.cash.accounts[0].balance += 100; p.cash.reportedTotal += 100; p.income.categories[0].actualYtd += 5; }));
    const s = changeSummary(before, after);
    expect(s.identical).toBe(false);
    expect(s.cash.changed[0]).toMatchObject({ field: 'balance', after: s.cash.changed[0].before + 100 });
    expect(s.headline.find((h) => h.label === 'Total Cash')).toMatchObject({ changed: true });
    expect(s.lines.changed.some((c) => c.field === 'year to date')).toBe(true);
  });
  it('a value that became blank is a change to missing (never $0.00)', () => {
    const after = planRecords(planOf((p) => { p.cash.accounts[0].balance = null; }));
    const c = changeSummary(before, after).cash.changed[0];
    expect(c.after).toBe(null);
  });
  it('previous manual corrections: value corrections are not carried; classifications are; savings are kept', () => {
    const pc = previousCorrections(seed().ReportingPeriod[0].bva_corrections);
    expect(pc.notApplied.map((c) => c.kind)).toEqual(['source']);
    expect(pc.groupsCarried).toHaveLength(1);
    expect(pc.savingsKept).toHaveLength(1);
  });
});
