import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { periodTransition } from '@/lib/periodTransition';
import { ChecklistItems, ReviewGroups } from './PublicationReview';
import { isRevision, isSuperseded, publishExpectation } from '../../../base44/shared/periodVersions.ts';
import { periodState, clientVisibility, reportName, shortDate } from '@/lib/periodState';
import { StateChip } from '@/components/ContextBar';
import ConfirmDialog from '@/components/ConfirmDialog';

// The button component is untyped (every use is a type error); these uses go
// through an untyped alias so they add none.
const Btn = /** @type {any} */ (Button);

// Review stages an admin may set directly. "Final" is deliberately absent:
// a period becomes final only through validated finalization (BVA Import),
// and is published only through the server-side publication gate.
export const STAGES = [
  ['draft', 'Draft'],
  ['transactions_posted', 'Transactions Posted'],
  ['categories_reviewed', 'Categories Reviewed'],
  ['classes_reviewed', 'Classes Reviewed'],
  ['reports_reviewed', 'Reports Reviewed'],
];

// Phase 9a: what publishing this version does, in plain words, for the
// confirmation dialog. `periods`: every version (to name what it replaces).
export function publishSummary(period, periods = []) {
  const { monthCurrent, clientDefault } = clientVisibility(periods, period);
  const replaced = isRevision(period) ? (periods.find((p) => p.id === period.supersedes) || monthCurrent) : null;
  const lines = [];
  if (replaced) {
    const when = shortDate(replaced.publication_date);
    lines.push(`Clients will see this corrected ${period.label} report instead of the one${when ? ` published ${when}` : ' they see now'}. That version is kept in history, not deleted.`);
  } else {
    lines.push(`Clients will see ${period.label} on the client page.`);
  }
  const newer = clientDefault && clientDefault.id !== period.id && clientDefault.id !== replaced?.id
    && (clientDefault.year > period.year || (clientDefault.year === period.year && clientDefault.month > period.month));
  if (newer) lines.push(`The client page still opens on ${clientDefault.label}; clients choose ${period.label} from the month list.`);
  return lines;
}

export default function PublishPanel({ period, periods = [], reload, onShowWarnings = null }) {
  const [check, setCheck] = useState(null); // server-side evaluation, read-only
  const [busy, setBusy] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenLabel, setReopenLabel] = useState('');
  const [confirmPublish, setConfirmPublish] = useState(false); // the publish dialog
  const { toast } = useToast();

  const isPublished = !!period?.published;
  const isFinal = period?.status === 'final' && period?.bva_import_status === 'final' && !!period?.finalized_at;
  const validatedImport = period?.bva_import_status === 'final' || period?.bva_import_status === 'draft';
  const periodId = period?.id;
  const revision = isRevision(period);
  const superseded = isSuperseded(period);

  useEffect(() => {
    setConfirmReopen(false);
    setReopenReason('');
    setReopenLabel('');
    setConfirmPublish(false);
    if (!periodId) return;
    let cancelled = false;
    periodTransition('check', periodId).then((r) => !cancelled && setCheck(r.ok ? r : null));
    return () => { cancelled = true; };
  }, [periodId, period?.checklist, period?.checklist_confirmations, period?.status, period?.published]);

  if (!period) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm text-stone-500">
        No reporting period selected. Import a BVA workbook or create a period first.
      </div>
    );
  }

  const run = async (fn, okTitle) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) toast({ title: okTitle });
      else toast({ title: 'Refused by the server — nothing was changed', description: (res.blockers[0] && res.blockers[0].message) || res.error });
      reload();
      return res;
    } finally {
      setBusy(false);
    }
  };

  // Checklist confirmations are recorded by the server (who, when, and what the
  // item covered); a published period's checklist is read-only.
  const confirmItem = (item) => run(() => periodTransition('confirm_checklist', period.id, { item }), 'Checklist item confirmed');
  const unconfirmItem = (item) => run(() => periodTransition('unconfirm_checklist', period.id, { item }), 'Confirmation withdrawn');

  const publishBlockers = check?.publish?.blockers || [];
  // The server's review in four groups (blockers / needs review / warnings /
  // completed); without it (the check failed) the raw blockers are listed.
  const review = check?.review || null;
  const comparedWith = check?.cross_period?.previous?.label || null;
  const name = reportName(period);
  const publish = async () => {
    setConfirmPublish(false);
    // B1: the server publishes only the month and version confirmed here.
    const res = await run(() => periodTransition('publish', period.id, { expect: publishExpectation(period) }), `${name} published to the client page`);
    if (res.ok && res.supersede_pending) toast({ title: 'Published — but marking the replaced version superseded did not finish', description: 'Finish it in History & recovery. Clients already see the correction.' });
    if (res.ok && res.conflict) toast({ title: 'Another version of this month is also published', description: 'See History & recovery and resolve it.' });
  };
  // Is the report ready? Only structural blockers stop it; warnings never do.
  const blockerCount = review ? (Array.isArray(review.causes) ? review.causes.filter((c) => c.bucket === 'blockers').length : review.blockers.length) : publishBlockers.length;
  const readiness = isPublished || superseded || !check
    ? null
    : blockerCount
      ? { ok: false, text: `${blockerCount} problem${blockerCount === 1 ? '' : 's'} must be fixed before this report can be ${isFinal ? 'published' : 'finalized'} (listed below).` }
      : { ok: true, text: isFinal ? 'Ready to publish — nothing blocks it.' : 'Ready to finalize in BVA Import — nothing blocks it.' };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Review & Publication — {period.label}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-stone-600">
        <StateChip period={period} />
        {periodState(period).secondary && <span className="text-xs text-stone-500">{periodState(period).secondary}</span>}
      </p>
      {readiness && (
        <p className={`mt-3 rounded-xl border p-3 text-sm ${readiness.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-800'}`} data-testid="readiness" data-ready={readiness.ok ? 'yes' : 'no'}>
          {readiness.text}
        </p>
      )}

      <div className="mt-5">
        <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Review Stage</p>
        <Select
          value={STAGES.some(([k]) => k === period.status) ? period.status : undefined}
          onValueChange={(stage) => run(() => periodTransition('set_stage', period.id, { stage }), `Stage set to ${stage.replace(/_/g, ' ')}`)}
          disabled={busy || isPublished || isFinal}
        >
          <SelectTrigger className="mt-2 w-[260px]"><SelectValue placeholder={isFinal || isPublished ? 'Final' : 'Select stage'} /></SelectTrigger>
          <SelectContent>{STAGES.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <p className="mt-1 text-xs text-stone-500">A period becomes Final only by validated finalization in BVA Import.</p>
      </div>

      <div className="mt-6 space-y-3">
        <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Review checklist (optional)</p>
        <p className="text-xs text-stone-500">Optional review aids: who confirmed each item, and when, is recorded. They never block finalizing or publishing.</p>
        <ChecklistItems
          items={check?.checklist?.items || null}
          period={period}
          readOnly={isPublished || superseded}
          busy={busy}
          onConfirm={confirmItem}
          onUnconfirm={unconfirmItem}
        />
      </div>

      {!isPublished && review && (
        <div className="mt-6">
          <ReviewGroups review={review} comparedWith={comparedWith} onShowWarnings={onShowWarnings} />
        </div>
      )}

      {!isPublished && !review && publishBlockers.length > 0 && (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="mb-1 text-xs uppercase tracking-[0.12em] text-amber-800">Publication blocked until resolved</p>
          <ul className="list-disc space-y-1 pl-5 text-stone-700">
            {publishBlockers.map((b) => <li key={b.code}>{b.message}</li>)}
          </ul>
        </div>
      )}

      {revision && !isPublished && isFinal && (
        <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-stone-700" data-testid="publish-correction-note">
          Publishing this correction replaces the {period.label} report clients see now, in one step. The current version is kept in history (not deleted).
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!isPublished && !superseded && (
          <Btn
            onClick={() => setConfirmPublish(true)}
            disabled={busy || !isFinal || publishBlockers.length > 0}
            className="rounded-full"
            data-testid="publish-open"
          >
            Publish {name} to client page…
          </Btn>
        )}
        {isFinal && !isPublished && !superseded && !confirmReopen && (
          <Btn variant="outline" className="rounded-full" disabled={busy} onClick={() => setConfirmReopen(true)}>
            Reopen {name} to draft
          </Btn>
        )}
      </div>
      {!isPublished && !superseded && (
        <p className="mt-2 text-xs text-stone-500">
          This shows the report to clients on the client page. It is not the Base44 Builder Publish, which deploys app changes.
        </p>
      )}

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish ${name} to the client page?`}
        confirmLabel={`Publish ${name}`}
        onConfirm={publish}
        testId="publish-dialog"
      >
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
          <span className="font-display text-base text-stone-900">{period.label}</span>
          <StateChip period={period} />
          {period.finalized_at && <span className="text-xs text-stone-500">finalized {shortDate(String(period.finalized_at).slice(0, 10))}</span>}
        </div>
        {publishSummary(period, periods).map((t) => <p key={t}>{t}</p>)}
        <p className="text-xs text-stone-500">Warnings never block publishing. This is not the Base44 Builder Publish.</p>
      </ConfirmDialog>

      {isPublished && !confirmReopen && (
        <details className="mt-8 rounded-xl border border-stone-200 p-4 text-sm text-stone-600">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.12em] text-stone-500">Exceptional administrative action</summary>
          <p className="mt-3">
            Published reports are preserved as the client&apos;s historical record. Reopening one removes it from the client
            dashboard and is not the way to correct a report. Use it only in exceptional circumstances.
          </p>
          <Btn variant="outline" className="mt-3 rounded-full" disabled={busy} onClick={() => setConfirmReopen(true)}>
            Remove from client dashboard and reopen…
          </Btn>
        </details>
      )}

      {confirmReopen && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-stone-700">
          <p>
            {isPublished ? 'This removes the report from the client dashboard and ' : 'This '}returns the period to Draft.
            {isPublished && period.bva_import_status !== 'final' && (
              <> This period was published before validated BVA imports existed; it can be published again only after a
                validated BVA import and finalization.</>
            )}
            {' '}The reason is recorded in the period&apos;s audit log.
          </p>
          <textarea
            className="mt-3 w-full rounded-md border border-stone-200 bg-white p-2 text-sm"
            rows={2}
            placeholder="Reason (required, at least 10 characters)"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
          />
          {isPublished && (
            <input
              className="mt-2 w-full rounded-md border border-stone-200 bg-white p-2 text-sm"
              placeholder={`Type "${period.label}" to confirm`}
              value={reopenLabel}
              onChange={(e) => setReopenLabel(e.target.value)}
            />
          )}
          <div className="mt-3 flex gap-3">
            <Btn
              variant="destructive"
              className="rounded-full"
              disabled={busy || reopenReason.trim().length < 10 || (isPublished && reopenLabel !== period.label)}
              onClick={async () => {
                const res = await run(
                  () => periodTransition('reopen', period.id, { reason: reopenReason, confirm: reopenLabel }),
                  'Reporting period reopened'
                );
                if (res.ok) setConfirmReopen(false);
              }}
            >
              Reopen {name}
            </Btn>
            <Btn variant="outline" className="rounded-full" onClick={() => setConfirmReopen(false)}>Cancel</Btn>
          </div>
        </div>
      )}

      {!isPublished && !isFinal && (
        <p className="mt-3 text-xs text-stone-500">
          {validatedImport ? 'Finalize the validated import in BVA Import before publishing.' : 'This period has no validated BVA import; import the workbook first.'}
        </p>
      )}
      {isPublished && (
        <p className="mt-3 text-xs text-emerald-700">
          Published to the client page{period.publication_date ? ` on ${period.publication_date}` : ''}{period.reviewed_by ? ` · reviewed by ${period.reviewed_by}` : ''} · read-only
        </p>
      )}
    </div>
  );
}
