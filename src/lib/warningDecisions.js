// Inline decisions for unresolved validation warnings, made right on the
// Dashboard instead of sending the admin elsewhere.
//
// Decisions apply ONLY to a draft period. A final or published period is
// refused before anything is written: changing a published report requires the
// deliberate, typed-confirmation reopen in Admin → Review & Publish
// ("Exceptional administrative action"), never a reopen performed by code.
//
// Every decision leaves an audit record in the period's bva_corrections
// (kind, target, path, original value, value, written reason, who, when) —
// the same records the BVA Import screen keeps — before any value is written.

import { base44 } from '@/api/base44Client';
import { periodTransition } from './periodTransition';
import { parseBlankQuarters } from './bvaDashboard';
import { makeCorrection, correctionKey } from './bvaCorrections';

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

// Why a decision cannot be applied to this period here, or null when it can.
// Final and published periods are read-only in this workflow.
export function decisionBlockedReason(period) {
  if (!period) return 'No reporting period is selected.';
  if (period.published) {
    return `${period.label || 'This period'} is published. To change it, reopen it deliberately in Admin → Review & Publish (Exceptional administrative action), then record the decision on the draft.`;
  }
  if (period.status === 'final' || period.bva_import_status === 'final') {
    return `${period.label || 'This period'} is final and read-only. Reopen it in Admin → Review & Publish before recording a decision.`;
  }
  return null;
}

// The audit records for a decision: one per confirmed or entered quarter, or
// one override record. Paths point into the stored parse, as the BVA Import
// screen's corrections do, so a later re-import keeps the confirmed values.
function decisionCorrections({ period, warning, mode, why, by, at, blanks, values }) {
  if (mode === 'accept') {
    return [makeCorrection({ kind: 'override', target: warning.code, value: null, reason: why, by, at })];
  }
  const entities = period?.bva_parsed_source?.distributions?.entities || [];
  return blanks.map(({ entity, quarter }) => {
    const idx = entities.findIndex((e) => norm(e.name) === norm(entity));
    return makeCorrection({
      kind: mode === 'confirm_zero' ? 'zero_confirm' : 'source',
      target: `${entity} ${quarter.toUpperCase()}`,
      path: idx >= 0 ? `distributions.entities.${idx}.${quarter}` : null,
      originalValue: null,
      value: Number(values[`${entity}:${quarter}`]),
      reason: why,
      by,
      at,
    });
  });
}

// Write the decided values into the Distribution records. Confirming "none
// was received" stores an explicit 0 — a confirmed zero, never a fabricated
// one, so the warning resolves and stays resolved.
async function writeQuarters({ periodId, blanks, values }) {
  /** @type {any} */
  const res = await base44.entities.Distribution.filter({ period_id: periodId }, undefined, 100);
  const records = Array.isArray(res) ? res : (res && res.items) || [];
  for (const { entity, quarter } of blanks) {
    const value = Number(values[`${entity}:${quarter}`]);
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
 *   amounts  for 'enter_amounts': { "Alpha:q1": 1200, ... }
 */
export async function applyWarningDecision({ period, warning, mode, reason, amounts = {} }) {
  const why = String(reason || '').trim();
  const blocked = decisionBlockedReason(period);
  if (blocked) throw new Error(blocked);
  if (!decisionOptions(warning).some((o) => o.mode === mode)) throw new Error('This warning offers no such decision.');
  if (why.length < MIN_REASON) throw new Error(`Give a written reason of at least ${MIN_REASON} characters.`);

  let blanks = [];
  let values = {};
  if (mode === 'confirm_zero' || mode === 'enter_amounts') {
    blanks = parseBlankQuarters(warning.message);
    if (!blanks.length) throw new Error('The warning does not name any blank distribution quarters.');
    values = mode === 'confirm_zero' ? Object.fromEntries(blanks.map(({ entity, quarter }) => [`${entity}:${quarter}`, 0])) : amounts;
    for (const { entity, quarter } of blanks) {
      const v = Number(values[`${entity}:${quarter}`]);
      if (values[`${entity}:${quarter}`] === '' || values[`${entity}:${quarter}`] == null || !Number.isFinite(v) || v < 0) {
        throw new Error(`Enter an amount for ${entity} ${quarter.toUpperCase()}.`);
      }
    }
  }

  // 1. Audit record first, on the draft period (merged with what is there).
  const me = await base44.auth.me().catch(() => null);
  const by = me?.email || me?.full_name || 'admin';
  const at = new Date().toISOString();
  const records = decisionCorrections({ period, warning, mode, why, by, at, blanks, values });
  const byKey = new Map((Array.isArray(period.bva_corrections) ? period.bva_corrections : []).map((c) => [correctionKey(c), c]));
  for (const c of records) byKey.set(correctionKey(c), c);
  await base44.entities.ReportingPeriod.update(period.id, { bva_corrections: [...byKey.values()] });

  // 2. The decided values.
  if (blanks.length) await writeQuarters({ periodId: period.id, blanks, values });

  // 3. Finalize the draft through the server gate (never reopen, never publish).
  const overrides = mode === 'accept' ? { [`open_reconciliation:${warning.code}`]: { reason: why } } : {};
  const fin = await periodTransition('finalize', period.id, { overrides });
  if (!fin.ok) {
    throw new Error(
      `${(fin.blockers || []).map((b) => b.message).join(' ') || fin.error || 'Finalizing was refused.'} The decision and its audit record were saved; the period stays a draft.`
    );
  }
}
