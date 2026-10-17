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
//   check       evaluate finalize and publish rules (including the cross-period
//               checks, returned with their warnings); writes nothing
//   finalize    draft -> final (records override / exclusion reasons); NOT published
//   publish     final -> published
//   reopen      EXCEPTIONAL: published or final -> draft (unpublishes; figures
//               untouched). Requires a written reason; for a published period
//               also the exact period label as confirmation. Every reopen is
//               appended to reopen_log. Until draft revisions exist, published
//               historical reports are meant to stay published.
//   invalidate  before a re-import: final -> draft; refused if published
//   set_stage   intermediate review stages only (never 'final'); not when final/published
//   confirm_checklist / unconfirm_checklist
//               record (or withdraw) one checklist item's confirmation: who,
//               when, a fingerprint of the data it covers and the linked
//               warnings seen (checklistCore.ts). Refused for a published
//               period and while a linked blocker is open. One write.
//
//   prepare_import  where a BVA upload goes (create / update a draft in place /
//                   create + verify a draft revision of a published month /
//                   reuse the open one); see prepareImport below
//
// Draft revisions (base44/shared/periodRevisionCore.ts, periodVersions.ts):
//   create_revision  copy a final or published report (the month's current
//                    version) into a new draft version; written reason
//   copy_revision    continue / verify a copy that did not finish in one call
//   discard_revision remove an unpublished revision
//   publish          for a revision: ONE write publishes it (clients switch at
//                    that moment), a second marks the version it replaced
//                    superseded + unpublished; a retry finishes that second
//                    write; refused if a newer version has been published
//   finish_supersede complete the second write of an earlier publish
// Superseded and discarded versions are read-only: every state change is refused.

import { evaluateFinalize, evaluatePublish, recordedOverrides, hasInitializedState, dataWarnings } from './publishGate.ts';
import { monthState, isRevision, isSuperseded, isDiscarded, isFinal, revisionNumber } from './periodVersions.ts';
import { REVISION_FIELDS, REQUIRED_REVISION_FIELDS, SchemaOutOfDate, revisionRecord, copyStep, discardStep } from './periodRevisionCore.ts';
import { alignedPrevious, alignedNext, crossPeriodChecks, laterMonthChecks, UNAVAILABLE } from './crossPeriod.ts';
import { CHECKLIST_ITEMS, CHECKLIST_KEYS, partHashes, warningCodes, checklistStatus, confirmationRecord, itemMessage, isDataBlocker, buildReview } from './checklistCore.ts';
import { stageDetail, commitDetail, liveReconciliation } from './detailServer.ts';
import { detailWarnings } from './detailReport.ts';

// Base44 rejects null for string and number fields (HTTP 422), so a cleared
// timestamp / name is written as '' -- the gate treats '' as "not set".
export const CLEARED = '';
// State written by the server; never accepted from the caller on create.
export const PROTECTED_FIELDS = ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log', 'checklist_confirmations', 'detail_import', ...REVISION_FIELDS];

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

// ---- reads for the checks -----------------------------------------------------
// Base44 rate-limits bursts of reads and can briefly fail one: every read the
// checks make is retried up to 3 times with short, growing pauses. If a read
// still fails, the checks FAIL CLOSED (they never pass on missing data).
export const readRetryOptions = { delaysMs: [300, 800, 1500] };
const listOf = (res) => (Array.isArray(res) ? res : (res && res.items) || []);
async function readWithRetry(fn) {
  const delays = readRetryOptions.delaysMs;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}
const readList = (svc, entity, query, limit) => readWithRetry(async () => listOf(await svc.entities[entity].filter(query, undefined, limit)));

// A period's own child records, read ONCE per request and shared by the
// cross-period and checklist evaluations. Throws if a read keeps failing.
export async function periodRecords(svc, period) {
  return {
    distributions: await readList(svc, 'Distribution', { period_id: period.id }, 500),
    transfers: await readList(svc, 'RecurringTransfer', { period_id: period.id }, 500),
    cash: await readList(svc, 'CashAccount', { period_id: period.id }, 500),
    savings: await readList(svc, 'SavingsSpend', { period_id: period.id }, 500),
  };
}

// Cross-period checks (crossPeriod.ts): the versions clients see for the
// months before and after this period, compared with this period. Reads only.
// `records`: this period's child records if already read (periodRecords).
// If anything cannot be read, the result is a single blocking finding.
export async function crossPeriodContext(svc, period, lines, records = undefined) {
  try {
    const year = Number(period.year);
    const periods = [];
    for (const y of [year - 1, year, year + 1]) periods.push(...(await readList(svc, 'ReportingPeriod', { year: y }, 500)));
    const prev = alignedPrevious(periods, period);
    const next = alignedNext(periods, period);
    let cur = { period, lines };
    let prevSide = null;
    if (prev.period) {
      const own = records || (await periodRecords(svc, period));
      cur = { period, lines, distributions: own.distributions, transfers: own.transfers, cash: own.cash };
      const p = prev.period;
      prevSide = {
        period: p,
        lines: await readList(svc, 'BudgetLine', { period_id: p.id }, 5000),
        distributions: await readList(svc, 'Distribution', { period_id: p.id }, 500),
        transfers: await readList(svc, 'RecurringTransfer', { period_id: p.id }, 500),
        cash: await readList(svc, 'CashAccount', { period_id: p.id }, 500),
      };
    }
    const findings = [
      ...crossPeriodChecks(cur, prevSide, { conflict: prev.conflict, openRevision: prev.openRevision }),
      ...laterMonthChecks(cur, next.period ? { period: next.period } : null),
    ];
    const ref = (p) => (p ? { id: p.id, label: p.label } : null);
    return { findings, previous: ref(prev.period), next: ref(next.period) };
  } catch {
    return { findings: [UNAVAILABLE], previous: null, next: null, unavailable: true };
  }
}

// The checklist (checklistCore.ts): fingerprints of the data each item covers,
// the warnings showing now, and each item's state. Reads only.
// `records`: this period's child records (periodRecords) if already read;
// null means they could not be read. Then every item is blocked: fail closed.
export async function checklistContext(svc, period, lines, cross, records = undefined) {
  let rec = records;
  if (rec === undefined) { try { rec = await periodRecords(svc, period); } catch { rec = null; } }
  const findings = cross ? cross.findings : [];
  if (!rec) {
    const items = CHECKLIST_ITEMS.map((i) => ({ key: i.key, label: i.label, state: 'blocked', blockedBy: ['checklist_unavailable'], changedParts: [], newWarnings: [], by: null, at: null }));
    return { unavailable: true, hashes: {}, warnings: [], items };
  }
  const hashes = partHashes({ period, lines, ...rec });
  // What still stands in the way, as publish sees it (accepted reasons count).
  const open = evaluatePublish(period, lines, findings, null).blockers.filter(isDataBlocker);
  const warnings = warningCodes(period, findings);
  const items = checklistStatus({ confirmations: period.checklist_confirmations, hashes, openBlockers: open, warnings });
  return { hashes, warnings, items };
}

// Both evaluations for one request, sharing one read of the period's records.
export async function reviewContexts(svc, period, lines) {
  let records;
  try { records = await periodRecords(svc, period); } catch { records = null; }
  const cross = records ? await crossPeriodContext(svc, period, lines, records) : { findings: [UNAVAILABLE], previous: null, next: null, unavailable: true };
  const cl = await checklistContext(svc, period, lines, cross, records);
  return { cross, cl };
}

// ---- checklist writes, hardened against stale reads -------------------------
// Base44 has no conditional writes and its reads can briefly lag a write, so a
// confirmation is written as:
//   1. read the freshest state: never older than any state already seen (the
//      request's own load included); a revision counter inside
//      checklist_confirmations tells which state is newer;
//   2. change ONLY this item, on top of that state (every other confirmation
//      is carried over unchanged), stamped with the next revision and a
//      unique token -- one write;
//   3. read back until the stored token is ours and every item matches what
//      was written (or a later write landed that still has our change).
// If the latest state cannot be read reliably, or the write cannot be
// verified, the caller is told it was NOT saved and must retry (fail safe).
// No schema change: the revision lives inside the existing object field.
export const CHECKLIST_REVISION = '_revision';
export const checklistWriteOptions = { tries: 5, delayMs: 400 };
const revOf = (c) => (c && typeof c === 'object' && c[CHECKLIST_REVISION] && Number.isFinite(Number(c[CHECKLIST_REVISION].n)) ? Number(c[CHECKLIST_REVISION].n) : 0);
const itemsOf = (c) => Object.fromEntries(CHECKLIST_KEYS.filter((k) => c && c[k]).map((k) => [k, c[k]]));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function writeChecklistItem(svc, period, key, record, who, now) {
  const { tries, delayMs } = checklistWriteOptions;
  const pause = () => new Promise((r) => setTimeout(r, delayMs));
  const read = async () => { try { return (await svc.entities.ReportingPeriod.get(period.id)) || null; } catch { return null; } };
  // 1. the freshest state
  let newestSeen = revOf(period.checklist_confirmations);
  let latest = await read();
  for (let i = 0; i < tries && (!latest || revOf(latest.checklist_confirmations) < newestSeen); i++) {
    if (latest) newestSeen = Math.max(newestSeen, revOf(latest.checklist_confirmations));
    await pause();
    latest = await read();
  }
  if (!latest || revOf(latest.checklist_confirmations) < newestSeen) return { ok: false, reason: 'stale' };
  if (latest.published) return { ok: false, reason: 'published' };
  // 2. only this item changes
  const base = latest.checklist_confirmations && typeof latest.checklist_confirmations === 'object' ? latest.checklist_confirmations : {};
  const next = { ...itemsOf(base) };
  if (record) next[key] = record; else delete next[key];
  const token = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  next[CHECKLIST_REVISION] = { n: revOf(base) + 1, token, by: who, at: now.toISOString() };
  const checklist = { ...(latest.checklist && typeof latest.checklist === 'object' ? latest.checklist : {}), [key]: !!record };
  await svc.entities.ReportingPeriod.update(period.id, { checklist_confirmations: next, checklist, last_updated: now.toISOString().slice(0, 10) });
  // 3. verify what is stored
  for (let i = 0; i < tries; i++) {
    const stored = await read();
    // The same write set this item's true/false box: if the box shows our write
    // but checklist_confirmations is absent, the deployed schema dropped the
    // field. If the box does not show it yet, the read is stale: keep checking.
    if (record && stored && !stored.checklist_confirmations && stored.checklist && stored.checklist[key] === true) return { ok: false, reason: 'schema' };
    const c = stored && stored.checklist_confirmations;
    if (c && c[CHECKLIST_REVISION] && c[CHECKLIST_REVISION].token === token) {
      return sameJson(itemsOf(c), itemsOf(next)) ? { ok: true, confirmations: next } : { ok: false, reason: 'mismatch' };
    }
    if (c && revOf(c) > revOf(next)) {
      // a later write landed after ours: it must still carry our change
      const kept = record ? !!c[key] && c[key].at === record.at : !c[key];
      return kept ? { ok: true, confirmations: c } : { ok: false, reason: 'overtaken' };
    }
    await pause();
  }
  return { ok: false, reason: 'unverified' };
}

// Draft revisions: copy the month's current final / published version into a
// new draft version (Phase 4 rules: one open revision per month; concurrent
// creation keeps the earliest; schema check; copy + verify). Shared by
// create_revision and prepare_import.
async function createRevision(svc, period, reasonIn, who, now) {
  const action = 'create_revision';
  const refuse = (code, message) => reply(409, { ok: false, action, blockers: [{ code, message, overridable: false }] });
  const listOf = (res) => (Array.isArray(res) ? res : (res && res.items) || []);
  const monthVersions = async () => listOf(await svc.entities.ReportingPeriod.filter({ month: period.month, year: period.year }, undefined, 200));
  const getOrNull = async (id) => { try { return (await svc.entities.ReportingPeriod.get(id)) || null; } catch { return null; } };
  if (!period.published && !isFinal(period)) return refuse('source_not_final', 'Only a final or published report can be revised. Edit this draft directly.');
  const reason = typeof reasonIn === 'string' ? reasonIn.trim() : '';
  if (reason.length < MIN_REOPEN_REASON) return refuse('revision_reason_required', `Give a reason for the revision (at least ${MIN_REOPEN_REASON} characters).`);
  const state = monthState(await monthVersions());
  if (state.conflict) return refuse('version_conflict', `${period.label} has more than one published version; resolve that first.`);
  if (state.pendingCleanup.length) return refuse('supersede_pending', `An earlier replacement of ${period.label} is not finished; finish it first.`);
  if (state.unpublishedRevisions.length) return refuse('open_revision_exists', `${period.label} already has a correction that is not published yet (revision ${revisionNumber(state.unpublishedRevisions[0])}).`);
  if (state.current ? state.current.id !== period.id : state.working?.id !== period.id) {
    return refuse('not_current_version', `Only the current version of ${period.label} can be revised.`);
  }
  const created = await svc.entities.ReportingPeriod.create(revisionRecord(period, { reason, by: who, now }));
  // Base44 drops fields its schema does not declare. If the version fields
  // did not stick (entity schemas older than these functions), the record
  // would be an untracked second copy of the month: remove it and refuse.
  const stored = (await getOrNull(created.id)) || created;
  const lost = REQUIRED_REVISION_FIELDS.filter((f) => stored[f] === undefined || stored[f] === null || stored[f] === '');
  if (lost.length) {
    await discardStep(svc, { ...stored, revision_status: 'discarded' }).catch(() => {});
    return refuse('schema_out_of_date', new SchemaOutOfDate(`ReportingPeriod.${lost[0]}`).message);
  }
  // No transactions: two admins could create revisions at the same moment.
  // Keep the earliest; discard this one if it is not.
  const open = monthState(await monthVersions()).openRevisions
    .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')) || String(a.id).localeCompare(String(b.id)));
  if (open.length > 1 && open[0].id !== created.id) {
    await discardStep(svc, created).catch(() => {});
    return refuse('concurrent_revision', `Another revision of ${period.label} was created at the same moment; use that one.`);
  }
  let copy;
  try {
    copy = await copyStep(svc, created, period);
  } catch (e) {
    if (!(e instanceof SchemaOutOfDate)) throw e;
    await discardStep(svc, { ...stored, revision_status: 'discarded' }).catch(() => {});
    return refuse('schema_out_of_date', e.message);
  }
  return reply(200, { ok: true, action: 'create_revision', period_id: created.id, source_id: period.id, revision_number: created.revision_number, copy: { done: copy.done, verified: copy.verified ?? null, copied: copy.copied } });
}


// ---- prepare_import: the target of a BVA upload (the updated-BVA workflow) --
// The admin only uploads the workbook; this decides, from the month's versions
// as the SERVER reads them, where the import goes -- using the Phase 4 rules
// unchanged:
//   - no version                      -> create (the importer creates it)
//   - an unpublished draft / final    -> update it in place (a final one is
//                                        reset to draft by 'invalidate')
//   - published, no correction yet    -> create a draft revision of the
//                                        published version (written reason:
//                                        "Updated BVA workbook <file> uploaded
//                                        by <user> on <date>" + optional note),
//                                        copy and verify it, then update it
//   - one unpublished correction      -> update it (open, or final and not yet
//                                        published: reset to draft like any
//                                        final unpublished report)
//   - conflicting published versions, an unfinished replacement, or more
//     than one correction             -> refused (History & recovery)
// The published version is never written. Safe to repeat: a second call finds
// the correction and reuses it; two calls at the same moment end with one
// revision (createRevision keeps the earliest).
//
// Read-after-write lag: right after a publish, Base44 may not yet show it to
// these reads (the correction still unpublished, or the replaced version not
// yet superseded). Before deciding, the month is CONFIRMED: every version the
// decision rests on is re-read by id and must agree with the list, and the
// half-published patterns must be absent. If not, the month is read again
// after a short pause (prepareOptions.settleDelaysMs). If it never settles the
// upload is refused with 'state_settling' ("try again in a few seconds") and
// nothing is written. A replacement still unfinished long after its publish is
// a real interruption: refused as before, with the pointer to recovery.
export const PREPARE_COPY_ROUNDS = 4;
// A copy younger than this may still be running in another call (there are no
// locks): only the call that created the revision copies into it meanwhile, so
// two uploads at the same moment never copy into the same revision twice.
// settleDelaysMs: pauses between reads of a month that has not settled.
// recentPublishMs: an unfinished replacement younger than this is treated as a
// publish still becoming visible, not as an interruption.
export const prepareOptions = { copyStaleMs: 3 * 60 * 1000, settleDelaysMs: [400, 800, 1600, 2400], recentPublishMs: 2 * 60 * 1000 };
export function updatedWorkbookReason({ filename, who, now, note }) {
  const base = `Updated BVA workbook ${String(filename || 'workbook').trim() || 'workbook'} uploaded by ${who} on ${today(now)}`;
  const extra = typeof note === 'string' ? note.trim() : '';
  return extra ? `${base}. Note: ${extra.slice(0, 500)}` : base;
}

// createRevision refusals that a stale read can cause: read again, then decide.
const SETTLE_CODES = new Set(['not_current_version', 'supersede_pending', 'version_conflict', 'open_revision_exists', 'concurrent_revision']);
const STATE_KEYS = ['published', 'superseded', 'superseded_by', 'status', 'bva_import_status', 'revision_status', 'copy_status'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// What the server saw (ids and flags only), returned with a refusal for diagnosis.
const observed = (versions) => versions.map((v) => ({ id: v.id, rev: revisionNumber(v), published: !!v.published, superseded: !!v.superseded, final: isFinal(v), revision_status: v.revision_status || null, copy_status: v.copy_status || null }));

async function prepareImport(svc, body, user, now) {
  const action = 'prepare_import';
  const who = user.email || user.full_name || 'admin';
  const refuse = (code, message, extra = {}) => reply(409, { ok: false, action, blockers: [{ code, message, overridable: false }], ...extra });
  const month = Number(body.month), year = Number(body.year);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return reply(400, { error: 'month and year required' });
  const listOf = (res) => (Array.isArray(res) ? res : (res && res.items) || []);
  const versionsOf = async () => listOf(await svc.entities.ReportingPeriod.filter({ month, year }, undefined, 200)).filter((p) => !isDiscarded(p));
  const getOrNull = async (id) => { try { return (await svc.entities.ReportingPeriod.get(id)) || null; } catch { return null; } };
  const RECOVERY = 'Open Review & Publish → History & recovery.';
  const SETTLING = 'just changed and the change is not visible yet. Nothing was imported; try the upload again in a few seconds.';

  // Finish (or verify) a correction's copy before anything imports into it.
  const ensureCopied = async (rev, createdHere) => {
    if (rev.copy_status === 'verified') return { ok: true };
    if (rev.copy_status === 'failed') return { ok: false, code: 'copy_failed', message: `The corrected version does not match the published report it was copied from, so nothing was imported. ${RECOVERY}` };
    const started = Date.parse(rev.revision_created_at || rev.created_date || '');
    if (!createdHere && Number.isFinite(started) && now.getTime() - started < prepareOptions.copyStaleMs) {
      return { ok: false, code: 'copy_in_progress', message: 'The corrected version is still being prepared from the published report. Nothing was imported; try the upload again in a moment.' };
    }
    const source = await getOrNull(rev.supersedes);
    if (!source) return { ok: false, code: 'source_missing', message: 'The version this correction was copied from no longer exists.' };
    try {
      for (let i = 0; i < PREPARE_COPY_ROUNDS; i++) {
        const copy = await copyStep(svc, rev, source);
        if (copy.done && copy.verified) return { ok: true };
        if (copy.done && copy.verified === false) {
          return { ok: false, code: 'copy_failed', message: `The corrected version does not match the published report it was copied from, so nothing was imported. ${RECOVERY}` };
        }
      }
    } catch (e) {
      if (e instanceof SchemaOutOfDate) return { ok: false, code: 'schema_out_of_date', message: e.message };
      return { ok: false, code: 'copy_unverified', message: 'The copy of the published report could not be completed just now. Nothing was imported; try the upload again in a moment.' };
    }
    return { ok: false, code: 'copy_unverified', message: 'The copy of the published report is not finished yet. Nothing was imported; try the upload again in a moment.' };
  };
  const intoRevision = async (rev, created, attempts) => {
    const c = await ensureCopied(rev, created);
    if (!c.ok) {
      // A correction THIS call created whose copy failed verification holds
      // nothing anyone imported: remove it, so the next upload starts afresh
      // instead of being stuck behind it.
      if (created && c.code === 'copy_failed') {
        const gone = await discardStep(svc, { ...rev, revision_status: 'discarded' }).then((d) => d.done).catch(() => false);
        if (gone) return refuse('copy_failed_retry', 'The copy of the published report could not be verified, so it was removed and nothing was imported. Try the upload again.', { target_id: null });
      }
      return refuse(c.code, c.message, { target_id: rev.id });
    }
    return reply(200, { ok: true, action, mode: created ? 'correct' : 'continue', target_id: rev.id, source_id: rev.supersedes, revision_number: revisionNumber(rev), settle_attempts: attempts });
  };

  // Read the month and confirm it: { versions, state } when settled, or
  // { unsettled: reason } when a publish (or another upload) is still
  // becoming visible.
  const confirmMonth = async () => {
    const versions = await versionsOf();
    const state = monthState(versions);
    const byId = new Map(versions.map((v) => [v.id, v]));
    // A version marked superseded by a correction that shows as never
    // published (neither published now nor itself replaced since).
    for (const v of versions) {
      if (isSuperseded(v) && v.superseded_by) {
        const by = byId.get(v.superseded_by);
        if (!by || (!by.published && !isSuperseded(by) && !isDiscarded(by))) return { unsettled: 'replacement_not_visible', versions };
      }
    }
    // The versions the decision rests on, re-read by id, must agree with the list.
    const keyIds = [state.current?.id, ...state.unpublishedRevisions.map((r) => r.id), ...state.pendingCleanup.map((r) => r.id), state.working?.id].filter(Boolean);
    for (const id of [...new Set(keyIds)]) {
      const fresh = await getOrNull(id);
      const listed = byId.get(id);
      if (!fresh || STATE_KEYS.some((k) => JSON.stringify(fresh[k] ?? null) !== JSON.stringify(listed[k] ?? null))) return { unsettled: 'reads_disagree', versions };
    }
    return { versions, state };
  };

  let lastUnsettled = null;
  const delays = prepareOptions.settleDelaysMs || [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) await pause(delays[attempt - 1]);
    const seen = await confirmMonth();
    if (seen.unsettled) { lastUnsettled = seen; continue; }
    const { versions, state } = seen;
    if (!versions.length) return reply(200, { ok: true, action, mode: 'create', target_id: null, settle_attempts: attempt + 1 });
    const label = versions[0].label || `${month}/${year}`;
    if (state.conflict) return refuse('version_conflict', `${label} has more than one published version. ${RECOVERY}`, { observed: observed(versions) });
    if (state.pendingCleanup.length) {
      // The second write of a publish not visible yet -- or a publish that
      // really was interrupted. Only time tells them apart.
      const newest = Math.max(...state.versions.filter((v) => v.published).map((v) => Date.parse(v.updated_date || v.publication_date || '') || 0));
      if (now.getTime() - newest < prepareOptions.recentPublishMs) { lastUnsettled = { unsettled: 'replacement_pending', versions }; continue; }
      return refuse('supersede_pending', `An earlier replacement of ${label} did not finish. ${RECOVERY}`, { observed: observed(versions) });
    }
    if (state.unpublishedRevisions.length > 1) return refuse('open_revisions', `${label} has ${state.unpublishedRevisions.length} corrections in progress. ${RECOVERY}`, { observed: observed(versions) });
    if (state.unpublishedRevisions.length === 1) {
      // A FINAL correction also looks like this for a moment right after it is
      // published (neither publish write visible yet): confirm it on a second read.
      if (isFinal(state.unpublishedRevisions[0]) && attempt === 0 && delays.length) { lastUnsettled = { unsettled: 'final_correction_recheck', versions }; continue; }
      return intoRevision(state.unpublishedRevisions[0], false, attempt + 1);
    }
    if (!state.current) {
      const w = state.working;
      if (!w) return refuse('no_target', `${label} has no version an import can update. ${RECOVERY}`, { observed: observed(versions) });
      return reply(200, { ok: true, action, mode: 'update', target_id: w.id, settle_attempts: attempt + 1 });
    }
    // Published: create the draft revision of the version clients see.
    const res = await createRevision(svc, state.current, updatedWorkbookReason({ filename: body.filename, who, now, note: body.note }), who, now);
    if (res.status === 200) {
      const rev = await getOrNull(res.body.period_id);
      if (!rev) return refuse('revision_not_found', 'The corrected version could not be read back. Try the upload again.');
      return intoRevision(rev, true, attempt + 1);
    }
    // Someone else created it at the same moment, or createRevision read the
    // month differently (lag): read the month again and decide from that.
    const code = res.body?.blockers?.[0]?.code;
    if (SETTLE_CODES.has(code)) { lastUnsettled = { unsettled: `create_revision:${code}`, versions }; continue; }
    return reply(res.status, { ...res.body, action });
  }
  const label = lastUnsettled?.versions?.[0]?.label || `${month}/${year}`;
  return refuse('state_settling', `${label} ${SETTLING}`, { reason: lastUnsettled?.unsettled || null, observed: observed(lastUnsettled?.versions || []) });
}

export async function handlePeriodTransition(base44, body = {}, user, now = new Date()) {
  if (!user) return reply(401, { error: 'Unauthorized' });
  if (user.role !== 'admin') return reply(403, { error: 'Admins only' });
  const { action, period_id } = body;
  if (!period_id && action !== 'create' && action !== 'prepare_import') return reply(400, { error: 'period_id required' });
  if (!['create', 'prepare_import', 'check', 'finalize', 'publish', 'reopen', 'invalidate', 'set_stage', 'create_revision', 'copy_revision', 'discard_revision', 'finish_supersede', 'confirm_checklist', 'unconfirm_checklist', 'stage_detail', 'commit_detail'].includes(action)) {
    return reply(400, { error: 'unknown action' });
  }
  const svc = base44.asServiceRole;
  if (action === 'create') return createPeriod(svc, body.data, user, now);
  if (action === 'prepare_import') return prepareImport(svc, body, user, now);

  const { period, lines } = await load(svc, period_id);
  if (!period) return reply(404, { error: 'Period not found' });
  const who = user.email || user.full_name || 'admin';
  // Phase 5b transaction detail (detailServer.ts): staged in chunks, then
  // committed in one switch; only unpublished, unreplaced versions.
  if (action === 'stage_detail') { const r = await stageDetail(svc, period, body); return reply(r.status, { action, ...r.body }); }
  if (action === 'commit_detail') { const r = await commitDetail(svc, period, body, who, now); return reply(r.status, { action, ...r.body }); }
  const update = async (data) => {
    await svc.entities.ReportingPeriod.update(period.id, data);
    return reply(200, { ok: true, action, period_id: period.id, state: { ...pickState(period), ...pickState(data) } });
  };

  const refuse = (code, message) => reply(409, { ok: false, action, blockers: [{ code, message, overridable: false }] });
  const listOf = (res) => (Array.isArray(res) ? res : (res && res.items) || []);
  const monthVersions = async () => listOf(await svc.entities.ReportingPeriod.filter({ month: period.month, year: period.year }, undefined, 200));
  const getOrNull = async (id) => { try { return (await svc.entities.ReportingPeriod.get(id)) || null; } catch { return null; } };
  // The second write of a publish: mark the replaced version superseded.
  const supersede = async (replaced, by) => {
    try {
      await svc.entities.ReportingPeriod.update(replaced.id, { superseded: true, superseded_by: by.id, superseded_at: now.toISOString(), published: false });
      return true;
    } catch {
      return false;
    }
  };

  if (action === 'check') {
    // A published report is never re-judged: no cross-period or checklist evaluation for it.
    if (period.published) {
      return reply(200, { ok: true, finalize: evaluateFinalize(period, lines, body.overrides || {}, null), publish: evaluatePublish(period, lines, null), cross_period: null, checklist: null, review: null });
    }
    const { cross, cl } = await reviewContexts(svc, period, lines);
    const finalize = evaluateFinalize(period, lines, body.overrides || {}, cross.findings);
    const publish = evaluatePublish(period, lines, cross.findings, cl.items);
    // A draft's open issues are what finalize will ask about; a final period's, what publish will.
    const final = period.status === 'final' && period.bva_import_status === 'final';
    // Transaction detail differences are warnings only (never blockers).
    const detail = await liveReconciliation(svc, period, lines);
    const review = buildReview({ period, blockers: final ? publish.blockers : finalize.blockers, crossFindings: cross.findings, crossRan: !!cross.previous && !cross.unavailable, items: cl.items, previousLabel: cross.previous?.label || null, dataWarnings: [...dataWarnings(period, lines), ...detailWarnings(detail)] });
    return reply(200, { ok: true, finalize, publish, cross_period: cross, checklist: { items: cl.items, unavailable: !!cl.unavailable }, review, detail: detail ? { reconciliation: detail } : null });
  }

  // Superseded and discarded versions are kept as they are.
  if (isDiscarded(period)) return refuse('revision_discarded', 'This revision was discarded.');
  if (isSuperseded(period) && action !== 'finish_supersede') {
    return refuse('superseded_read_only', `This version of ${period.label} was replaced by a newer one and is kept read-only.`);
  }

  if (action === 'confirm_checklist' || action === 'unconfirm_checklist') {
    const key = body.item;
    if (!CHECKLIST_KEYS.includes(key)) return reply(400, { error: 'unknown checklist item' });
    if (period.published) return refuse('published_read_only', 'This period is published and read-only; its checklist is kept as it was.');
    let record = null;
    if (action === 'confirm_checklist') {
      const { cross, cl } = await reviewContexts(svc, period, lines);
      const s = cl.items.find((i) => i.key === key);
      if (s.state === 'blocked') return reply(409, { ok: false, action, blockers: [{ code: 'checklist_item_blocked', message: itemMessage(s), overridable: false, linked: s.blockedBy }] });
      record = confirmationRecord(key, cl.hashes, cl.warnings, who, now.toISOString());
    }
    const w = await writeChecklistItem(svc, period, key, record, who, now);
    if (w.ok) return reply(200, { ok: true, action, period_id: period.id, item: key, ...(record ? { confirmation: record } : {}) });
    if (w.reason === 'published') return refuse('published_read_only', 'This period is published and read-only; its checklist is kept as it was.');
    if (w.reason === 'schema') return refuse('schema_out_of_date', 'The confirmation could not be stored (the data schema does not have checklist_confirmations yet). Publish the entity schemas, then try again.');
    return refuse('checklist_not_saved', w.reason === 'stale'
      ? 'The latest checklist state could not be read reliably, so nothing was saved. Try again in a moment.'
      : 'The checklist change could not be confirmed as saved. Reload the page and check the item; try again if it is not shown as you set it.');
  }

  if (action === 'create_revision') return createRevision(svc, period, body.reason, who, now);

  if (action === 'copy_revision') {
    if (!isRevision(period)) return refuse('not_a_revision', 'This period is not a revision.');
    if (period.copy_status === 'verified') return reply(200, { ok: true, action, period_id: period.id, copy: { done: true, verified: true } });
    const source = await getOrNull(period.supersedes);
    if (!source) return refuse('source_missing', 'The version this revision was copied from no longer exists.');
    const copy = await copyStep(svc, period, source);
    return reply(200, { ok: true, action, period_id: period.id, copy: { done: copy.done, verified: copy.verified ?? null, copied: copy.copied, report: copy.report } });
  }

  if (action === 'discard_revision') {
    if (!isRevision(period)) return refuse('not_a_revision', 'Only a revision can be discarded.');
    if (period.published) return refuse('published', 'A published revision cannot be discarded.');
    const step = await discardStep(svc, period);
    return reply(200, { ok: true, action, period_id: period.id, done: step.done });
  }

  if (action === 'finish_supersede') {
    if (!isRevision(period) || !period.published) return refuse('not_a_published_revision', 'Only a published revision replaces a version.');
    const replaced = await getOrNull(period.supersedes);
    if (!replaced || (isSuperseded(replaced) && replaced.superseded_by === period.id && !replaced.published)) {
      return reply(200, { ok: true, action, period_id: period.id, unchanged: true });
    }
    if (isSuperseded(replaced) && replaced.superseded_by !== period.id) return refuse('replaced_by_other', 'That version was replaced by a different revision.');
    const done = await supersede(replaced, period);
    return done ? reply(200, { ok: true, action, period_id: period.id, superseded: replaced.id }) : reply(500, { ok: false, action, error: 'The replaced version could not be marked superseded; try again.' });
  }

  if (action === 'finalize') {
    if (isRevision(period) && period.copy_status !== 'verified') {
      return refuse('revision_copy_unverified', 'This revision\'s copy has not been verified as complete. Continue the copy (or discard the revision).');
    }
    const overrides = body.overrides || {};
    const cross = await crossPeriodContext(svc, period, lines);
    const result = evaluateFinalize(period, lines, overrides, cross.findings);
    if (!result.ok) return reply(409, { ok: false, action, blockers: result.blockers, cross_period: cross });
    const at = now.toISOString();
    const recorded = recordedOverrides(period, lines, overrides, who, at, cross.findings);
    const warnings = (Array.isArray(period.bva_validation_warnings) ? period.bva_validation_warnings : []).map((w) => {
      const o = recorded[`open_reconciliation:${w.code}`];
      return o && w.blocksFinalize ? { ...w, overridden: true, override: o, blocksFinalize: false } : w;
    });
    // The attached detail's reconciliation is refreshed against the final
    // figures, so what is published records the comparison as published.
    const detail = period.detail_import?.status === 'attached' ? await liveReconciliation(svc, period, lines) : null;
    return update({
      status: 'final',
      bva_import_status: 'final',
      finalized_at: at,
      finalized_by: who,
      bva_overrides: recorded,
      bva_validation_warnings: warnings,
      last_updated: today(now),
      ...(detail ? { detail_import: { ...period.detail_import, reconciliation: detail, reconciled_at: at } } : {}),
    });
  }

  if (action === 'publish') {
    const state = monthState(await monthVersions());
    // A version replaced by a published newer one (awaiting cleanup) is never
    // published again.
    if (state.pendingCleanup.some((v) => v.id === period.id)) return refuse('replaced_by_newer', `A newer version of ${period.label} has already been published.`);

    if (isRevision(period)) {
      const replaced = await getOrNull(period.supersedes);
      // A retry of a publish that succeeded: never write it again; only finish
      // the second write if it is still missing.
      if (period.published) {
        const pending = replaced && !(isSuperseded(replaced) && replaced.superseded_by === period.id && !replaced.published);
        const finished = pending ? await supersede(replaced, period) : true;
        return reply(200, { ok: true, action, period_id: period.id, already_published: true, supersede_pending: !finished });
      }
      if (period.copy_status !== 'verified') return refuse('revision_copy_unverified', 'This revision\'s copy has not been verified as complete.');
      if (!replaced) return refuse('source_missing', 'The version this revision was copied from no longer exists.');
      if (isSuperseded(replaced)) return refuse('stale_revision', `The version this revision was copied from has already been replaced by another revision. This revision is out of date; discard it.`);
      // The version it replaces must still be the month's latest (this
      // revision aside): the current published report, or -- if none is
      // published -- the latest final version.
      const others = monthState((await monthVersions()).filter((v) => v.id !== period.id));
      const latest = others.current || others.working;
      if (latest && latest.id !== replaced.id) return refuse('stale_revision', `${period.label} has a newer version than the one this revision was copied from. This revision is out of date; discard it.`);
      const { cross, cl } = await reviewContexts(svc, period, lines);
      const result = evaluatePublish(period, lines, cross.findings, cl.items);
      if (!result.ok) return reply(409, { ok: false, action, blockers: result.blockers, cross_period: cross });
      // The switch: one write. From here clients see the revision.
      await svc.entities.ReportingPeriod.update(period.id, { published: true, publication_date: today(now), reviewed_by: user.full_name || who, last_updated: today(now) });
      const finished = await supersede(replaced, period);
      // No transactions: re-read and report any competing published version.
      const after = monthState(await monthVersions());
      return reply(200, {
        ok: true, action, period_id: period.id, replaced: replaced.id,
        supersede_pending: !finished,
        ...(after.conflict ? { conflict: after.conflict.map((v) => v.id) } : {}),
        state: { ...pickState(period), published: true },
      });
    }

    // An original version: its first publication. Refused once a newer version exists.
    if (state.current && state.current.id !== period.id) return refuse('newer_version_published', `A newer version of ${period.label} is published.`);
    const { cross, cl } = await reviewContexts(svc, period, lines);
    const result = evaluatePublish(period, lines, cross.findings, cl.items);
    if (!result.ok) return reply(409, { ok: false, action, blockers: result.blockers, cross_period: cross });
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
    // An import into a version that has an open revision would bypass it
    // (e.g. a browser still running the previous app version).
    if (monthState(await monthVersions()).unpublishedRevisions.some((r) => r.supersedes === period.id)) {
      return refuse('open_revision_exists', `${period.label} has an open revision; import into the revision instead.`);
    }
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
