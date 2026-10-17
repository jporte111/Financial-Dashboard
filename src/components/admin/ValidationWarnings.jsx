import React, { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { periodTransition } from '@/lib/periodTransition';
import { CauseList } from './PublicationReview';
import { groupByCause, explain } from '../../../base44/shared/checklistCore.ts';
import { plainLabel } from '../../../base44/shared/periodVersions.ts';
import { detailWarnings } from '../../../base44/shared/detailReport.ts';

// Validation Warnings tab: every non-blocking warning for the selected report,
// grouped by root cause, in one place. Warnings never block finalizing or
// publishing and need no acknowledgement or written reason. Structural
// blockers are not listed here -- they belong to Review & Publish.
//
// An unpublished report uses the server's read-only check (which also
// compares it with the previous month). A published report is never
// re-judged, so it shows the warnings recorded when its workbook was imported.
export default function ValidationWarnings({ period, onOpenReview }) {
  const [check, setCheck] = useState(undefined); // undefined: loading; null: the check could not run
  const periodId = period?.id;
  const published = !!period?.published;

  useEffect(() => {
    setCheck(undefined);
    if (!periodId || published) return undefined;
    let cancelled = false;
    periodTransition('check', periodId)
      .then((r) => !cancelled && setCheck(r?.ok ? r : null))
      .catch(() => !cancelled && setCheck(null));
    return () => { cancelled = true; };
  }, [periodId, published, period?.status, period?.updated_date]);

  // Warnings recorded at import (published reports), grouped like the server's.
  const recorded = useMemo(() => {
    const list = Array.isArray(period?.bva_validation_warnings) ? period.bva_validation_warnings : [];
    // plus the transaction-detail comparison stored when the report was finalized
    const detail = period?.detail_import?.status === 'attached' ? detailWarnings(period.detail_import.reconciliation) : [];
    return groupByCause(
      [...list, ...detail].filter((w) => !w.blocksFinalize).map((w) => {
        const e = explain(w.code);
        return { code: w.code, title: e.title, problem: w.message || e.title, action: e.action, where: e.where, kind: 'warning' };
      })
    );
  }, [period?.bva_validation_warnings, period?.detail_import]);

  if (!period) {
    return <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm text-stone-500">No report selected.</div>;
  }

  const review = published ? null : check?.review || null;
  const causes = published ? recorded : (review?.causes || []).filter((c) => c.bucket === 'warnings');
  const flat = !published && review && !Array.isArray(review.causes) ? review.warnings || [] : [];
  const count = causes.length + flat.length;
  const findings = causes.reduce((n, c) => n + (c.members?.length || 1), 0) + flat.length;
  const blockerCount = review ? (review.causes ? review.causes.filter((c) => c.bucket === 'blockers').length : (review.blockers || []).length) : 0;
  const loading = !published && check === undefined;

  return (
    <div className="space-y-5" data-testid="validation-warnings">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <p className="font-display text-lg">Validation Warnings — {plainLabel(period)}</p>
        <p className="mt-2 flex items-start gap-2 text-sm text-stone-600" data-testid="warnings-never-block">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-stone-400" />
          <span>
            Warnings never block finalizing or publishing, and need no acknowledgement or written reason. The dashboard shows
            what the workbook contains; a missing value is shown as —, never $0.00.
          </span>
        </p>
        {published && <p className="mt-2 text-xs text-stone-500">This report is published and is not re-checked. These are the warnings recorded when its workbook was imported.</p>}
        {!published && review && check?.cross_period?.previous?.label && (
          <p className="mt-2 text-xs text-stone-500">Includes the checks against {check.cross_period.previous.label}.</p>
        )}
        {blockerCount > 0 && (
          <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" data-testid="blockers-elsewhere">
            This report also has {blockerCount} problem{blockerCount === 1 ? '' : 's'} that must be fixed before it can be finalized or published.
            They are listed in Review &amp; Publish, not here.{' '}
            {onOpenReview && <button type="button" onClick={onOpenReview} className="font-medium underline underline-offset-4">Open Review &amp; Publish</button>}
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white p-6 text-sm">
        {loading ? (
          <p className="text-stone-400">Checking the report…</p>
        ) : !published && check === null ? (
          <p className="text-stone-600">The check could not run just now. Reload the page to try again.</p>
        ) : count === 0 ? (
          <p className="text-stone-600" data-testid="no-warnings">No warnings for this report.</p>
        ) : (
          <>
            <p className="text-xs uppercase tracking-[0.12em] text-stone-500">
              {count} cause{count === 1 ? '' : 's'}{findings !== count ? ` · ${findings} findings` : ''} — grouped by root cause
            </p>
            {causes.length > 0 && <CauseList causes={causes} bucket="warnings" />}
            {flat.length > 0 && (
              <ul className="mt-1 divide-y divide-stone-200/70">
                {flat.map((e, i) => (
                  <li key={`${e.code}-${i}`} className="py-2">
                    <p className="font-medium text-stone-800">{e.title}</p>
                    {e.problem && e.problem !== e.title && <p className="text-stone-600">{e.problem}</p>}
                    {e.action && <p className="mt-0.5 text-stone-700"><span className="font-medium">What to do:</span> {e.action}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {review?.notes?.length > 0 && (
          <details className="mt-4 text-xs text-stone-500">
            <summary className="cursor-pointer">{review.notes.length} note{review.notes.length === 1 ? '' : 's'} (for information)</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">{review.notes.map((n, i) => <li key={`${n.code}-${i}`}>{n.problem}</li>)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}
