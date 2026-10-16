import React, { useState } from 'react';
import { periodTransition } from '@/lib/periodTransition';
import { monthState, monthKey, versionLabel, isRevision, isSuperseded, isOpenRevision, isFinal } from '../../../base44/shared/periodVersions.ts';

const btn = 'rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = `${btn} border-stone-900 bg-stone-900 text-white hover:bg-stone-700`;
const btnGhost = `${btn} border-stone-200 bg-white text-stone-600 hover:bg-stone-100`;
const MIN_REASON = 10;

// Draft revisions of the selected report (Admin → Review & Publish): create a
// revision of the current version, continue or verify its copy, discard it,
// finish an unfinished replacement, and see a conflict between versions.
// Clients keep seeing the current published version until a revision is
// published (PublishPanel → Publish correction).
export default function RevisionPanel({ period, periods, reload, onOpen }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!period) return null;

  const versions = (periods || []).filter((p) => monthKey(p) === monthKey(period));
  const state = monthState(versions);
  const current = state.current;
  const byId = new Map(versions.map((v) => [v.id, v]));
  const canRevise =
    !state.conflict && !state.pendingCleanup.length && !state.openRevisions.length &&
    (period.published || isFinal(period)) && !isSuperseded(period) &&
    (current ? current.id === period.id : state.working?.id === period.id);

  const show = (res, ok) => setMessage(res.ok ? { ok: true, text: ok } : { ok: false, text: (res.blockers?.[0] && res.blockers[0].message) || res.error || 'Refused' });

  // Copy in as many calls as it takes (each stays well inside Base44's time limit).
  const finishCopy = async (id) => {
    for (let i = 0; i < 20; i++) {
      const r = await periodTransition('copy_revision', id);
      if (!r.ok) return r;
      if (r.copy?.done) return r;
    }
    return { ok: false, error: 'The copy is taking unusually long; continue it later.' };
  };

  const create = async () => {
    setBusy(true);
    setMessage(null);
    const res = await periodTransition('create_revision', period.id, { reason });
    let final = res;
    if (res.ok && !res.copy?.done) final = { ...(await finishCopy(res.period_id)), period_id: res.period_id };
    setBusy(false);
    if (res.ok) {
      const verified = final.copy?.verified;
      setMessage({ ok: !!verified, text: verified ? `Revision ${res.revision_number} created and its copy verified. Clients still see the current version.` : `Revision ${res.revision_number} created, but its copy is ${final.copy?.done ? 'not verified' : 'not complete'} — see below.` });
      setReason('');
      reload();
      onOpen?.(res.period_id);
    } else show(res);
  };

  const continueCopy = async () => {
    setBusy(true);
    const r = await finishCopy(period.id);
    setBusy(false);
    show(r, r.copy?.verified ? 'Copy complete and verified.' : 'Copy finished but not verified — discard this revision and create it again.');
    reload();
  };

  const discard = async () => {
    setBusy(true);
    const r = await periodTransition('discard_revision', period.id);
    setBusy(false);
    show(r, r.done ? 'Revision discarded.' : 'Discard started; run it again to finish.');
    setConfirmDiscard(false);
    reload();
    if (r.ok && r.done && current) onOpen?.(current.id);
  };

  const finishReplacement = async (revision) => {
    setBusy(true);
    const r = await periodTransition('finish_supersede', revision.id);
    setBusy(false);
    show(r, 'Replacement finished: the earlier version is marked superseded.');
    reload();
  };

  const report = period.copy_verification;
  const problems = report && !report.ok
    ? Object.entries(report.entities || {}).filter(([, v]) => v.missing || v.duplicates || v.extra || v.changed || v.wrong_period)
    : [];

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6" data-testid="revision-panel">
      <p className="font-display text-lg">Versions — {period.label}</p>
      <ul className="mt-2 space-y-1 text-sm text-stone-600">
        {state.versions
          .slice()
          .sort((a, b) => (Number(b.revision_number) || 1) - (Number(a.revision_number) || 1))
          .map((v) => (
            <li key={v.id}>
              <button type="button" className={`underline-offset-4 hover:underline ${v.id === period.id ? 'font-semibold' : ''}`} onClick={() => onOpen?.(v.id)}>
                {versionLabel(v)}
              </button>
              {current?.id === v.id && <span className="ml-2 text-xs text-emerald-700">clients see this version</span>}
            </li>
          ))}
      </ul>

      {state.conflict && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" data-testid="version-conflict">
          More than one version of {period.label} is published ({state.conflict.map(versionLabel).join(' and ')}). They were
          published at the same moment, which this system cannot prevent. Decide which one is correct and reopen the other
          (Exceptional administrative action). New revisions of this month are blocked until then.
        </div>
      )}

      {state.pendingCleanup.length > 0 && !state.conflict && current && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="supersede-pending">
          {versionLabel(current)} is published and is what clients see, but marking {state.pendingCleanup.map(versionLabel).join(', ')} as
          superseded did not finish.
          <div className="mt-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => finishReplacement(current)}>Finish replacement</button>
          </div>
        </div>
      )}

      {isRevision(period) && !isSuperseded(period) && !period.published && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700" data-testid="revision-banner">
          <p>
            This is revision {Number(period.revision_number) || 2}, copied from {versionLabel(byId.get(period.supersedes) || { label: period.label })}.
            {current ? ` Clients still see ${versionLabel(current)} until this revision is published.` : ' Nothing for this month is published yet.'}
          </p>
          {period.revision_reason && <p className="mt-1 text-xs text-stone-500">Reason: {period.revision_reason}</p>}
          <p className="mt-1 text-xs">
            Copy: {period.copy_status === 'verified' ? 'complete and verified' : period.copy_status === 'failed' ? 'NOT verified' : 'in progress'}
          </p>
          {problems.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-rose-800">
              {problems.map(([entity, v]) => (
                <li key={entity}>
                  {entity}: {[v.missing && `${v.missing.length} missing`, v.duplicates && `${v.duplicates.length} copied twice`, v.extra && `${v.extra.length} extra`, v.changed && `${v.changed.length} with different values`, v.wrong_period && `${v.wrong_period.length} in the wrong period`].filter(Boolean).join(', ')}
                </li>
              ))}
              {report.period?.changed && <li>Period: {report.period.changed.join(', ')} differ</li>}
              {report.relationships?.unresolved_categories && <li>Transactions whose category no longer matches a budget line</li>}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {period.copy_status !== 'verified' && (
              <button type="button" className={btnPrimary} disabled={busy} onClick={continueCopy}>Continue copy</button>
            )}
            {!confirmDiscard ? (
              <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard revision…</button>
            ) : (
              <>
                <button type="button" className={`${btn} border-rose-700 bg-rose-700 text-white`} disabled={busy} onClick={discard}>Discard this revision</button>
                <button type="button" className={btnGhost} onClick={() => setConfirmDiscard(false)}>Cancel</button>
              </>
            )}
          </div>
          {isOpenRevision(period) && period.copy_status === 'verified' && (
            <p className="mt-2 text-xs text-stone-500">
              Edit it in Monthly Data, or import a corrected workbook into it (Import). Then finalize it as usual and publish it
              below as the replacement.
            </p>
          )}
        </div>
      )}

      {isSuperseded(period) && (
        <p className="mt-4 text-sm text-stone-600" data-testid="superseded-note">
          Replaced by {versionLabel(byId.get(period.superseded_by) || { label: period.label })}. Kept for reference; not shown to clients.
        </p>
      )}

      {canRevise && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Correct this report</p>
          <p className="mt-1 text-sm text-stone-600">
            Creates a draft copy to edit or re-import. {period.published ? 'Clients keep seeing this version until the revision is published.' : 'This version stays as it is.'}
          </p>
          <textarea
            className="mt-2 w-full rounded-md border border-stone-200 bg-white p-2 text-sm"
            rows={2}
            placeholder={`Reason for the revision (required, at least ${MIN_REASON} characters)`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className={`${btnPrimary} mt-2`} disabled={busy || reason.trim().length < MIN_REASON} onClick={create}>
            {busy ? 'Copying…' : 'Create revision'}
          </button>
        </div>
      )}

      {message && <p className={`mt-3 text-sm ${message.ok ? 'text-emerald-700' : 'text-rose-700'}`} role="status">{message.text}</p>}
    </div>
  );
}
