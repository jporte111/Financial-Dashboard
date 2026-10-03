// Inline decisions for unresolved validation warnings, made right on the
// Dashboard instead of sending the admin elsewhere.
//
// A decision on a final / published period is exceptional by design: the
// period is REOPENED first (logged with a required written reason), the
// recorded choice is written, and the period is finalized — and re-published
// when it was published — again through the periodTransition function, the
// only supported write path for protected period state. A refusal at any step
// leaves the period reopened as a draft and the error is surfaced; nothing is
// silently dropped.

import { base44 } from '@/api/base44Client';
import { periodTransition } from './periodTransition';
import { parseBlankQuarters } from './bvaDashboard';

export const MIN_REASON = 10;

const norm = (s) => String(s || '').trim().toLowerCase();

// Which inline decisions a warning offers. Only warnings that can actually be
// decided here get controls; everything else keeps its "Open Admin" guidance.
export function decisionOptions(warning) {
  if (!warning || warning.resolution !== 'unresolved') return [];
  if (warning.code === 'distribution_quarter_blank') {
    return [
      { mode: 'confirm_zero', label: 'Confirm none was received' },
      { mode: 'enter_amounts', label: 'Enter the amounts' },
    ];
  }
  if (warning.blocksFinalize && warning.overridable !== false) {
    return [{ mode: 'accept', label: 'Accept with a reason' }];
  }
  return [];
}

// Write the decided values into the Distribution records. Confirming "none
// was received" stores an explicit 0 — a confirmed zero, never a fabricated
// one, so the warning resolves and stays resolved.
async function writeQuarters({ periodId, blanks, values }) {
  const res = await base44.entities.Distribution.filter({ period_id: periodId }, undefined, 100);
  const records = (res && (res.items || res)) || [];
  for (const { entity, quarter } of blanks) {
    const raw = values[`${entity}:${quarter}`];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Enter an amount for ${entity} ${quarter.toUpperCase()}.`);
    }
    const hit = records.find((d) => norm(d.entity_name) === norm(entity));
    if (hit) {
      await base44.entities.Distribution.update(hit.id, { [quarter]: value });
    } else {
      await base44.entities.Distribution.create({ period_id: periodId, entity_name: entity, [quarter]: value });
    }
  }
}

/**
 * @param {object} args
 *   period   the ReportingPeriod the decision applies to
 *   warning  the classified unresolved warning
 *   mode     'confirm_zero' | 'enter_amounts' | 'accept'
 *   reason   written reason (required, >= MIN_REASON characters)
 *   amounts  for 'enter_amounts': { "Sample Bank:q1": 1200, ... }
 */
export async function applyWarningDecision({ period, warning, mode, reason, amounts = {} }) {
  const why = String(reason || '').trim();
  if (!period || !period.id) throw new Error('No reporting period is selected.');
  if (!decisionOptions(warning).some((o) => o.mode === mode)) throw new Error('This warning offers no such decision.');
  if (why.length < MIN_REASON) throw new Error(`Give a written reason of at least ${MIN_REASON} characters.`);

  const wasPublished = !!period.published;
  const wasFinal = wasPublished || period.status === 'final' || period.bva_import_status === 'final';

  if (wasFinal) {
    const reopen = await periodTransition('reopen', period.id, { reason: why, confirm: period.label });
    if (!reopen.ok) {
      throw new Error(reopen.blockers?.[0]?.message || reopen.error || 'Reopening the period was refused.');
    }
  }

  try {
    if (mode === 'confirm_zero' || mode === 'enter_amounts') {
      const blanks = parseBlankQuarters(warning.message);
      if (!blanks.length) throw new Error('The warning does not name any blank distribution quarters.');
      const values =
        mode === 'confirm_zero'
          ? Object.fromEntries(blanks.map(({ entity, quarter }) => [`${entity}:${quarter}`, 0]))
          : amounts;
      await writeQuarters({ periodId: period.id, blanks, values });
    }
    const overrides =
      mode === 'accept' ? { [`open_reconciliation:${warning.code}`]: { reason: why } } : {};
    const fin = await periodTransition('finalize', period.id, { overrides });
    if (!fin.ok) {
      throw new Error((fin.blockers || []).map((b) => b.message).join(' ') || fin.error || 'Finalizing was refused.');
    }
    if (wasPublished) {
      const pub = await periodTransition('publish', period.id);
      if (!pub.ok) {
        throw new Error((pub.blockers || []).map((b) => b.message).join(' ') || pub.error || 'Re-publishing was refused.');
      }
    }
  } catch (e) {
    const suffix = wasFinal
      ? ' The period is now reopened as a draft — finish or revert it on the Admin page.'
      : '';
    throw new Error(`${e?.message || 'The decision could not be applied.'}${suffix}`);
  }
}