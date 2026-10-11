// Draft revisions on the server (periodTransitionCore.ts + periodRevisionCore.ts):
// create, copy and verify, finalize, publish as the replacement, retry,
// stale and competing revisions, discard -- and what clients see throughout.
// All data is fictional.
import { describe, it, expect, afterEach } from 'vitest';
import { handlePeriodTransition } from '../../base44/shared/periodTransitionCore.ts';
import { copyOptions } from '../../base44/shared/periodRevisionCore.ts';
import { buildPublicDashboard } from '../../base44/shared/publicDashboardCore.ts';
import { transactionsForCategory } from '../../base44/shared/categoryTransactionsCore.ts';
import { handlePublicCategoryRequest } from '../../base44/shared/publicDashboardCore.ts';
import { monthState } from '../../base44/shared/periodVersions.ts';
import { planBvaImport, importTarget } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { fakeService } from './__fixtures__/fakeService.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2026-10-06T12:00:00Z');
const REASON = 'Correct the fictional cash figure.';
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
const COPY_DEFAULTS = { ...copyOptions };
afterEach(() => Object.assign(copyOptions, COPY_DEFAULTS));

// A final (and optionally published) July with lines, cash, distributions,
// transfers, savings spends and transactions.
function seed({ published = true, transactions = 30 } = {}) {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const p = {
    id: 'orig', label: 'July 2026', ...plan.periodData, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-04T00:00:00Z',
    published, checklist: CHECKLIST, ...(published ? { publication_date: '2026-08-05' } : {}),
  };
  const rows = (b, prefix) => b.toCreate.map((r, i) => ({ id: `${prefix}${i + 1}`, period_id: 'orig', ...r }));
  const lines = rows(plan.budgetLines, 'l');
  const cats = lines.map((l) => l.category);
  return {
    ReportingPeriod: [p, { id: 'june', label: 'June 2026', month: 6, year: 2026, status: 'final', bva_import_status: 'final', published: true, checklist: CHECKLIST }],
    BudgetLine: [...lines, { id: 'jl1', period_id: 'june', category: cats[0], month_actual: 1 }],
    CashAccount: rows(plan.cashAccounts, 'c'),
    Distribution: rows(plan.distributions, 'd'),
    RecurringTransfer: rows(plan.transfers, 't'),
    SavingsSpend: [{ id: 'ss1', period_id: 'orig', category: 'Test repair', ytd_amount: 12 }],
    Transaction: [
      ...Array.from({ length: transactions }, (_, i) => ({ id: `x${i + 1}`, period_id: 'orig', date: '2026-07-0' + ((i % 9) + 1), amount: i + 1, category: cats[i % cats.length], account_id: 'acct1', vendor: `Test vendor ${i}` })),
      { id: 'jx1', period_id: 'june', date: '2026-06-02', amount: 5, category: cats[0], account_id: 'acct1' },
    ],
    Account: [{ id: 'acct1', account_name: cats[0], top_level_group: 'fixed', source: 'quickbooks' }],
  };
}
const t = (db, action, periodId, extra = {}, user = ADMIN, now = NOW) => handlePeriodTransition(db.base44, { action, period_id: periodId, ...extra }, user, now);
const rowsOf = (db, entity, pid) => db.rows(entity).filter((r) => r.period_id === pid);
const ENTS = ['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend', 'Transaction'];
async function revise(db, source = 'orig') {
  const r = await t(db, 'create_revision', source, { reason: REASON });
  expect(r.status).toBe(200);
  return r.body.period_id;
}
async function finalizeAndTick(db, rid) {
  const f = await t(db, 'finalize', rid);
  expect(f.status).toBe(200);
  await confirmChecklist(db, rid); // the admin confirms the checklist
}
// Confirm every checklist item through the real server action.
async function confirmChecklist(db, pid) {
  for (const [item] of PUBLISH_CHECKLIST) expect((await t(db, 'confirm_checklist', pid, { item })).status).toBe(200);
}

describe('create a revision', () => {
  it('of a published report: a draft copy whose every row, value and relationship is verified; clients still see the original', async () => {
    const db = fakeService(seed());
    const rid = await revise(db);
    const rev = db.tables.ReportingPeriod.get(rid);
    expect(rev).toMatchObject({ status: 'draft', published: false, supersedes: 'orig', revision_of: 'orig', revision_number: 2, revision_reason: REASON, copy_status: 'verified', label: 'July 2026' });
    for (const e of ENTS) {
      const src = rowsOf(db, e, 'orig');
      const cp = rowsOf(db, e, rid);
      expect(cp.length).toBe(src.length);
      expect(new Set(cp.map((c) => c.copied_from))).toEqual(new Set(src.map((s) => s.id)));
    }
    expect(rev.copy_verification).toMatchObject({ ok: true, relationships: { transactions_to_lines: 'resolve as in the source' } });
    // Clients: unchanged.
    const pub = await buildPublicDashboard(db.base44.asServiceRole, { period_id: 'orig' });
    expect(pub.period.id).toBe('orig');
    expect(pub.periods.map((p) => p.id)).toEqual(['orig', 'june']);
    // The source is untouched.
    expect(db.log.filter((w) => w.id === 'orig')).toEqual([]);
  });

  it('of a final but unpublished report', async () => {
    const db = fakeService(seed({ published: false }));
    const rid = await revise(db);
    expect(db.tables.ReportingPeriod.get(rid)).toMatchObject({ supersedes: 'orig', copy_status: 'verified' });
  });

  it('is refused for a draft, a superseded or discarded version, a non-current version, and while a revision is open', async () => {
    const draft = fakeService(seed());
    draft.tables.ReportingPeriod.get('orig').status = 'draft';
    draft.tables.ReportingPeriod.get('orig').bva_import_status = 'draft';
    draft.tables.ReportingPeriod.get('orig').published = false;
    expect((await t(draft, 'create_revision', 'orig', { reason: REASON })).body.blockers[0].code).toBe('source_not_final');
    const db = fakeService(seed());
    expect((await t(db, 'create_revision', 'orig', { reason: 'short' })).body.blockers[0].code).toBe('revision_reason_required');
    await revise(db);
    expect((await t(db, 'create_revision', 'orig', { reason: REASON })).body.blockers[0].code).toBe('open_revision_exists');
    const sup = fakeService(seed());
    sup.tables.ReportingPeriod.get('orig').superseded = true;
    expect((await t(sup, 'create_revision', 'orig', { reason: REASON })).body.blockers[0].code).toBe('superseded_read_only');
  });

  it('copies in batches and resumes where it stopped; verification only after the copy completes', async () => {
    Object.assign(copyOptions, { batchSize: 7, budgetMs: -1 }); // stop after every batch
    const db = fakeService(seed({ transactions: 40 }));
    const first = await t(db, 'create_revision', 'orig', { reason: REASON });
    expect(first.body.copy.done).toBe(false);
    const rid = first.body.period_id;
    expect(db.tables.ReportingPeriod.get(rid).copy_status).toBe('copying');
    expect((await t(db, 'finalize', rid)).body.blockers[0].code).toBe('revision_copy_unverified');
    let r;
    for (let i = 0; i < 40; i++) {
      r = await t(db, 'copy_revision', rid);
      if (r.body.copy.done) break;
    }
    expect(r.body.copy).toMatchObject({ done: true, verified: true });
    for (const e of ENTS) expect(rowsOf(db, e, rid).length).toBe(rowsOf(db, e, 'orig').length);
  });
});

describe('copy verification checks values and relationships, not just counts', () => {
  const tamper = async (fn) => {
    Object.assign(copyOptions, { budgetMs: -1, batchSize: 1000 });
    const db = fakeService(seed());
    const first = await t(db, 'create_revision', 'orig', { reason: REASON });
    const rid = first.body.period_id;
    // Finish copying everything, then tamper before verification runs.
    Object.assign(copyOptions, COPY_DEFAULTS);
    for (const e of ENTS) {
      const have = new Set(rowsOf(db, e, rid).map((c) => c.copied_from));
      for (const s of rowsOf(db, e, 'orig')) if (!have.has(s.id)) db.tables[e].set(`cp-${s.id}`, { ...s, id: `cp-${s.id}`, period_id: rid, copied_from: s.id });
    }
    fn(db, rid);
    const r = await t(db, 'copy_revision', rid);
    return { db, rid, report: db.tables.ReportingPeriod.get(rid).copy_verification, r };
  };
  const firstCopy = (db, rid, e) => rowsOf(db, e, rid)[0];

  it('a changed value', async () => {
    const { report, db, rid } = await tamper((db, rid) => { firstCopy(db, rid, 'Transaction').amount = 9999; });
    expect(report.ok).toBe(false);
    expect(report.entities.Transaction.changed[0].fields).toEqual(['amount']);
    expect(db.tables.ReportingPeriod.get(rid).copy_status).toBe('failed');
    expect((await t(db, 'finalize', rid)).body.blockers[0].code).toBe('revision_copy_unverified');
  });

  it('a row copied twice, a missing row, an extra row', async () => {
    const { report } = await tamper((db, rid) => {
      const c = firstCopy(db, rid, 'CashAccount');
      db.tables.CashAccount.set('dup', { ...c, id: 'dup' });
      db.tables.Distribution.delete(firstCopy(db, rid, 'Distribution').id);
      db.tables.RecurringTransfer.set('stray', { id: 'stray', period_id: rid, purpose: 'Test', amount: 1, copied_from: 'nowhere' });
    });
    expect(report.entities.CashAccount.duplicates.length).toBe(1);
    expect(report.entities.RecurringTransfer.extra).toEqual(['stray']);
    // the missing distribution is copied again by the resumed copy, then verified
    expect(report.entities.Distribution.missing).toBeUndefined();
  });

  it('a broken relationship: a transaction category no longer resolving to a budget line', async () => {
    const { report } = await tamper((db, rid) => {
      const tx = rowsOf(db, 'Transaction', rid)[0];
      for (const l of rowsOf(db, 'BudgetLine', rid)) if (l.category === tx.category) l.category = `${l.category} (renamed)`;
    });
    expect(report.ok).toBe(false);
    expect(report.relationships.unresolved_categories.length).toBeGreaterThan(0);
  });

  it('a changed period figure', async () => {
    const { report } = await tamper((db, rid) => { db.tables.ReportingPeriod.get(rid).total_cash = 1; });
    expect(report.period.changed).toEqual(['total_cash']);
  });
});

describe('a verified copy is proof of the copy only: edits must pass the normal finalize checks', () => {
  it('a revision whose edited figures break the gate is not finalized', async () => {
    const db = fakeService(seed());
    const rid = await revise(db);
    db.tables.ReportingPeriod.get(rid).ytd_income = undefined; // an edit leaves a required value missing
    delete db.tables.ReportingPeriod.get(rid).ytd_income;
    const f = await t(db, 'finalize', rid);
    expect(f.status).toBe(409);
    expect(f.body.blockers.map((b) => b.code)).toContain('required_value_missing:ytd_income');
  });
});

describe('publish as the replacement', () => {
  it('one write switches clients; the original is then kept, superseded and unpublished', async () => {
    const db = fakeService(seed());
    const rid = await revise(db);
    db.tables.CashAccount.get(rowsOf(db, 'CashAccount', rid)[0].id).balance = 123; // the correction
    await finalizeAndTick(db, rid);
    const before = db.log.length;
    const p = await t(db, 'publish', rid);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ replaced: 'orig', supersede_pending: false });
    const writes = db.log.slice(before);
    expect(writes.map((w) => `${w.id}:${Object.keys(w.data).join(',')}`)).toEqual([
      `${rid}:published,publication_date,reviewed_by,last_updated`, // the switch
      'orig:superseded,superseded_by,superseded_at,published', // the cleanup
    ]);
    expect(db.tables.ReportingPeriod.get('orig')).toMatchObject({ superseded: true, superseded_by: rid, published: false });
    expect(rowsOf(db, 'CashAccount', 'orig').length).toBeGreaterThan(0); // kept
    const pub = await buildPublicDashboard(db.base44.asServiceRole, {});
    expect(pub.periods.map((x) => x.id)).toEqual([rid, 'june']);
    expect(pub.cashAccounts.some((c) => c.balance === 123)).toBe(true);
  });

  it('a final-but-unpublished original: its revision is published as the first publication of the month', async () => {
    const db = fakeService(seed({ published: false }));
    const rid = await revise(db);
    await finalizeAndTick(db, rid);
    expect((await t(db, 'publish', rid)).status).toBe(200);
    expect(db.tables.ReportingPeriod.get('orig')).toMatchObject({ superseded: true, published: false });
    expect((await t(db, 'publish', 'orig')).body.blockers[0].code).toBe('superseded_read_only');
  });

  it('the original is published while a revision is open: allowed; the revision can still replace it later', async () => {
    const db = fakeService(seed({ published: false }));
    const rid = await revise(db);
    await confirmChecklist(db, 'orig');
    expect((await t(db, 'publish', 'orig')).status).toBe(200);
    await finalizeAndTick(db, rid);
    expect((await t(db, 'publish', rid)).body.replaced).toBe('orig');
  });

  it('cleanup failed: clients already see the revision; the original awaits cleanup (not a conflict); a retry finishes it without a second switch', async () => {
    let fail = true;
    const db = fakeService(seed(), { hook: async (e, op, a, ph) => { if (fail && ph === 'before' && e === 'ReportingPeriod' && op === 'update' && a.data.superseded) throw new Error('network'); } });
    const rid = await revise(db);
    await finalizeAndTick(db, rid);
    const p = await t(db, 'publish', rid);
    expect(p.body.supersede_pending).toBe(true);
    const st = monthState(db.rows('ReportingPeriod').filter((x) => x.month === 7));
    expect(st.current.id).toBe(rid);
    expect(st.conflict).toBe(null);
    expect(st.pendingCleanup.map((x) => x.id)).toEqual(['orig']);
    expect((await buildPublicDashboard(db.base44.asServiceRole, { period_id: 'orig' })).period.id).toBe(rid); // the old id is not served
    expect((await handlePublicCategoryRequest(db.base44, { period_id: 'orig', category: 'x' })).status).toBe(403);
    // The original cannot be published or revised meanwhile.
    expect((await t(db, 'create_revision', 'orig', { reason: REASON })).body.blockers[0].code).toBe('supersede_pending');
    fail = false;
    const before = db.log.length;
    const retry = await t(db, 'publish', rid); // e.g. the admin clicks again
    expect(retry.body).toMatchObject({ already_published: true, supersede_pending: false });
    expect(db.log.slice(before).map((w) => w.id)).toEqual(['orig']); // only the cleanup; no second switch
  });

  it('a stale revision (another revision of the same version was published first) is refused, never replacing the newer report', async () => {
    const db = fakeService(seed());
    const a = await revise(db);
    // A second revision of the same source, as if created concurrently.
    const b = (await db.base44.asServiceRole.entities.ReportingPeriod.create({ ...db.tables.ReportingPeriod.get(a), id: undefined, revision_status: 'open' })).id;
    for (const e of ENTS) for (const r of rowsOf(db, e, a)) await db.base44.asServiceRole.entities[e].create({ ...r, id: undefined, period_id: b });
    await finalizeAndTick(db, a);
    await finalizeAndTick(db, b);
    expect((await t(db, 'publish', a)).status).toBe(200);
    const stale = await t(db, 'publish', b);
    expect(stale.body.blockers[0].code).toBe('stale_revision');
    expect(db.tables.ReportingPeriod.get(b).published).toBe(false);
    expect((await buildPublicDashboard(db.base44.asServiceRole, {})).period.id).toBe(a);
  });

  it('two revisions published at the same moment: both pass (no mutual exclusion) -- the conflict is reported, not hidden', async () => {
    const db = fakeService(seed());
    const a = await revise(db);
    const b = (await db.base44.asServiceRole.entities.ReportingPeriod.create({ ...db.tables.ReportingPeriod.get(a), id: undefined, revision_status: 'open' })).id;
    for (const e of ENTS) for (const r of rowsOf(db, e, a)) await db.base44.asServiceRole.entities[e].create({ ...r, id: undefined, period_id: b });
    await finalizeAndTick(db, a);
    await finalizeAndTick(db, b);
    const [ra, rb] = await Promise.all([t(db, 'publish', a), t(db, 'publish', b)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect([ra.body.conflict, rb.body.conflict].some(Boolean)).toBe(true);
    const st = monthState(db.rows('ReportingPeriod').filter((x) => x.month === 7));
    expect(st.conflict.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect((await t(db, 'create_revision', a, { reason: REASON })).body.blockers[0].code).toBe('version_conflict');
  });
});

describe('discard', () => {
  it('removes an unpublished revision and its rows; the original is untouched', async () => {
    const db = fakeService(seed());
    const rid = await revise(db);
    expect((await t(db, 'discard_revision', rid)).body.done).toBe(true);
    expect(db.tables.ReportingPeriod.has(rid)).toBe(false);
    for (const e of ENTS) expect(rowsOf(db, e, rid)).toEqual([]);
    expect(db.tables.ReportingPeriod.get('orig')).toMatchObject({ published: true });
    expect((await t(db, 'create_revision', 'orig', { reason: REASON })).status).toBe(200); // a new one can be made
  });
  it('a published revision cannot be discarded', async () => {
    const db = fakeService(seed());
    const rid = await revise(db);
    await finalizeAndTick(db, rid);
    await t(db, 'publish', rid);
    expect((await t(db, 'discard_revision', rid)).body.blockers[0].code).toBe('published');
  });
});

describe('year-to-date drill-down counts each month once', () => {
  it('a later month with an open revision of June does not count June twice', async () => {
    const db = fakeService(seed());
    // Revise June (the earlier month) and check July's YTD.
    db.tables.ReportingPeriod.get('june').finalized_at = '2026-07-04T00:00:00Z';
    const rid = (await t(db, 'create_revision', 'june', { reason: REASON })).body.period_id;
    expect(rid).toBeTruthy();
    const july = db.tables.ReportingPeriod.get('orig');
    const cat = db.tables.BudgetLine.get('jl1').category;
    const juneRows = (res) => res.transactions.filter((x) => x.date === '2026-06-02').length;
    expect(rowsOf(db, 'Transaction', rid).length).toBe(1); // June's transaction now exists twice (original + revision)
    expect(juneRows(await transactionsForCategory(db.base44, july, cat, [], { publishedOnly: true }))).toBe(1); // client
    expect(juneRows(await transactionsForCategory(db.base44, july, cat, []))).toBe(1); // admin
  });
});

describe('the importer targets only the chosen draft revision', () => {
  const versions = (db) => db.rows('ReportingPeriod');
  it('a published month with an open revision: the revision; never the original', async () => {
    const db = fakeService(seed());
    expect(importTarget(versions(db), 7, 2026).allowed).toBe(false); // published, no revision yet
    const rid = await revise(db);
    const res = importTarget(versions(db), 7, 2026);
    expect(res).toMatchObject({ allowed: true, action: 'update' });
    expect(res.target.id).toBe(rid);
    const forced = importTarget(versions(db), 7, 2026, 'orig');
    expect(forced.allowed).toBe(false);
    expect(forced.reason).toMatch(/open revision/);
  });
  it('a superseded version, a revision still copying, or a discarded one is never a target', async () => {
    Object.assign(copyOptions, { budgetMs: -1, batchSize: 2 });
    const db = fakeService(seed());
    const rid = (await t(db, 'create_revision', 'orig', { reason: REASON })).body.period_id;
    expect(importTarget(versions(db), 7, 2026).reason).toMatch(/still being copied/);
    db.tables.ReportingPeriod.get(rid).revision_status = 'discarded';
    expect(importTarget(versions(db), 7, 2026).reason).toMatch(/published/);
    const sup = fakeService(seed({ published: false }));
    sup.tables.ReportingPeriod.get('orig').superseded = true;
    expect(importTarget(versions(sup), 7, 2026, 'orig').allowed).toBe(false);
  });
  it('a final unpublished month with no revision: re-imported in place, after the server resets it to draft', () => {
    const db = fakeService(seed({ published: false }));
    expect(importTarget(versions(db), 7, 2026)).toMatchObject({ allowed: true, needsInvalidate: true, target: { id: 'orig' } });
  });
});

describe('partial deployment: functions newer than the entity schemas', () => {
  // Base44 drops fields its schema does not declare; simulate the old schema.
  const OLD_SCHEMA_DROPS = ['revision_of', 'revision_number', 'supersedes', 'superseded', 'superseded_by', 'superseded_at', 'revision_reason', 'revision_created_by', 'revision_created_at', 'revision_status', 'copy_status', 'copy_verification', 'copied_from'];
  function oldSchema(db) {
    for (const [, table] of Object.entries(db.tables)) {
      const set = table.set.bind(table);
      table.set = (id, rec) => set(id, Object.fromEntries(Object.entries(rec).filter(([k]) => !OLD_SCHEMA_DROPS.includes(k))));
    }
    return db;
  }
  it('create_revision refuses and leaves nothing behind when the version fields would be dropped', async () => {
    const db = oldSchema(fakeService(seed({ published: false })));
    const before = db.rows('ReportingPeriod').length;
    const r = await t(db, 'create_revision', 'orig', { reason: REASON });
    expect(r.body.blockers[0].code).toBe('schema_out_of_date');
    expect(db.rows('ReportingPeriod').length).toBe(before);
    for (const e of ENTS) expect(db.rows(e).filter((x) => x.period_id !== 'orig' && x.period_id !== 'june')).toEqual([]);
  });
  it('a copy whose rows lose copied_from is stopped and removed', async () => {
    const db = fakeService(seed());
    const set = db.tables.Transaction.set.bind(db.tables.Transaction);
    db.tables.Transaction.set = (id, rec) => set(id, Object.fromEntries(Object.entries(rec).filter(([k]) => k !== 'copied_from')));
    const r = await t(db, 'create_revision', 'orig', { reason: REASON });
    expect(r.body.blockers[0].code).toBe('schema_out_of_date');
    expect(db.rows('ReportingPeriod').filter((p) => p.supersedes)).toEqual([]);
  });
});

describe('an older browser cannot import into a version behind its open revision', () => {
  it('invalidate (the old import path) is refused for a version with an open revision', async () => {
    const db = fakeService(seed({ published: false }));
    await revise(db);
    expect((await t(db, 'invalidate', 'orig')).body.blockers[0].code).toBe('open_revision_exists');
    expect(db.tables.ReportingPeriod.get('orig').status).toBe('final');
  });
});
