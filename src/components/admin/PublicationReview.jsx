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
  ['blockers', 'Blockers — must be fixed', 'border-rose-200 bg-rose-50', 'Cannot be overridden. Fix the data or the workbook.'],
  ['needsReview', 'Needs review', 'border-amber-200 bg-amber-50', 'A written reason, or a checklist item to confirm.'],
  ['warnings', 'Warnings', 'border-stone-200 bg-stone-50', 'Worth a look; these never block.'],
];

// Blockers, needs review, warnings and completed checks.
export function ReviewGroups({ review, comparedWith }) {
  if (!review) return null;
  return (
    <div className="space-y-4" data-testid="review-groups">
      {GROUPS.map(([key, title, style, help]) => (
        <div key={key} className={`rounded-xl border p-4 text-sm ${style}`} data-testid={`review-${key}`}>
          <p className="text-xs uppercase tracking-[0.12em] text-stone-600">
            {title} ({review[key].length}){key === 'warnings' && comparedWith ? ` — compared with ${comparedWith}` : ''}
          </p>
          {review[key].length ? (
            <>
              <p className="mt-1 text-xs text-stone-500">{help}</p>
              <ul className="mt-1 divide-y divide-stone-200/70">{review[key].map((e, i) => <Entry key={`${e.code}-${i}`} e={e} />)}</ul>
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
      ))}
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
