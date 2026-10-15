// Server-side behaviour of the periodTransition function
// (base44/shared/periodTransitionCore.ts): authorization, rule enforcement,
// and write discipline -- a refused transition writes nothing; an accepted one
// writes exactly one ReportingPeriod update containing only state/audit fields.
// All data is fictional.
import { describe, it, expect } from 'vitest';
import { handlePeriodTransition } from '../../base44/shared/periodTransitionCore.ts';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, workbookLikeParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { confirmedChecklist } from './__fixtures__/checklist.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const STATE_AND_AUDIT = new Set([
  'status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log',
  'bva_validation_warnings', 'publication_date', 'reviewed_by', 'last_updated',
]);
const NOW = new Date('2026-08-05T10:00:00Z');

function draftFixture(parsedFactory = cleanParsed) {
  const parsed = parsedFactory();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const period = { id: 'p1', label: 'July 2026', ...plan.periodData, status: 'draft', published: false, bva_import_status: 'draft' };
  const lines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i + 1}`, period_id: 'p1', ...l }));
  return { period, lines };
}

// Base44 rejects null for string and number fields with HTTP 422 (observed on
// the local Base44 server); the fake does the same, so any null write fails.
function rejectNulls(data) {
  const k = Object.keys(data).find((key) => data[key] === null);
  if (k) throw Object.assign(new Error(`Error in field ${k}: Input should be a valid string`), { status: 422 });
}

// Fake Base44 service role that records every write.
function fake({ period, lines = [], others = [] }, { failUpdate = false, dropOnCreate = [], raceDuplicate = false, failDelete = false } = {}) {
  const writes = [];
  const store = new Map([...(period ? [[period.id, period]] : []), ...others.map((p) => [p.id, p])]);
  let n = 0;
  const svc = {
    entities: {
      ReportingPeriod: {
        get: async (id) => {
          if (!store.has(id)) throw new Error('Object not found');
          return store.get(id);
        },
        filter: async (q) => [...store.values()].filter((p) => Object.entries(q).every(([k, v]) => p[k] === v)),
        create: async (data) => {
          rejectNulls(data);
          writes.push({ entity: 'ReportingPeriod', op: 'create', data });
          const rec = { id: `new${++n}`, ...data };
          for (const k of dropOnCreate) delete rec[k];
          store.set(rec.id, rec);
          if (raceDuplicate) store.set('racer', { ...rec, id: 'racer' });
          return rec;
        },
        delete: async (id) => {
          writes.push({ entity: 'ReportingPeriod', op: 'delete', id });
          if (failDelete) throw new Error('delete failed');
          store.delete(id);
        },
        update: async (id, data) => {
          rejectNulls(data);
          writes.push({ entity: 'ReportingPeriod', id, data });
          if (failUpdate) throw new Error('network');
          return { ...store.get(id), ...data };
        },
      },
      BudgetLine: {
        filter: async (q) => lines.filter((l) => l.period_id === q.period_id),
        update: async () => { writes.push({ entity: 'BudgetLine' }); },
      },
      // No cash / distribution / transfer / savings rows in these fixtures.
      ...Object.fromEntries(['CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend'].map((e) => [e, { filter: async () => [] }])),
    },
  };
  return { base44: { asServiceRole: svc }, writes, store };
}

const run = (fx, body, user = ADMIN, opts) => {
  const f = fake(fx, opts);
  return handlePeriodTransition(f.base44, body, user, NOW).then((res) => ({ ...res, writes: f.writes }));
};

function expectOnlyStateWrite(writes) {
  expect(writes).toHaveLength(1);
  expect(writes[0].entity).toBe('ReportingPeriod');
  for (const k of Object.keys(writes[0].data)) expect(STATE_AND_AUDIT.has(k), `unexpected field ${k}`).toBe(true);
}

describe('authorization', () => {
  const fx = draftFixture();
  it('rejects anonymous callers', async () => {
    expect((await run(fx, { action: 'check', period_id: 'p1' }, null)).status).toBe(401);
  });
  it('rejects non-admins, writing nothing', async () => {
    const r = await run(fx, { action: 'finalize', period_id: 'p1' }, { role: 'user' });
    expect(r.status).toBe(403);
    expect(r.writes).toEqual([]);
  });
  it('rejects unknown actions and missing ids', async () => {
    expect((await run(fx, { action: 'delete_everything', period_id: 'p1' })).status).toBe(400);
    expect((await run(fx, { action: 'publish' })).status).toBe(400);
  });
  it('returns 404 for an unknown period', async () => {
    expect((await run(fx, { action: 'publish', period_id: 'nope' })).status).toBe(404);
  });
});

describe('finalize', () => {
  it('refused -> 409 with blockers and NO write (a structural problem: months do not match the cutoff)', async () => {
    const fx = draftFixture(workbookLikeParsed);
    fx.period = { ...fx.period, months_elapsed: 1 };
    const r = await run(fx, { action: 'finalize', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.body.blockers.map((b) => b.code)).toContain('pace_inconsistent');
    expect(r.writes).toEqual([]);
  });

  it('accepted with warnings and no reasons -> exactly one state write: final, NOT published', async () => {
    const fx = draftFixture(workbookLikeParsed);
    const r = await run(fx, { action: 'finalize', period_id: 'p1' });
    expect(r.status).toBe(200);
    expectOnlyStateWrite(r.writes);
    const d = r.writes[0].data;
    expect(d).toMatchObject({ status: 'final', bva_import_status: 'final', finalized_by: ADMIN.email, finalized_at: NOW.toISOString() });
    expect(d).not.toHaveProperty('published');
    expect(d.bva_validation_warnings.map((w) => w.code)).toContain('cash_total_mismatch'); // kept for review
  });

  it('a missing total finalizes with no reason and stays missing (never written as 0)', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, ytd_income: null };
    const r = await run(fx, { action: 'finalize', period_id: 'p1' });
    expect(r.status).toBe(200);
    expectOnlyStateWrite(r.writes);
    expect(r.writes[0].data).toMatchObject({ status: 'final', bva_import_status: 'final' });
    expect(r.writes[0].data).not.toHaveProperty('ytd_income');
  });
  it('a missing cutoff is refused, whatever reason is given', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, reporting_cutoff_date: '' };
    const r = await run(fx, { action: 'finalize', period_id: 'p1', overrides: { 'required_value_missing:reporting_cutoff_date': { reason: 'let it through please' } } });
    expect(r.status).toBe(409);
    expect(r.writes).toEqual([]);
  });
});

describe('publish', () => {
  const finalFx = () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-04T00:00:00Z' };
    return fx;
  };

  it('a draft is refused with no write', async () => {
    const fx = draftFixture();
    fx.period.checklist = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
    const r = await run(fx, { action: 'publish', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.body.blockers.map((b) => b.code)).toContain('not_final');
    expect(r.writes).toEqual([]);
  });

  it('an incomplete checklist is refused with no write', async () => {
    const r = await run(finalFx(), { action: 'publish', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.writes).toEqual([]);
  });

  it('accepted -> exactly one write that only sets publication fields', async () => {
    const fx = finalFx();
    Object.assign(fx.period, confirmedChecklist(fx.period, fx.lines));
    const r = await run(fx, { action: 'publish', period_id: 'p1' });
    expect(r.status).toBe(200);
    expectOnlyStateWrite(r.writes);
    expect(r.writes[0].data).toMatchObject({ published: true, publication_date: '2026-08-05', reviewed_by: 'Admin' });
    expect(r.writes[0].data).not.toHaveProperty('status');
  });

  it('a failing write surfaces as an error after a single attempt (no partial second write)', async () => {
    const fx = finalFx();
    Object.assign(fx.period, confirmedChecklist(fx.period, fx.lines));
    const f = fake(fx, { failUpdate: true });
    await expect(handlePeriodTransition(f.base44, { action: 'publish', period_id: 'p1' }, ADMIN, NOW)).rejects.toThrow('network');
    expect(f.writes).toHaveLength(1);
  });
});

describe('reopen / invalidate / set_stage', () => {
  const publishedFx = () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, status: 'final', bva_import_status: 'final', finalized_at: 'x', published: true };
    return fx;
  };
  const REASON = 'client requested withdrawal of this report';

  it('reopen of a published period is refused without a reason, with no write', async () => {
    for (const reason of [undefined, '', 'too short']) {
      const r = await run(publishedFx(), { action: 'reopen', period_id: 'p1', reason, confirm: 'July 2026' });
      expect(r.status).toBe(409);
      expect(r.body.blockers[0].code).toBe('reopen_reason_required');
      expect(r.writes).toEqual([]);
    }
  });

  it('reopen of a published period is refused without the exact label confirmation, with no write', async () => {
    for (const confirm of [undefined, '', 'july 2026', 'June 2026']) {
      const r = await run(publishedFx(), { action: 'reopen', period_id: 'p1', reason: REASON, confirm });
      expect(r.status).toBe(409);
      expect(r.body.blockers[0].code).toBe('reopen_confirmation_required');
      expect(r.writes).toEqual([]);
    }
  });

  it('confirmed reopen of a published period unpublishes, returns to draft and records the reason, in one write', async () => {
    const fx = publishedFx();
    fx.period.reopen_log = [{ at: 'earlier', by: 'someone', reason: 'older entry', was_published: true }];
    const r = await run(fx, { action: 'reopen', period_id: 'p1', reason: `  ${REASON}  `, confirm: 'July 2026' });
    expectOnlyStateWrite(r.writes);
    const d = r.writes[0].data;
    expect(d).toMatchObject({ published: false, status: 'draft', bva_import_status: 'draft', finalized_at: '', finalized_by: '' });
    expect(d.reopen_log).toEqual([
      { at: 'earlier', by: 'someone', reason: 'older entry', was_published: true },
      { at: NOW.toISOString(), by: ADMIN.email, reason: REASON, was_published: true },
    ]);
  });

  it('reopen of a final (unpublished) period needs a reason but no label confirmation', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, status: 'final', bva_import_status: 'final', finalized_at: 'x' };
    expect((await run(fx, { action: 'reopen', period_id: 'p1' })).status).toBe(409);
    const r = await run(fx, { action: 'reopen', period_id: 'p1', reason: REASON });
    expectOnlyStateWrite(r.writes);
    expect(r.writes[0].data.reopen_log[0].was_published).toBe(false);
  });

  it('reopen of a legacy published period (no BVA metadata) does not invent bva_import_status', async () => {
    const fx = { period: { id: 'p1', label: 'March 2026', status: 'final', published: true }, lines: [] };
    const r = await run(fx, { action: 'reopen', period_id: 'p1', reason: REASON, confirm: 'March 2026' });
    expect(r.writes[0].data).toMatchObject({ published: false, status: 'draft' });
    expect(r.writes[0].data).not.toHaveProperty('bva_import_status');
  });

  it('reopen of a draft is refused', async () => {
    const r = await run(draftFixture(), { action: 'reopen', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.writes).toEqual([]);
  });

  it('invalidate (pre-import) refuses a published period with no write', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, published: true, status: 'final' };
    const r = await run(fx, { action: 'invalidate', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.body.blockers[0].code).toBe('published_read_only');
    expect(r.writes).toEqual([]);
  });

  it('invalidate resets a final (unpublished) period to draft', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, status: 'final', bva_import_status: 'final', finalized_at: 'x' };
    const r = await run(fx, { action: 'invalidate', period_id: 'p1' });
    expectOnlyStateWrite(r.writes);
    expect(r.writes[0].data).toMatchObject({ status: 'draft', bva_import_status: 'draft', finalized_at: '', finalized_by: '' });
  });

  it('invalidate on a plain draft writes nothing', async () => {
    const r = await run(draftFixture(), { action: 'invalidate', period_id: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.unchanged).toBe(true);
    expect(r.writes).toEqual([]);
  });

  it('set_stage never reaches final and is refused on final/published periods', async () => {
    expect((await run(draftFixture(), { action: 'set_stage', period_id: 'p1', stage: 'final' })).status).toBe(400);
    const fx = draftFixture();
    fx.period.status = 'final';
    const r = await run(fx, { action: 'set_stage', period_id: 'p1', stage: 'reports_reviewed' });
    expect(r.status).toBe(409);
    expect(r.writes).toEqual([]);
  });

  it('set_stage on a draft writes only status', async () => {
    const r = await run(draftFixture(), { action: 'set_stage', period_id: 'p1', stage: 'categories_reviewed' });
    expect(r.writes).toEqual([{ entity: 'ReportingPeriod', id: 'p1', data: { status: 'categories_reviewed' } }]);
  });

  it('check writes nothing', async () => {
    const fx = draftFixture(workbookLikeParsed);
    fx.period = { ...fx.period, months_elapsed: 1 };
    const r = await run(fx, { action: 'check', period_id: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.finalize.ok).toBe(false);
    expect(r.writes).toEqual([]);
  });
});

describe('no null is ever written (Base44 rejects null with 422)', () => {
  it('every transition that clears a field writes an empty string instead', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, status: 'final', bva_import_status: 'final', finalized_at: 'x', finalized_by: 'y', published: true };
    const r = await run(fx, { action: 'reopen', period_id: 'p1', reason: 'fictional exceptional withdrawal', confirm: 'July 2026' });
    expect(r.status).toBe(200);
    for (const w of r.writes) for (const v of Object.values(w.data || {})) expect(v).not.toBeNull();
  });
});

describe('create: one verified server-side write, duplicate-safe', () => {
  const data = { label: 'October 2026', month: 10, year: 2026, total_cash: 5, month_income: null, published: true, status: 'final', reopen_log: ['x'] };

  it('creates draft + unpublished with the state in the same write, ignoring caller state and nulls', async () => {
    const f = fake({ period: null });
    const r = await handlePeriodTransition(f.base44, { action: 'create', data }, ADMIN, NOW);
    expect(r.status).toBe(201);
    expect(r.body.state).toEqual({ status: 'draft', published: false, bva_import_status: 'draft', finalized_at: '' });
    const creates = f.writes.filter((w) => w.op === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0].data).toMatchObject({ status: 'draft', published: false, bva_import_status: 'draft', finalized_at: '', finalized_by: '', total_cash: 5 });
    expect(creates[0].data).not.toHaveProperty('month_income');
    expect(creates[0].data).not.toHaveProperty('reopen_log');
  });

  it('refuses a month that already exists (a retry never duplicates) and writes nothing', async () => {
    const f = fake({ period: null, others: [{ id: 'oct', month: 10, year: 2026, status: 'draft', published: false, bva_import_status: 'draft' }] });
    const r = await handlePeriodTransition(f.base44, { action: 'create', data }, ADMIN, NOW);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ period_id: 'oct', blockers: [{ code: 'period_exists' }] });
    expect(f.writes).toEqual([]);
  });

  it('if the stored state cannot be verified, removes the record and reports failure', async () => {
    const f = fake({ period: null }, { dropOnCreate: ['status', 'published', 'bva_import_status'] });
    const r = await handlePeriodTransition(f.base44, { action: 'create', data }, ADMIN, NOW);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: 'initialization_failed', period_id: null });
    expect(f.writes.map((w) => w.op)).toEqual(['create', 'delete']);
    expect(f.store.size).toBe(0);
  });

  it('if removal also fails, reports the unverified record (which the gate can never finalize)', async () => {
    const f = fake({ period: null }, { dropOnCreate: ['published'], failDelete: true });
    const r = await handlePeriodTransition(f.base44, { action: 'create', data }, ADMIN, NOW);
    expect(r.status).toBe(500);
    expect(r.body.period_id).toBeTruthy();
    const orphan = f.store.get(r.body.period_id);
    const { evaluateFinalize, evaluatePublish } = await import('../../base44/shared/publishGate.ts');
    expect(evaluateFinalize(orphan, []).blockers[0].code).toBe('state_uninitialized');
    expect(evaluatePublish(orphan, []).blockers[0].code).toBe('state_uninitialized');
  });

  it('a concurrent duplicate is detected after creation; the new record is removed', async () => {
    const f = fake({ period: null }, { raceDuplicate: true });
    const r = await handlePeriodTransition(f.base44, { action: 'create', data }, ADMIN, NOW);
    expect(r.status).toBe(409);
    expect(r.body.period_id).toBe('racer');
    expect([...f.store.keys()]).toEqual(['racer']);
  });

  it('validates input and requires an admin', async () => {
    const f = fake({ period: null });
    expect((await handlePeriodTransition(f.base44, { action: 'create', data: { label: 'x', month: 13, year: 2026 } }, ADMIN, NOW)).status).toBe(400);
    expect((await handlePeriodTransition(f.base44, { action: 'create' }, ADMIN, NOW)).status).toBe(400);
    expect((await handlePeriodTransition(f.base44, { action: 'create', data }, { role: 'user' }, NOW)).status).toBe(403);
    expect(f.writes).toEqual([]);
  });
});