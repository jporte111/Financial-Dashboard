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

// Fake Base44 service role that records every write.
function fake({ period, lines = [] }, { failUpdate = false } = {}) {
  const writes = [];
  const svc = {
    entities: {
      ReportingPeriod: {
        get: async (id) => {
          if (!period || id !== period.id) throw new Error('Object not found');
          return period;
        },
        update: async (id, data) => {
          writes.push({ entity: 'ReportingPeriod', id, data });
          if (failUpdate) throw new Error('network');
          return { ...period, ...data };
        },
      },
      BudgetLine: {
        filter: async (q) => lines.filter((l) => l.period_id === q.period_id),
        update: async () => { writes.push({ entity: 'BudgetLine' }); },
      },
    },
  };
  return { base44: { asServiceRole: svc }, writes };
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
  it('refused -> 409 with blockers and NO write', async () => {
    const r = await run(draftFixture(workbookLikeParsed), { action: 'finalize', period_id: 'p1' });
    expect(r.status).toBe(409);
    expect(r.body.blockers.map((b) => b.code)).toContain('open_reconciliation:cash_total_mismatch');
    expect(r.writes).toEqual([]);
  });

  it('accepted -> exactly one state write: final, NOT published, reasons recorded', async () => {
    const fx = draftFixture(workbookLikeParsed);
    const overrides = Object.fromEntries(
      fx.period.bva_validation_warnings.filter((w) => w.blocksFinalize).map((w) => [w.code, { reason: 'confirmed with bookkeeper' }])
    );
    const r = await run(fx, { action: 'finalize', period_id: 'p1', overrides });
    expect(r.status).toBe(200);
    expectOnlyStateWrite(r.writes);
    const d = r.writes[0].data;
    expect(d).toMatchObject({ status: 'final', bva_import_status: 'final', finalized_by: ADMIN.email, finalized_at: NOW.toISOString() });
    expect(d).not.toHaveProperty('published');
    expect(d.bva_overrides['open_reconciliation:cash_total_mismatch']).toEqual({ reason: 'confirmed with bookkeeper', by: ADMIN.email, at: NOW.toISOString() });
    expect(d.bva_validation_warnings.find((w) => w.code === 'cash_total_mismatch')).toMatchObject({ overridden: true, blocksFinalize: false });
  });

  it('a missing required value cannot be overridden past the server', async () => {
    const fx = draftFixture();
    fx.period = { ...fx.period, ytd_income: null };
    const r = await run(fx, { action: 'finalize', period_id: 'p1', overrides: { 'required_value_missing:ytd_income': { reason: 'trust me' } } });
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
    fx.period.checklist = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
    const r = await run(fx, { action: 'publish', period_id: 'p1' });
    expect(r.status).toBe(200);
    expectOnlyStateWrite(r.writes);
    expect(r.writes[0].data).toMatchObject({ published: true, publication_date: '2026-08-05', reviewed_by: 'Admin' });
    expect(r.writes[0].data).not.toHaveProperty('status');
  });

  it('a failing write surfaces as an error after a single attempt (no partial second write)', async () => {
    const fx = finalFx();
    fx.period.checklist = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
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
    expect(d).toMatchObject({ published: false, status: 'draft', bva_import_status: 'draft', finalized_at: null });
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
    expect(r.writes[0].data).toMatchObject({ status: 'draft', bva_import_status: 'draft', finalized_at: null });
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
    const r = await run(draftFixture(workbookLikeParsed), { action: 'check', period_id: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.finalize.ok).toBe(false);
    expect(r.writes).toEqual([]);
  });
});
