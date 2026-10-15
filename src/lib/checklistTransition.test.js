// The checklist on the server (periodTransitionCore.ts): confirm / unconfirm
// record who and when in one write; publish requires every item confirmed and
// not stale; only the item whose data changed resets. Fictional data only.
import { describe, it, expect } from 'vitest';
import { handlePeriodTransition } from '../../base44/shared/periodTransitionCore.ts';
import { CHECKLIST_KEYS } from '../../base44/shared/checklistCore.ts';
import { fakeService } from './__fixtures__/fakeService.js';
import { confirmAll } from './__fixtures__/checklist.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2030-09-05T10:00:00Z');
const period = (id, month, state, extra = {}) => ({
  id, label: `Month ${month} 2030`, month, year: 2030,
  reporting_cutoff_date: `2030-${String(month - 1).padStart(2, '0')}-28`, months_elapsed: month - 1,
  ytd_income: 1013 * (month - 1), ytd_expenses: 811 * (month - 1), month_income: 1013, month_expenses: 811,
  distributions_ytd: 307, total_cash: 4409, annual_budgeted_income: 12157, annual_budgeted_expenses: 9733,
  bva_parsed_source: {}, bva_validation_warnings: [],
  ...(state === 'final' ? { status: 'final', bva_import_status: 'final', published: false, finalized_at: '2030-09-01T00:00:00Z' }
    : state === 'published' ? { status: 'final', bva_import_status: 'final', published: true, finalized_at: '2030-08-01T00:00:00Z' }
      : { status: 'draft', bva_import_status: 'draft', published: false, finalized_at: '' }),
  ...extra,
});
const lines = (pid, month) => [
  { id: `${pid}-i`, period_id: pid, category: 'Test Income', budget_group: 'income', ytd_actual: 1013 * (month - 1), annual_budget: 12157, month_actual: 1013 },
  ...['fixed', 'variable', 'discretionary'].map((g, k) => ({ id: `${pid}-${g}`, period_id: pid, category: g.toUpperCase(), budget_group: g, ytd_actual: (211 + 96 * k) * (month - 1), annual_budget: 2533 + 1152 * k, month_actual: 211 + 96 * k })),
];
function seed(periods) {
  const s = { ReportingPeriod: [], BudgetLine: [], Distribution: [], RecurringTransfer: [], CashAccount: [], SavingsSpend: [] };
  for (const p of periods) {
    s.ReportingPeriod.push(p);
    s.BudgetLine.push(...lines(p.id, p.month));
    s.Distribution.push({ id: `${p.id}-d`, period_id: p.id, entity_name: 'Test Entity', q1: 101, q2: 206 });
    s.RecurringTransfer.push({ id: `${p.id}-t`, period_id: p.id, source: 'Test Bank', purpose: 'Test Savings', amount: 17 });
    s.CashAccount.push({ id: `${p.id}-c`, period_id: p.id, name: 'Test Checking', balance: 4409 });
  }
  return s;
}
const call = (db, action, period_id, extra = {}) => handlePeriodTransition(db.base44, { action, period_id, ...extra }, ADMIN, NOW);
const itemStates = async (db, pid) => Object.fromEntries((await call(db, 'check', pid)).body.checklist.items.map((s) => [s.key, s.state]));
const notConfirmed = (st) => Object.keys(st).filter((k) => st[k] !== 'confirmed').sort();

describe('confirm / unconfirm', () => {
  it('records who, when and what was covered, in exactly one write', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    const before = db.log.length;
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    expect(r.status).toBe(200);
    expect(db.log.slice(before)).toHaveLength(1);
    const stored = db.tables.ReportingPeriod.get('aug');
    expect(stored.checklist_confirmations.cash_confirmed).toMatchObject({ by: 'admin@example.invalid', at: NOW.toISOString() });
    expect(Object.keys(stored.checklist_confirmations.cash_confirmed.parts).sort()).toEqual(['cash_accounts', 'total_cash']);
    expect(stored.checklist.cash_confirmed).toBe(true);
    const u = await call(db, 'unconfirm_checklist', 'aug', { item: 'cash_confirmed' });
    expect(u.status).toBe(200);
    expect(db.tables.ReportingPeriod.get('aug').checklist_confirmations.cash_confirmed).toBeUndefined();
    expect(db.tables.ReportingPeriod.get('aug').checklist.cash_confirmed).toBe(false);
  });

  it('refused, writing nothing: a published period, an unknown item, an item with an open linked structural blocker', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final', { bva_validation_warnings: [{ code: 'section_missing:distributions', blocksFinalize: true, overridable: false, message: 'No distributions block.' }] })]));
    const before = db.log.length;
    expect((await call(db, 'confirm_checklist', 'jul', { item: 'cash_confirmed' })).status).toBe(409);
    expect((await call(db, 'confirm_checklist', 'aug', { item: 'nonsense' })).status).toBe(400);
    const blocked = await call(db, 'confirm_checklist', 'aug', { item: 'distributions_confirmed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers[0]).toMatchObject({ code: 'checklist_item_blocked', overridable: false });
    expect(blocked.body.blockers[0].message).toMatch(/A required workbook section is missing/);
    expect(db.log.length).toBe(before);
    // ...an unrelated item is not blocked by it
    expect((await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' })).status).toBe(200);
  });

  it('a confirmation the schema silently drops is reported, not taken as done', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    const svc = db.base44.asServiceRole.entities.ReportingPeriod;
    const real = svc.update;
    svc.update = async (id, data) => { const { checklist_confirmations, ...rest } = data; return real(id, rest); };
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('schema_out_of_date');
  });
});

describe('publish requires every item confirmed and current', () => {
  it('refused until confirmed; ticking the old true/false is not enough', async () => {
    const db = fakeService(seed([period('aug', 8, 'final', { checklist: Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])) })]));
    const r = await call(db, 'publish', 'aug');
    expect(r.status).toBe(409);
    expect(r.body.blockers.filter((b) => b.code.startsWith('checklist_incomplete:'))).toHaveLength(7);
    for (const c of await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW)) expect(c.status).toBe(200);
    expect((await call(db, 'publish', 'aug')).status).toBe(200);
  });

  it('editing a cash balance resets ONLY cash (and the whole-report review); publish waits for those two', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    await db.base44.asServiceRole.entities.CashAccount.update('aug-c', { balance: 4410 });
    expect(notConfirmed(await itemStates(db, 'aug'))).toEqual(['budget_report_reviewed', 'cash_confirmed']);
    const chk = await call(db, 'check', 'aug');
    const cash = chk.body.checklist.items.find((s) => s.key === 'cash_confirmed');
    expect(cash.changedParts).toEqual(['cash_accounts']);
    const pub = await call(db, 'publish', 'aug');
    expect(pub.status).toBe(409);
    expect(pub.body.blockers.map((b) => b.code).sort()).toEqual(['checklist_incomplete:budget_report_reviewed', 'checklist_incomplete:cash_confirmed']);
    expect(pub.body.blockers.find((b) => b.code === 'checklist_incomplete:cash_confirmed').message).toMatch(/needs confirming again -- cash accounts changed since admin@example.invalid confirmed/);
    await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    await call(db, 'confirm_checklist', 'aug', { item: 'budget_report_reviewed' });
    expect((await call(db, 'publish', 'aug')).status).toBe(200);
  });

  it('an identical re-import (rows deleted and re-created with the same values) resets nothing', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    const E = db.base44.asServiceRole.entities;
    for (const ent of ['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer']) {
      const rows = db.rows(ent).filter((r) => r.period_id === 'aug');
      for (const r of rows) await E[ent].delete(r.id);
      await E[ent].bulkCreate(rows.reverse().map(({ id, created_date, ...rest }) => rest));
    }
    await E.ReportingPeriod.update('aug', { last_updated: '2030-09-06' });
    expect(notConfirmed(await itemStates(db, 'aug'))).toEqual([]);
    expect((await call(db, 'publish', 'aug')).status).toBe(200);
  });

  it('a figure becoming missing (not $0.00) resets its item', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    await db.base44.asServiceRole.entities.ReportingPeriod.update('aug', { source_missing_fields: ['month_income'] });
    expect(notConfirmed(await itemStates(db, 'aug'))).toEqual(['budget_report_reviewed', 'income_reviewed']);
  });

  it('records that cannot be read: the checks are unavailable, every item blocked, publish refused (fail closed)', async () => {
    readRetryOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    db.base44.asServiceRole.entities.SavingsSpend.filter = async () => { throw new Error('rate limited'); };
    const pub = await call(db, 'publish', 'aug');
    expect(pub.status).toBe(409);
    const codes = pub.body.blockers.map((b) => b.code);
    expect(codes).toContain('cross_period:checks_unavailable');
    expect(codes.filter((c) => c.startsWith('checklist_incomplete:'))).toHaveLength(7);
    expect(pub.body.blockers.find((b) => b.code === 'checklist_incomplete:cash_confirmed').message).toMatch(/Cross-period checks could not run|Checklist could not be evaluated/);
  });
});

describe('published periods and revisions (Phase 4)', () => {
  it('a published period is untouched: check evaluates nothing and nothing can be confirmed', async () => {
    const db = fakeService(seed([period('aug', 8, 'published')]));
    const chk = await call(db, 'check', 'aug');
    expect(chk.body.checklist).toBe(null);
    expect(chk.body.review).toBe(null);
    expect((await call(db, 'unconfirm_checklist', 'aug', { item: 'cash_confirmed' })).status).toBe(409);
  });

  it('a revision starts with no confirmations; the original keeps its own', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    expect((await call(db, 'publish', 'aug')).status).toBe(200);
    const r = await call(db, 'create_revision', 'aug', { reason: 'Fictional correction for the test.' });
    const rid = r.body.period_id;
    for (let i = 0; i < 5 && db.tables.ReportingPeriod.get(rid).copy_status !== 'verified'; i++) await call(db, 'copy_revision', rid);
    expect(db.tables.ReportingPeriod.get(rid).checklist_confirmations || {}).toEqual({});
    expect(Object.keys(db.tables.ReportingPeriod.get('aug').checklist_confirmations).filter((k) => CHECKLIST_KEYS.includes(k))).toHaveLength(7);
    expect(notConfirmed(await itemStates(db, rid))).toHaveLength(7);
  });
});

describe('fail closed while the cross-period checks cannot run', () => {
  it('an item is not confirmed (no write) while an earlier period cannot be read', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final')]));
    const realFilter = db.base44.asServiceRole.entities.Distribution.filter;
    db.base44.asServiceRole.entities.Distribution.filter = async (q) => { if (q.period_id === 'jul') throw new Error('rate limited'); return realFilter(q); };
    const before = db.log.length;
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'distributions_confirmed' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].message).toMatch(/Cross-period checks could not run/);
    expect(db.log.length).toBe(before);
  });
});

// ---- stale reads (Base44 has no conditional writes; reads can lag a write) ----
import { checklistWriteOptions, CHECKLIST_REVISION } from '../../base44/shared/periodTransitionCore.ts';

describe('confirm is hardened against stale reads', () => {
  const fast = () => Object.assign(checklistWriteOptions, { tries: 4, delayMs: 1 });
  const items = (db, pid) => Object.keys(db.tables.ReportingPeriod.get(pid).checklist_confirmations || {}).filter((k) => CHECKLIST_KEYS.includes(k)).sort();
  // Make ReportingPeriod.get return an older snapshot for the next `n` reads.
  const lagReads = (db, snapshot, n) => {
    const E = db.base44.asServiceRole.entities.ReportingPeriod;
    const real = E.get;
    let left = n;
    E.get = async (id) => (left-- > 0 ? structuredClone(snapshot) : real(id));
    return () => { E.get = real; };
  };

  it('normal path: one write, every other confirmation kept, verified, revision stamped', async () => {
    fast();
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    const before = db.log.length;
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'income_reviewed' });
    expect(r.status).toBe(200);
    expect(db.log.slice(before)).toHaveLength(1);
    expect(items(db, 'aug')).toEqual(['cash_confirmed', 'income_reviewed']);
    expect(db.tables.ReportingPeriod.get('aug').checklist_confirmations[CHECKLIST_REVISION].n).toBe(2);
  });

  it('a lagging read (older than a state already seen) is never used as the base: it waits for the fresh state', async () => {
    fast();
    const db = fakeService(seed([period('aug', 8, 'final')]));
    const stale = structuredClone(db.tables.ReportingPeriod.get('aug')); // before anything was confirmed
    await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    await call(db, 'confirm_checklist', 'aug', { item: 'income_reviewed' });
    // the request's own load sees the latest; the next 2 reads lag behind it
    const handlerGet = db.base44.asServiceRole.entities.ReportingPeriod.get;
    let calls = 0;
    db.base44.asServiceRole.entities.ReportingPeriod.get = async (id) => { calls++; return calls >= 2 && calls <= 3 ? structuredClone(stale) : handlerGet(id); };
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'refunds_reviewed' });
    expect(r.status).toBe(200);
    expect(items(db, 'aug')).toEqual(['cash_confirmed', 'income_reviewed', 'refunds_reviewed']);
  });

  it('if the fresh state cannot be read reliably, nothing is written and the caller must retry', async () => {
    fast();
    const db = fakeService(seed([period('aug', 8, 'final')]));
    const stale = structuredClone(db.tables.ReportingPeriod.get('aug'));
    await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    const handlerGet = db.base44.asServiceRole.entities.ReportingPeriod.get;
    let calls = 0;
    db.base44.asServiceRole.entities.ReportingPeriod.get = async (id) => (++calls === 1 ? handlerGet(id) : structuredClone(stale));
    const before = db.log.length;
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'income_reviewed' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('checklist_not_saved');
    expect(db.log.length).toBe(before); // no write
    expect(items(db, 'aug')).toEqual(['cash_confirmed']); // the existing confirmation is intact
  });

  it('a write that cannot be read back is reported as NOT saved (retry), never as success', async () => {
    fast();
    const db = fakeService(seed([period('aug', 8, 'final')]));
    const handlerGet = db.base44.asServiceRole.entities.ReportingPeriod.get;
    const pre = structuredClone(db.tables.ReportingPeriod.get('aug'));
    let wrote = false;
    const E = db.base44.asServiceRole.entities.ReportingPeriod;
    const realUpdate = E.update;
    E.update = async (...a) => { wrote = true; return realUpdate(...a); };
    E.get = async (id) => (wrote ? structuredClone(pre) : handlerGet(id)); // every read after the write is stale
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('checklist_not_saved');
  });

  it('a later write that kept our change counts as saved; one that dropped it does not', async () => {
    fast();
    for (const keepOurs of [true, false]) {
      const db = fakeService(seed([period('aug', 8, 'final')]));
      const E = db.base44.asServiceRole.entities.ReportingPeriod;
      const realUpdate = E.update;
      E.update = async (id, data) => {
        await realUpdate(id, data);
        // another admin's write lands right after ours
        const c = structuredClone(data.checklist_confirmations);
        if (!keepOurs) delete c.cash_confirmed;
        c[CHECKLIST_REVISION] = { n: c[CHECKLIST_REVISION].n + 1, token: 'other' };
        await realUpdate(id, { checklist_confirmations: c });
      };
      const r = await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' });
      expect(r.status, `keepOurs=${keepOurs}`).toBe(keepOurs ? 200 : 409);
    }
  });

  it('withdrawing goes through the same path: other confirmations kept', async () => {
    fast();
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    expect((await call(db, 'unconfirm_checklist', 'aug', { item: 'cash_confirmed' })).status).toBe(200);
    expect(items(db, 'aug')).toEqual(CHECKLIST_KEYS.filter((k) => k !== 'cash_confirmed').sort());
    expect(db.tables.ReportingPeriod.get('aug').checklist.cash_confirmed).toBe(false);
  });
});

// ---- fewer reads, more patient retries (still fail closed) ----
import { readRetryOptions } from '../../base44/shared/periodTransitionCore.ts';

describe('reads for the checks', () => {
  const countReads = (db) => {
    const counts = {};
    for (const [name, ent] of Object.entries(db.base44.asServiceRole.entities)) {
      const real = ent.filter;
      ent.filter = async (q, ...rest) => { const key = `${name}${q && q.period_id ? `:${q.period_id}` : ''}`; counts[key] = (counts[key] || 0) + 1; return real(q, ...rest); };
    }
    return counts;
  };
  it("a check reads the current period's own records ONCE (shared by the cross-period and checklist evaluations)", async () => {
    readRetryOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final')]));
    const counts = countReads(db);
    expect((await call(db, 'check', 'aug')).status).toBe(200);
    for (const e of ['Distribution', 'RecurringTransfer', 'CashAccount', 'SavingsSpend']) expect(counts[`${e}:aug`], e).toBe(1);
  });
  it('a read that fails twice is retried and succeeds: the item can be confirmed', async () => {
    readRetryOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final')]));
    const E = db.base44.asServiceRole.entities.CashAccount;
    const real = E.filter;
    let fails = 2;
    E.filter = async (...a) => { if (fails-- > 0) throw Object.assign(new Error('rate limited'), { status: 429 }); return real(...a); };
    expect((await call(db, 'confirm_checklist', 'aug', { item: 'cash_confirmed' })).status).toBe(200);
  });
  it('a read that keeps failing still fails closed (nothing confirmed, nothing written)', async () => {
    readRetryOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final')]));
    db.base44.asServiceRole.entities.CashAccount.filter = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    const before = db.log.length;
    const r = await call(db, 'confirm_checklist', 'aug', { item: 'income_reviewed' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('checklist_item_blocked');
    expect(db.log.length).toBe(before);
  });
});
