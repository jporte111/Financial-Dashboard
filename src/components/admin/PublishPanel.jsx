import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { periodTransition } from '@/lib/periodTransition';
import { ChecklistItems, ReviewGroups } from './PublicationReview';
import { versionLabel, isRevision, isSuperseded } from '../../../base44/shared/periodVersions.ts';

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

export default function PublishPanel({ period, reload }) {
  const [check, setCheck] = useState(null); // server-side evaluation, read-only
  const [busy, setBusy] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenLabel, setReopenLabel] = useState('');
  const [replaceLabel, setReplaceLabel] = useState(''); // typed confirmation for publishing a revision
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
    setReplaceLabel('');
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
  const statusLabel = isPublished ? 'Published' : isFinal ? 'Final (not yet published)' : 'Draft';

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Review & Publication — {versionLabel(period)}</p>
      <p className="mt-1 text-sm text-stone-600">Status: <span className="font-medium">{statusLabel}</span></p>

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
        <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Pre-Publication Checklist</p>
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
          <ReviewGroups review={review} comparedWith={comparedWith} />
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
        <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700">
          Publishing this revision replaces the version clients see now, in one step. The replaced version is kept (marked
          superseded), not deleted.
          <input
            className="mt-2 w-full rounded-md border border-stone-200 bg-white p-2 text-sm"
            placeholder={`Type "${period.label}" to confirm the replacement`}
            value={replaceLabel}
            onChange={(e) => setReplaceLabel(e.target.value)}
          />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!isPublished && !superseded && (
          <Button
            onClick={async () => {
              const res = await run(() => periodTransition('publish', period.id), revision ? 'Published as the replacement' : 'Published to Sonia');
              if (res.ok && res.supersede_pending) toast({ title: 'Published — but marking the replaced version superseded did not finish', description: 'Finish it in Versions above. Clients already see this revision.' });
              if (res.ok && res.conflict) toast({ title: 'Another version of this month is also published', description: 'See Versions above and resolve it.' });
            }}
            disabled={busy || !isFinal || publishBlockers.length > 0 || (revision && replaceLabel !== period.label)}
            className="rounded-full"
          >
            {revision ? 'Publish replacement' : 'Publish to Sonia'}
          </Button>
        )}
        {isFinal && !isPublished && !superseded && !confirmReopen && (
          <Button variant="outline" className="rounded-full" disabled={busy} onClick={() => setConfirmReopen(true)}>
            Reopen to Draft
          </Button>
        )}
      </div>

      {isPublished && !confirmReopen && (
        <details className="mt-8 rounded-xl border border-stone-200 p-4 text-sm text-stone-600">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.12em] text-stone-500">Exceptional administrative action</summary>
          <p className="mt-3">
            Published reports are preserved as the client&apos;s historical record. Reopening one removes it from the client
            dashboard and is not the way to correct a report. Use it only in exceptional circumstances.
          </p>
          <Button variant="outline" className="mt-3 rounded-full" disabled={busy} onClick={() => setConfirmReopen(true)}>
            Remove from client dashboard and reopen…
          </Button>
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
            <Button
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
              Confirm reopen
            </Button>
            <Button variant="outline" className="rounded-full" onClick={() => setConfirmReopen(false)}>Cancel</Button>
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
          Published{period.publication_date ? ` on ${period.publication_date}` : ''}{period.reviewed_by ? ` · reviewed by ${period.reviewed_by}` : ''} · read-only
        </p>
      )}
    </div>
  );
}
