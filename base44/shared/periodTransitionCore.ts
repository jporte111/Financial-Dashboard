// Server-side state transitions for a reporting period, used by the
// periodTransition backend function (service role). This is the only supported
// way to change a period's draft / final / published state:
//   - admins only;
//   - every rule is evaluated before anything is written;
//   - a transition writes exactly ONE ReportingPeriod update (a single-record
//     write), so a refused or failed transition leaves no partial change;
//   - financial figures are never written here -- only state and audit fields.
//
// Actions:
//   create      create a new period as draft + unpublished in ONE service-role
//               write, read it back to verify its state, refuse a month that
//               already exists (safe to retry), and never report success for
//               a period whose state could not be verified
//   check       evaluate finalize and publish rules; writes nothing
//   finalize    draft -> final (records override / exclusion reasons); NOT published
//   publish     final -> published
//   reopen      EXCEPTIONAL: published or final -> draft (unpublishes; figures
//               untouched). Requires a written reason; for a published period
//               also the exact period label as confirmation. Every reopen is
//               appended to reopen_log. Until draft revisions exist, published
//               historical reports are meant to stay published.
//   invalidate  before a re-import: final -> draft; refused if published
//   set_stage   intermediate review stages only (never 'final'); not when final/published

import { evaluateFinalize, evaluatePublish, recordedOverrides, hasInitializedState } from './publishGate.ts';

// Base44 rejects null for string and number fields (HTTP 422), so a cleared
// timestamp / name is written as '' -- the gate treats '' as "not set".
export const CLEARED = '';
// State written by the server; never accepted from the caller on create.
export const PROTECTED_FIELDS = ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log'];

export const MIN_REOPEN_REASON = 10;
export const STAGES = ['draft', 'transactions_posted', 'categories_reviewed', 'classes_reviewed', 'reports_reviewed'];
const reply = (status, body) => ({ status, body });
const today = (now) => now.toISOString().slice(0, 10);

async function load(svc, periodId) {
  let period = null;
  try {
    period = await svc.entities.ReportingPeriod.get(periodId);
  } catch {
    period = null; // Base44 throws for an unknown id
  }
  if (!period) return { period: null, lines: [] };
  const lines = await svc.entities.BudgetLine.filter({ period_id: period.id }, undefined, 5000);
  return { period, lines };
}

export async function handlePeriodTransition(base44, body = {}, user, now = new Date()) {
  if (!user) return reply(401, { error: 'Unauthorized' });
  if (user.role !== 'admin') return reply(403, { error: 'Admins only' });
  const { action, period_id } = body;
  if (!period_id && action !== 'create') return reply(400, { error: 'period_id required' });
  if (!['create', 'check', 'finalize', 'publish', 'reopen', 'invalidate', 'set_stage'].includes(action)) {
    return reply(400, { error: 'unknown action' });
  }
  const svc = base44.asServiceRole;
  if (action === 'create') return createPeriod(svc, body.data, user, now);

  const { period, lines } = await load(svc, period_id);
  if (!period) return reply(404, { error: 'Period not found' });
  const who = user.email || user.full_name || 'admin';
  const update = async (data) => {
    await svc.entities.ReportingPeriod.update(period.id, data);
    return reply(200, { ok: true, action, period_id: period.id, state: { ...pickState(period), ...pickState(data) } });
  };

  if (action === 'check') {
    return reply(200, { ok: true, finalize: evaluateFinalize(period, lines, body.overrides || {}), publish: evaluatePublish(period, lines) });
  }

  if (action === 'finalize') {
    const overrides = body.overrides || {};
    const result = evaluateFinalize(period, lines, overrides);
    if (!result.ok) return reply(409, { ok: false, action, blockers: result.blockers });
    const at = now.toISOString();
    const recorded = recordedOverrides(period, lines, overrides, who, at);
    const warnings = (Array.isArray(period.bva_validation_warnings) ? period.bva_validation_warnings : []).map((w) => {
      const o = recorded[`open_reconciliation:${w.code}`];
      return o && w.blocksFinalize ? { ...w, overridden: true, override: o, blocksFinalize: false } : w;
    });
    return update({
      status: 'final',
      bva_import_status: 'final',
      finalized_at: at,
      finalized_by: who,
      bva_overrides: recorded,
      bva_validation_warnings: warnings,
      last_updated: today(now),
    });
  }

  if (action === 'publish') {
    const result = evaluatePublish(period, lines);
    if (!result.ok) return reply(409, { ok: false, action, blockers: result.blockers });
    return update({ published: true, publication_date: today(now), reviewed_by: user.full_name || who, last_updated: today(now) });
  }

  if (action === 'reopen') {
    if (!period.published && period.status !== 'final' && period.bva_import_status !== 'final') {
      return reply(409, { ok: false, action, blockers: [{ code: 'not_final_or_published', message: 'Only a final or published period can be reopened.', overridable: false }] });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < MIN_REOPEN_REASON) {
      return reply(409, { ok: false, action, blockers: [{ code: 'reopen_reason_required', message: `Reopening is exceptional: give a reason of at least ${MIN_REOPEN_REASON} characters.`, overridable: false }] });
    }
    if (period.published && body.confirm !== period.label) {
      return reply(409, { ok: false, action, blockers: [{ code: 'reopen_confirmation_required', message: 'To remove a published report from the client dashboard, type the period label exactly to confirm.', overridable: false }] });
    }
    const log = Array.isArray(period.reopen_log) ? period.reopen_log : [];
    return update({
      reopen_log: [...log, { at: now.toISOString(), by: who, reason, was_published: !!period.published }],
      published: false,
      status: 'draft',
      ...(period.bva_import_status ? { bva_import_status: 'draft' } : {}),
      finalized_at: CLEARED,
      finalized_by: CLEARED,
      last_updated: today(now),
    });
  }

  if (action === 'invalidate') {
    if (period.published) {
      return reply(409, { ok: false, action, blockers: [{ code: 'published_read_only', message: 'Re-import into a published month is refused until draft revisions are available.', overridable: false }] });
    }
    if (period.status !== 'final' && period.bva_import_status === 'draft' && !period.finalized_at) {
      return reply(200, { ok: true, action, period_id: period.id, state: pickState(period), unchanged: true });
    }
    return update({ status: 'draft', bva_import_status: 'draft', finalized_at: CLEARED, finalized_by: CLEARED, last_updated: today(now) });
  }

  // set_stage
  if (!STAGES.includes(body.stage)) return reply(400, { error: 'invalid stage (final is only reachable by finalize)' });
  if (period.published || period.status === 'final' || period.bva_import_status === 'final') {
    return reply(409, { ok: false, action, blockers: [{ code: 'locked', message: 'Final or published periods change state only by reopen.', overridable: false }] });
  }
  return update({ status: body.stage });
}

// Create a period with its state in a single service-role write, then verify.
async function createPeriod(svc, data, user, now) {
  if (!data || typeof data !== 'object') return reply(400, { error: 'data required' });
  const month = Number(data.month);
  const year = Number(data.year);
  if (!data.label || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
    return reply(400, { error: 'label, month (1-12) and year are required' });
  }
  const sameMonth = async () => (await svc.entities.ReportingPeriod.filter({ month, year }, undefined, 50)) || [];

  // Duplicate-safe: a month that already exists is never created again (a
  // retry after a lost response finds the first record here).
  const existing = await sameMonth();
  if (existing.length) {
    return reply(409, { ok: false, action: 'create', period_id: existing[0].id, blockers: [{ code: 'period_exists', message: `${data.label} already exists.`, overridable: false }] });
  }

  const fields = { ...data };
  for (const k of PROTECTED_FIELDS) delete fields[k];
  for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k]; // Base44 rejects null
  const created = await svc.entities.ReportingPeriod.create({
    ...fields,
    month,
    year,
    status: 'draft',
    published: false,
    bva_import_status: 'draft',
    finalized_at: CLEARED,
    finalized_by: CLEARED,
    last_updated: today(now),
  });

  // Verify what was actually stored, and resolve a concurrent duplicate.
  let stored = null;
  try { stored = await svc.entities.ReportingPeriod.get(created.id); } catch { stored = null; }
  const verified = !!stored && hasInitializedState(stored) && stored.status === 'draft' && stored.published === false && stored.bva_import_status === 'draft';
  const others = (await sameMonth()).filter((p) => p.id !== created.id);
  if (!verified || others.length) {
    let removed = false;
    try { await svc.entities.ReportingPeriod.delete(created.id); removed = true; } catch { removed = false; }
    if (others.length) {
      return reply(409, { ok: false, action: 'create', period_id: others[0].id, blockers: [{ code: 'period_exists', message: `${data.label} already exists.`, overridable: false }] });
    }
    return reply(500, {
      ok: false,
      action: 'create',
      error: 'initialization_failed',
      message: removed
        ? 'The period could not be initialized and was removed. Nothing was created.'
        : 'The period could not be initialized and could not be removed; it has no valid state and cannot be finalized or published.',
      period_id: removed ? null : created.id,
    });
  }
  return reply(201, { ok: true, action: 'create', period_id: created.id, state: pickState(stored) });
}

function pickState(p) {
  const out = {};
  for (const k of ['status', 'published', 'bva_import_status', 'finalized_at']) if (k in p) out[k] = p[k];
  return out;
}
