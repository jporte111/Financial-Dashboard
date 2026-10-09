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

  it('refused, writing nothing: a published period, an unknown item, an item with an open linked blocker', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'final', { distributions_ytd: 0 })]));
    const before = db.log.length;
    expect((await call(db, 'confirm_checklist', 'jul', { item: 'cash_confirmed' })).status).toBe(409);
    expect((await call(db, 'confirm_checklist', 'aug', { item: 'nonsense' })).status).toBe(400);
    const blocked = await call(db, 'confirm_checklist', 'aug', { item: 'distributions_confirmed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers[0]).toMatchObject({ code: 'checklist_item_blocked', overridable: false });
    expect(blocked.body.blockers[0].message).toMatch(/Distributions YTD went down/);
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

  it('records that cannot be read: every item blocked, publish refused (fail closed)', async () => {
    const db = fakeService(seed([period('aug', 8, 'final')]));
    await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW);
    db.base44.asServiceRole.entities.SavingsSpend.filter = async () => { throw new Error('rate limited'); };
    const pub = await call(db, 'publish', 'aug');
    expect(pub.status).toBe(409);
    expect(pub.body.blockers.filter((b) => b.code.startsWith('checklist_incomplete:'))).toHaveLength(7);
    expect(pub.body.blockers[0].message).toMatch(/Checklist could not be evaluated/);
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
    expect(Object.keys(db.tables.ReportingPeriod.get('aug').checklist_confirmations)).toHaveLength(7);
    expect(notConfirmed(await itemStates(db, rid))).toHaveLength(7);
  });
});
