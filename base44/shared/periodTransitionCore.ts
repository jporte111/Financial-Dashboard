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
//   check       evaluate finalize and publish rules; writes nothing
//   finalize    draft -> final (records override / exclusion reasons); NOT published
//   publish     final -> published
//   reopen      published or final -> draft (unpublishes; figures untouched)
//   invalidate  before a re-import: final -> draft; refused if published
//   set_stage   intermediate review stages only (never 'final'); not when final/published

import { evaluateFinalize, evaluatePublish, recordedOverrides } from './publishGate.ts';

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
  if (!period_id) return reply(400, { error: 'period_id required' });
  if (!['check', 'finalize', 'publish', 'reopen', 'invalidate', 'set_stage'].includes(action)) {
    return reply(400, { error: 'unknown action' });
  }

  const svc = base44.asServiceRole;
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
    return update({
      published: false,
      status: 'draft',
      ...(period.bva_import_status ? { bva_import_status: 'draft' } : {}),
      finalized_at: null,
      finalized_by: null,
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
    return update({ status: 'draft', bva_import_status: 'draft', finalized_at: null, finalized_by: null, last_updated: today(now) });
  }

  // set_stage
  if (!STAGES.includes(body.stage)) return reply(400, { error: 'invalid stage (final is only reachable by finalize)' });
  if (period.published || period.status === 'final' || period.bva_import_status === 'final') {
    return reply(409, { ok: false, action, blockers: [{ code: 'locked', message: 'Final or published periods change state only by reopen.', overridable: false }] });
  }
  return update({ status: body.stage });
}

function pickState(p) {
  const out = {};
  for (const k of ['status', 'published', 'bva_import_status', 'finalized_at']) if (k in p) out[k] = p[k];
  return out;
}
