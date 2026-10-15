import React from 'react';
import { PUBLISH_CHECKLIST } from '../../../base44/shared/publishGate.ts';
import { itemMessage } from '../../../base44/shared/checklistCore.ts';

// Review & Publish (Phase 6c): the checklist with who/when, and everything the
// server found, in four plain-language groups. Read-only display; actions go
// through the periodTransition backend (confirm_checklist / unconfirm_checklist).

const day = (at) => (at ? String(at).slice(0, 10) : '');
const btn = 'rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50';

const STATE_STYLE = {
  confirmed: ['Confirmed', 'bg-emerald-50 text-emerald-800 border-emerald-200'],
  stale: ['Needs confirming again', 'bg-amber-50 text-amber-800 border-amber-200'],
  unconfirmed: ['Not confirmed', 'bg-stone-50 text-stone-700 border-stone-200'],
  blocked: ['Blocked', 'bg-rose-50 text-rose-800 border-rose-200'],
};

// The checklist. `items` come from the server's check (unpublished periods);
// a published period shows what was recorded, read-only.
export function ChecklistItems({ items, period, readOnly, busy, onConfirm, onUnconfirm }) {
  if (readOnly || !items) {
    const conf = period?.checklist_confirmations || {};
    const ticked = period?.checklist || {};
    return (
      <ul className="space-y-2 text-sm" data-testid="checklist-readonly">
        {PUBLISH_CHECKLIST.map(([k, label]) => {
          const c = conf[k];
          const note = c?.by ? `confirmed by ${c.by} on ${day(c.at)}` : ticked[k] ? 'ticked (before who/when was recorded)' : 'not recorded';
          return <li key={k} className="flex justify-between gap-3"><span>{label}</span><span className="text-stone-500">{note}</span></li>;
        })}
      </ul>
    );
  }
  return (
    <ul className="space-y-3 text-sm" data-testid="checklist-items">
      {items.map((s) => {
        const [badge, style] = STATE_STYLE[s.state] || STATE_STYLE.unconfirmed;
        return (
          <li key={s.key} className="rounded-xl border border-stone-200 p-3" data-testid={`checklist-${s.key}`} data-state={s.state}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{s.label}</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${style}`}>{badge}</span>
            </div>
            <p className="mt-1 text-stone-600">{itemMessage(s)}</p>
            <div className="mt-2 flex gap-2">
              {s.state !== 'confirmed' && (
                <button type="button" className={`${btn} border-stone-300 bg-white text-stone-800 hover:bg-stone-100`} disabled={busy || s.state === 'blocked'} onClick={() => onConfirm(s.key)}>
                  {s.state === 'stale' ? 'Confirm again' : 'Confirm'}
                </button>
              )}
              {(s.state === 'confirmed' || s.state === 'stale') && (
                <button type="button" className={`${btn} border-stone-200 bg-white text-stone-500 hover:bg-stone-50`} disabled={busy} onClick={() => onUnconfirm(s.key)}>
                  Withdraw confirmation
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Entry({ e }) {
  return (
    <li className="py-2">
      <p className="font-medium text-stone-800">{e.title}</p>
      {e.problem && e.problem !== e.title && <p className="text-stone-600">{e.problem}</p>}
      {e.action && <p className="mt-0.5 text-stone-700"><span className="font-medium">What to do:</span> {e.action}{e.where ? <span className="text-stone-500"> ({e.where})</span> : null}</p>}
    </li>
  );
}

const GROUPS = [
  ['blockers', 'Blockers — must be fixed', 'border-rose-200 bg-rose-50', 'The workbook cannot be shown faithfully until these are fixed.'],
  ['needsReview', 'Optional review checklist', 'border-stone-200 bg-white', 'Optional review aids; they never block finalizing or publishing.'],
  ['warnings', 'Warnings', 'border-stone-200 bg-stone-50', 'Missing and unusual values, shown as the workbook has them. These never block and need no written reason.'],
];

// One root cause, read once: what it is, what to do, and each finding in it.
// A structural member (it blocks) is marked; everything else is a warning.
export function CauseCard({ cause }) {
  const many = cause.members.length > 1;
  return (
    <li className="py-3" data-testid={`cause-${cause.key}`} data-bucket={cause.bucket}>
      <p className="font-medium text-stone-800">
        {cause.title}
        {many ? <span className="font-normal text-stone-500"> · {cause.members.length} findings</span> : null}
      </p>
      {cause.explanation && <p className="mt-0.5 text-stone-600">{cause.explanation}</p>}
      {!many && cause.members[0]?.problem && cause.members[0].problem !== cause.title && <p className="text-stone-600">{cause.members[0].problem}</p>}
      {cause.action && <p className="mt-0.5 text-stone-700"><span className="font-medium">What to do:</span> {cause.action}{cause.where ? <span className="text-stone-500"> ({cause.where})</span> : null}</p>}
      {many && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-stone-600" data-testid={`cause-members-${cause.key}`}>
          {cause.members.map((m, i) => (
            <li key={`${m.code}-${i}`}>
              {m.problem || m.title}
              {m.kind === 'blocker' ? <span className="text-rose-700"> — must be fixed: the workbook cannot be shown faithfully until it is</span> : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// The causes in one bucket, plus (needs review) the checklist entries.
export function CauseList({ causes, bucket, extra = [] }) {
  const list = (causes || []).filter((c) => c.bucket === bucket);
  if (!list.length && !extra.length) return null;
  return (
    <ul className="mt-1 divide-y divide-stone-200/70">
      {list.map((c) => <CauseCard key={c.key} cause={c} />)}
      {extra.map((e, i) => <Entry key={`${e.code}-${i}`} e={e} />)}
    </ul>
  );
}

// Blockers, needs review, warnings and completed checks. With `review.causes`
// each bucket lists root causes (several findings read once); without it (an
// older server), every finding is listed on its own.
export function ReviewGroups({ review, comparedWith }) {
  if (!review) return null;
  const causes = Array.isArray(review.causes) ? review.causes : null;
  return (
    <div className="space-y-4" data-testid="review-groups">
      {GROUPS.map(([key, title, style, help]) => {
        const checklist = key === 'needsReview' ? review.needsReview.filter((e) => e.kind === 'checklist') : [];
        const byCause = causes ? causes.filter((c) => c.bucket === key) : null;
        const count = byCause ? byCause.length + checklist.length : review[key].length;
        const findings = byCause ? byCause.reduce((n, c) => n + c.members.length, 0) + checklist.length : count;
        return (
          <div key={key} className={`rounded-xl border p-4 text-sm ${style}`} data-testid={`review-${key}`}>
            <p className="text-xs uppercase tracking-[0.12em] text-stone-600">
              {title} ({count}){findings !== count ? ` · ${findings} findings` : ''}{key === 'warnings' && comparedWith ? ` — compared with ${comparedWith}` : ''}
            </p>
            {count ? (
              <>
                <p className="mt-1 text-xs text-stone-500">{help}</p>
                {byCause
                  ? <CauseList causes={byCause} bucket={key} extra={checklist} />
                  : <ul className="mt-1 divide-y divide-stone-200/70">{review[key].map((e, i) => <Entry key={`${e.code}-${i}`} e={e} />)}</ul>}
              </>
            ) : (
              <p className="mt-1 text-stone-600">None.</p>
            )}
            {key === 'warnings' && review.notes?.length > 0 && (
              <details className="mt-2 text-xs text-stone-500">
                <summary className="cursor-pointer">{review.notes.length} note(s)</summary>
                <ul className="mt-1 list-disc space-y-1 pl-5">{review.notes.map((n, i) => <li key={`${n.code}-${i}`}>{n.problem}</li>)}</ul>
              </details>
            )}
          </div>
        );
      })}
      <details className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm" data-testid="review-completed">
        <summary className="cursor-pointer text-xs uppercase tracking-[0.12em] text-emerald-800">Completed ({review.completed.length})</summary>
        <ul className="mt-2 space-y-1">
          {review.completed.map((e, i) => (
            <li key={`${e.code}-${i}`}><span className="font-medium">✓ {e.title}</span>{e.problem ? <span className="text-stone-600"> — {e.problem}</span> : null}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
