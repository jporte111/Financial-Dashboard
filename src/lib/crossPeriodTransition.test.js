// Cross-period checks enforced by the periodTransition backend
// (periodTransitionCore.ts): check / finalize / publish. Reads only; a refused
// transition writes nothing; checks that cannot run fail closed. Fictional data.
import { describe, it, expect } from 'vitest';
import { handlePeriodTransition, crossPeriodContext, readRetryOptions } from '../../base44/shared/periodTransitionCore.ts';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';
import { fakeService } from './__fixtures__/fakeService.js';
import { confirmAll } from './__fixtures__/checklist.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid', full_name: 'Admin' };
const NOW = new Date('2030-09-05T10:00:00Z');
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));

// A month whose data runs through the previous month end; `state` sets draft / final / published.
const period = (id, month, state, extra = {}) => ({
  id, label: `Month ${month} 2030`, month, year: 2030,
  reporting_cutoff_date: `2030-${String(month - 1).padStart(2, '0')}-28`, months_elapsed: month - 1,
  ytd_income: 1000 * (month - 1), ytd_expenses: 800 * (month - 1), month_income: 1000, month_expenses: 800,
  distributions_ytd: 300, total_cash: 4321, annual_budgeted_income: 12345, annual_budgeted_expenses: 9876,
  bva_parsed_source: {}, bva_validation_warnings: [],
  ...(state === 'draft' ? { status: 'draft', bva_import_status: 'draft', published: false, finalized_at: '' }
    : state === 'final' ? { status: 'final', bva_import_status: 'final', published: false, finalized_at: '2030-09-01T00:00:00Z', checklist: CHECKLIST }
      : { status: 'final', bva_import_status: 'final', published: true, finalized_at: '2030-08-01T00:00:00Z', checklist: CHECKLIST }),
  ...extra,
});
const linesFor = (pid, month, ytdScale = 1) => [
  { id: `${pid}-i`, period_id: pid, category: 'Test Income', budget_group: 'income', ytd_actual: 1000 * (month - 1) * ytdScale, annual_budget: 12345, month_actual: 1000 },
  ...['fixed', 'variable', 'discretionary'].map((g, k) => ({ id: `${pid}-${g}`, period_id: pid, category: g.toUpperCase(), budget_group: g, ytd_actual: (200 + 100 * k) * (month - 1), annual_budget: 3000 + 300 * k, month_actual: 200 + 100 * k })),
];
const children = (pid) => ({
  Distribution: [{ id: `${pid}-dist`, period_id: pid, entity_name: 'Test Entity', q1: 100, q2: 200 }],
  RecurringTransfer: [{ id: `${pid}-t`, period_id: pid, source: 'Test Bank', purpose: 'Test Savings', amount: 10 }],
  CashAccount: [{ id: `${pid}-c`, period_id: pid, name: 'Test Checking', balance: 4321 }],
});
function seed(periods) {
  const s = { ReportingPeriod: [], BudgetLine: [], Distribution: [], RecurringTransfer: [], CashAccount: [] };
  for (const p of periods) {
    s.ReportingPeriod.push(p);
    s.BudgetLine.push(...linesFor(p.id, p.month));
    for (const [k, v] of Object.entries(children(p.id))) s[k].push(...v);
  }
  return s;
}
const call = (db, action, period_id, extra = {}) => handlePeriodTransition(db.base44, { action, period_id, ...extra }, ADMIN, NOW);
const writes = (db) => db.log.filter((l) => l.op !== 'read');
const codes = (res) => (res.body.blockers || []).map((b) => b.code);

describe('finalize', () => {
  it('a consistent month finalizes; the comparison is with the previous published month', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'draft')]));
    const res = await call(db, 'finalize', 'aug');
    expect(res.status).toBe(200);
    expect(writes(db)).toHaveLength(1); // still exactly one ReportingPeriod write
  });

  it('a year-to-date decrease is a warning: finalize goes through with no written reason', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'draft', { ytd_income: 100, month_income: -5900 })]));
    const chk = await call(db, 'check', 'aug');
    expect(chk.body.review.warnings.map((w) => w.code)).toContain('ytd_income_decreased');
    const ok = await call(db, 'finalize', 'aug');
    expect(ok.status).toBe(200);
    expect(db.tables.ReportingPeriod.get('aug').bva_overrides || {}).toEqual({});
  });

  it('a hard cross-period block cannot be overridden', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'draft', { reporting_cutoff_date: '2030-06-30', months_elapsed: 6 })]));
    const res = await call(db, 'finalize', 'aug', { overrides: { 'cross_period:cutoff_not_after_previous': { reason: 'Please let it through.' } } });
    expect(res.status).toBe(409);
    expect(res.body.blockers.find((b) => b.code === 'cross_period:cutoff_not_after_previous').overridable).toBe(false);
    expect(writes(db)).toHaveLength(0);
  });

  it('fails closed when an earlier period cannot be read (after the retries), and writes nothing', async () => {
    readRetryOptions.delaysMs = [1, 1, 1];
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'draft')]));
    const svc = db.base44.asServiceRole;
    const realFilter = svc.entities.Distribution.filter;
    svc.entities.Distribution.filter = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
    const res = await handlePeriodTransition(db.base44, { action: 'finalize', period_id: 'aug' }, ADMIN, NOW);
    expect(res.status).toBe(409);
    expect(res.body.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cross_period:checks_unavailable', overridable: false })]));
    expect(writes(db)).toHaveLength(0);
    // up to three transient failures of a read are retried
    let failures = 3;
    svc.entities.Distribution.filter = async (...a) => { if (failures-- > 0) throw new Error('blip'); return realFilter(...a); };
    const ctx = await crossPeriodContext(svc, db.tables.ReportingPeriod.get('aug'), linesFor('aug', 8));
    expect(ctx.unavailable).toBeUndefined();
  });
});

describe('publish', () => {
  it('a finding accepted at finalize stays accepted at publish', async () => {
    const aug = period('aug', 8, 'final', { ytd_income: 100, month_income: -5900, bva_overrides: { 'cross_period:ytd_income_decreased': { reason: 'Refund booked in July.', by: 'a', at: 'b' } } });
    const db = fakeService(seed([period('jul', 7, 'published'), aug]));
    for (const r of await confirmAll(handlePeriodTransition, db.base44, 'aug', ADMIN, NOW)) expect(r.status).toBe(200);
    const res = await call(db, 'publish', 'aug');
    expect(res.status).toBe(200);
  });

  it('a new finding at publish (previous month changed since finalize) is a warning, never a blocker', async () => {
    const db = fakeService(seed([period('jul', 7, 'published', { ytd_income: 99999 }), period('aug', 8, 'final')]));
    const res = await call(db, 'publish', 'aug');
    expect(codes(res).filter((c) => c.startsWith('cross_period:'))).toEqual([]);
  });

  it('publishing a revision of an earlier month: later published months produce warnings, never blockers', async () => {
    const jul = period('jul', 7, 'published');
    const julR = period('jul-r', 7, 'final', { supersedes: 'jul', revision_number: 2, copy_status: 'verified', ytd_income: 9000 });
    const db = fakeService(seed([period('jun', 6, 'published'), jul, julR, period('aug', 8, 'published')]));
    const chk = await call(db, 'check', 'jul-r');
    expect(chk.body.cross_period.previous.id).toBe('jun');
    expect(chk.body.cross_period.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'later_month_behind:ytd_income', severity: 'warn' })]));
    // the revision's own year-to-date grew vs June, and the warning does not block
    const res = await call(db, 'publish', 'jul-r', { overrides: {} });
    expect(codes(res).filter((c) => c.startsWith('cross_period:') && !c.includes('month_vs_ytd'))).toEqual([]);
  });
});

describe('check', () => {
  it('returns the comparison and its warnings for an unpublished period; writes nothing', async () => {
    const db = fakeService(seed([period('jul', 7, 'published'), period('aug', 8, 'draft', { distributions_ytd: 0 })]));
    const res = await call(db, 'check', 'aug');
    expect(res.status).toBe(200);
    expect(res.body.cross_period.previous).toEqual({ id: 'jul', label: 'Month 7 2030' });
    expect(res.body.cross_period.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'distributions_ytd_decreased', severity: 'warn' })]));
    expect(res.body.finalize.blockers.map((b) => b.code)).not.toContain('cross_period:distributions_ytd_decreased');
    expect(res.body.review.warnings.map((w) => w.code)).toContain('distributions_ytd_decreased');
    expect(writes(db)).toHaveLength(0);
  });

  it('a published period is never re-judged: no cross-period evaluation', async () => {
    const db = fakeService(seed([period('jul', 7, 'published', { ytd_income: 99999 }), period('aug', 8, 'published')]));
    const res = await call(db, 'check', 'aug');
    expect(res.body.cross_period).toBe(null);
  });

  it('a superseded or discarded previous version is never the baseline', async () => {
    const db = fakeService(seed([
      period('jul', 7, 'published', { published: false, superseded: true, superseded_by: 'jul-r', ytd_income: 99999 }),
      period('jul-r', 7, 'published', { supersedes: 'jul', revision_number: 2 }),
      period('jul-x', 7, 'draft', { supersedes: 'jul-r', revision_number: 3, revision_status: 'discarded', ytd_income: 99999 }),
      period('aug', 8, 'draft'),
    ]));
    const res = await call(db, 'check', 'aug');
    expect(res.body.cross_period.previous.id).toBe('jul-r');
    expect(res.body.finalize.blockers.map((b) => b.code).filter((c) => c.startsWith('cross_period:'))).toEqual([]);
  });
});
