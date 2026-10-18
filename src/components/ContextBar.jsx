import React from 'react';
import { periodState, clientVisibility, TONE_CLASS } from '@/lib/periodState';

// Phase 9a: the month and state every Admin page is working on, and whether
// clients see it. Sticks to the top of the window so it is always in view.
export function StateChip({ period, className = '' }) {
  const s = periodState(period);
  if (!s) return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[s.tone]} ${className}`} data-testid="state-chip" data-state={s.key}>
      <span className="sr-only">Status: </span>
      {s.label}
    </span>
  );
}

export default function ContextBar({ periods, period, onSwitch }) {
  if (!period) return null;
  const s = periodState(period);
  const { visible, monthCurrent, clientDefault } = clientVisibility(periods, period);
  // Where to go to see what clients see: this month's published version, or
  // (if this month has none) the month the client page opens on.
  const target = !visible ? monthCurrent || clientDefault : null;
  let message;
  if (visible) {
    message = clientDefault?.id === period.id
      ? 'Clients see this report — the client page opens on it.'
      : `Clients see this report when they choose ${period.label} on the client page.`;
  } else if (s.key === 'replaced' || s.key === 'discarded') {
    message = `${s.key === 'replaced' ? 'Replaced by a newer version' : 'Discarded'} — kept for reference. Clients don't see it.`;
  } else if (monthCurrent) {
    message = `Clients don't see this version. For ${period.label} they see the published version${periodState(monthCurrent).secondary ? ` (${periodState(monthCurrent).secondary.toLowerCase()})` : ''}.`;
  } else {
    message = `Clients don't see this version. ${period.label} isn't on the client page yet${clientDefault ? ` — the client page opens on ${clientDefault.label}` : ''}.`;
  }
  return (
    <section
      aria-label="Report you are working on"
      className={`sticky top-0 z-30 border-b backdrop-blur ${visible ? 'border-stone-200 bg-white/95' : 'border-amber-300 bg-amber-50/95'}`}
      data-testid="context-bar"
      data-visible={visible ? 'yes' : 'no'}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-[0.14em] text-stone-500">Working on</span>
          <span className="font-display text-lg leading-tight" data-testid="context-month">{period.label}</span>
          <StateChip period={period} />
          {s.secondary && <span className="text-xs text-stone-500" data-testid="context-secondary">{s.secondary}</span>}
        </div>
        <p className={`min-w-0 flex-1 text-sm ${visible ? 'text-stone-600' : 'font-medium text-amber-900'}`} data-testid="context-visibility">
          {message}
        </p>
        {target && onSwitch && (
          <button
            type="button"
            onClick={() => onSwitch(target.id)}
            className="rounded-full border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            data-testid="context-switch"
          >
            Switch to what clients see ({target.label})
          </button>
        )}
      </div>
    </section>
  );
}
