// Uploading another corrected workbook right after publishing a correction.
// Base44 reads can lag writes: just after a publish, prepare_import may see the
// correction still unpublished, or the replaced version not yet superseded.
// These tests replay those stale views (fakeService `read`) and require that
// the upload either becomes a correction OF THE JUST-PUBLISHED version or is
// refused with a clear "try again" -- never a correction of the replaced
// version, never a second correction, nothing written on a refusal. Also the
// copy of the published report under read lag. All data is fictional.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { handlePeriodTransition, prepareOptions } from '../../base44/shared/periodTransitionCore.ts';
import { copyOptions } from '../../base44/shared/periodRevisionCore.ts';
import { monthState } from '../../base44/shared/periodVersions.ts';
import { planBvaImport, importIntent, importTarget } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { fakeService } from './__fixtures__/fakeService.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2026-10-17T12:00:00Z');
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
const PREPARE_DEFAULTS = { ...prepareOptions };
const COPY_DEFAULTS = { ...copyOptions };
beforeEach(() => {
  // no real pauses in tests; the number of pauses is what matters
  Object.assign(prepareOptions, { settleDelaysMs: [0, 0, 0, 0] });
  Object.assign(copyOptions, { visibleDelaysMs: [0, 0, 0, 0], verifyDelaysMs: [0, 0, 0, 0] });
});
afterEach(() => { Object.assign(prepareOptions, PREPARE_DEFAULTS); Object.assign(copyOptions, COPY_DEFAULTS); });

function seed() {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF } });
  const rows = (b, prefix) => b.toCreate.map((r, i) => ({ id: `${prefix}${i + 1}`, period_id: 'orig', ...r }));
  return {
    ReportingPeriod: [{ id: 'orig', label: 'July 2026', ...plan.periodData, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-04T00:00:00Z', published: true, publication_date: '2026-08-05', checklist: CHECKLIST, updated_date: '2026-08-05T00:00:00Z' }],
    BudgetLine: rows(plan.budgetLines, 'l'),
    CashAccount: rows(plan.cashAccounts, 'c'),
    Distribution: rows(plan.distributions, 'd'),
    RecurringTransfer: rows(plan.transfers, 't'),
    SavingsSpend: [],
    Transaction: Array.from({ length: 12 }, (_, i) => ({ id: `x${i + 1}`, period_id: 'orig', date: '2026-07-02', amount: i + 1, category: 'ZZ', vendor: `Test vendor ${i}` })),
  };
}
const prepare = (db, now = NOW) => handlePeriodTransition(db.base44, { action: 'prepare_import', month: 7, year: 2026, filename: 'BVA Test July.xlsx' }, ADMIN, now);
const periods = (db) => db.rows('ReportingPeriod');
const clone = (x) => structuredClone(x);

// The month after a correction (rev) of `orig` was published -- both publish
// writes done -- plus the stale views a lagging read could return.
async function justPublished({ publishedAt = NOW } = {}) {
  const views = { stale: null, hide: { filter: 0, get: 0 } };
  const db = fakeService(seed(), {
    read: (entity, op, args, result) => {
      if (entity !== 'ReportingPeriod' || !views.stale || !(views.hide[op] > 0)) return result;
      views.hide[op] -= 1;
      if (op === 'get') return clone(views.stale.get(args.id) ?? result);
      return result.map((r) => clone(views.stale.get(r.id) ?? r));
    },
  });
  const first = await prepare(db);
  const rev = first.body.target_id;
  const t = db.tables.ReportingPeriod;
  Object.assign(t.get(rev), { status: 'final', bva_import_status: 'final', finalized_at: 'x', checklist: CHECKLIST });
  const finalUnpublished = { rev: clone(t.get(rev)), orig: clone(t.get('orig')) };
  Object.assign(t.get(rev), { published: true, publication_date: '2026-10-17', updated_date: publishedAt.toISOString() });
  Object.assign(t.get('orig'), { superseded: true, superseded_by: rev, published: false });
  const s = (revRec, origRec) => new Map([[rev, revRec], ['orig', origRec]]);
  const patterns = {
    // neither publish write visible
    neither: s(finalUnpublished.rev, finalUnpublished.orig),
    // the correction shows as published, the replaced version not yet superseded
    firstOnly: s(clone(t.get(rev)), finalUnpublished.orig),
    // the replaced version shows superseded, the correction not yet published
    secondOnly: s(finalUnpublished.rev, clone(t.get('orig'))),
  };
  db.log.length = 0;
  return { db, rev, views, patterns };
}
const created = (db) => db.log.filter((w) => w.entity === 'ReportingPeriod' && w.op === 'create');
const expectCorrectionOf = (db, r, rev) => {
  expect(r.status).toBe(200);
  expect(r.body.mode).toBe('correct');
  const next = db.tables.ReportingPeriod.get(r.body.target_id);
  expect(next.supersedes).toBe(rev); // a correction of the JUST-PUBLISHED version
  expect(next.copy_status).toBe('verified');
  // never a correction of the replaced version; exactly one correction
  expect(periods(db).filter((p) => p.supersedes === 'orig' && p.id !== rev)).toEqual([]);
  expect(monthState(periods(db)).unpublishedRevisions.map((p) => p.id)).toEqual([next.id]);
};

describe('upload right after a correction is published', () => {
  it('no lag: a correction of the published correction', async () => {
    const { db, rev } = await justPublished();
    const r = await prepare(db);
    expectCorrectionOf(db, r, rev);
    expect(r.body.settle_attempts).toBe(1);
  });

  it.each(['neither', 'firstOnly', 'secondOnly'])('stale list (%s publish writes visible): read again, then a correction of the published correction', async (pattern) => {
    const { db, rev, views, patterns } = await justPublished();
    Object.assign(views, { stale: patterns[pattern], hide: { filter: 2, get: 0 } });
    const r = await prepare(db);
    expectCorrectionOf(db, r, rev);
    expect(r.body.settle_attempts).toBeGreaterThan(1);
  });

  it('stale list AND stale by-id reads (neither write visible): the final correction is confirmed on a second read before anything is decided', async () => {
    const { db, rev, views, patterns } = await justPublished();
    Object.assign(views, { stale: patterns.neither, hide: { filter: 1, get: 2 } });
    const r = await prepare(db);
    expectCorrectionOf(db, r, rev);
  });

  it.each(['neither', 'firstOnly', 'secondOnly'])('never settles (%s): refused "try again", nothing written', async (pattern) => {
    const { db, views, patterns } = await justPublished();
    Object.assign(views, { stale: patterns[pattern], hide: { filter: 1000, get: pattern === 'neither' ? 1000 : 0 } });
    const r = await prepare(db);
    // `neither` with every read stale is indistinguishable from a final,
    // unpublished correction: it is offered as the target (the importer's
    // invalidate and Base44's rule on published records refuse the write);
    // no new correction is created either way.
    if (pattern === 'neither') {
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('continue');
    } else {
      expect(r.status).toBe(409);
      expect(r.body.blockers[0].code).toBe('state_settling');
      expect(r.body.blockers[0].message).toMatch(/not visible yet\. Nothing was imported; try the upload again in a few seconds/);
      expect(r.body.observed.length).toBeGreaterThan(0);
    }
    expect(created(db)).toEqual([]);
    expect(db.log.filter((w) => w.op !== 'create')).toEqual([]);
  });

  it('a replacement unfinished long after its publish is a real interruption: refused with the pointer to recovery', async () => {
    const { db, views, patterns } = await justPublished({ publishedAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    Object.assign(views, { stale: patterns.firstOnly, hide: { filter: 1000, get: 1000 } });
    const r = await prepare(db);
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('supersede_pending');
    expect(r.body.blockers[0].message).toMatch(/History & recovery/);
    expect(created(db)).toEqual([]);
  });

  it('a chain: after a second published correction, the next upload corrects the latest one (the earlier ones are all superseded)', async () => {
    const { db, rev } = await justPublished();
    const second = await prepare(db);
    const rev3 = second.body.target_id;
    const t = db.tables.ReportingPeriod;
    Object.assign(t.get(rev3), { status: 'final', bva_import_status: 'final', finalized_at: 'x', published: true, updated_date: NOW.toISOString() });
    Object.assign(t.get(rev), { superseded: true, superseded_by: rev3, published: false });
    db.log.length = 0;
    const r = await prepare(db);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'correct', settle_attempts: 1 });
    expect(t.get(r.body.target_id).supersedes).toBe(rev3);
  });

  it('the screen agrees once the reads settle', async () => {
    const { db, rev } = await justPublished();
    expect(importIntent(periods(db), 7, 2026)).toMatchObject({ mode: 'correct', current: { id: rev } });
  });
});

describe('a correction marked final but not yet published', () => {
  async function finalCorrection() {
    const db = fakeService(seed());
    const first = await prepare(db);
    Object.assign(db.tables.ReportingPeriod.get(first.body.target_id), { status: 'final', bva_import_status: 'final', finalized_at: 'x' });
    db.log.length = 0;
    return { db, rev: first.body.target_id };
  }
  it('a new upload updates it in place (back to draft) -- never a second correction', async () => {
    const { db, rev } = await finalCorrection();
    const r = await prepare(db);
    expect(r.body).toMatchObject({ ok: true, mode: 'continue', target_id: rev });
    expect(created(db)).toEqual([]);
    expect(importIntent(periods(db), 7, 2026)).toMatchObject({ mode: 'continue', target: { id: rev } });
    expect(importTarget(periods(db), 7, 2026, rev)).toMatchObject({ allowed: true, target: { id: rev }, needsInvalidate: true });
  });
  it('no other correction can be created beside it', async () => {
    const { db } = await finalCorrection();
    const r = await handlePeriodTransition(db.base44, { action: 'create_revision', period_id: 'orig', reason: 'Fictional second correction' }, ADMIN, NOW);
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('open_revision_exists');
  });
});

describe('the copy of the published report under read lag', () => {
  // Rows just created for a revision are briefly invisible to reads.
  function laggingCopies() {
    const hide = {};
    const db = fakeService(seed(), {
      hook: (entity, op, args, phase) => { if (op === 'bulkCreate' && phase === 'after' && args.list[0]?.period_id !== 'orig') hide[entity] = (hide[entity] || 0) + 2; },
      read: (entity, op, args, result) => {
        if (op !== 'filter' || !hide[entity] || args.q?.period_id === 'orig' || !args.q?.period_id) return result;
        hide[entity] -= 1;
        return result.slice(0, Math.max(0, result.length - 1)); // the newest row not visible yet
      },
    });
    return db;
  }
  it('the copy waits for its rows and is verified (not failed) despite lagging reads', async () => {
    const db = laggingCopies();
    const r = await prepare(db);
    expect(r.body).toMatchObject({ ok: true, mode: 'correct' });
    const rev = db.tables.ReportingPeriod.get(r.body.target_id);
    expect(rev.copy_status).toBe('verified');
    expect(db.rows('Transaction').filter((x) => x.period_id === rev.id)).toHaveLength(12); // no duplicates
  });
  it('without the waits the same lag fails verification (so the test exercises the lag)', async () => {
    Object.assign(copyOptions, { visibleDelaysMs: [], verifyDelaysMs: [] });
    const db = laggingCopies();
    const r = await prepare(db);
    expect(r.status).toBe(409);
  });
  it('a genuinely wrong copy still fails; the correction this upload created is removed so the next upload starts afresh', async () => {
    let corrupt = true;
    const db = fakeService(seed(), {
      hook: (entity, op, args, phase) => { if (corrupt && entity === 'Transaction' && op === 'bulkCreate' && phase === 'before' && args.list[0]?.period_id !== 'orig') args.list[0].amount += 1; },
    });
    const r = await prepare(db);
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('copy_failed_retry');
    expect(r.body.blockers[0].message).toMatch(/removed and nothing was imported\. Try the upload again/);
    expect(periods(db).map((p) => p.id)).toEqual(['orig']); // removed, rows too
    expect(db.rows('Transaction').every((x) => x.period_id === 'orig')).toBe(true);
    corrupt = false;
    const again = await prepare(db);
    expect(again.body).toMatchObject({ ok: true, mode: 'correct' });
    expect(db.tables.ReportingPeriod.get(again.body.target_id).copy_status).toBe('verified');
  });
});
