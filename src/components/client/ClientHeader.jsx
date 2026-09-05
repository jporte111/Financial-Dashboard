import React from 'react';
import { Link } from 'react-router-dom';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Public client-view header: brand crest, statement title, published-period
// pill switcher and a discreet firm sign-in link. Sticks to the top on both
// desktop and mobile so the period selector is always reachable.
export default function ClientHeader({ periods, activePeriodId, onSelectPeriod }) {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-300 bg-stone-50/95 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-orange-800/25 bg-orange-100 font-display text-xl leading-none text-orange-800">
              N
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-lg leading-snug tracking-wide">Namaste Financial Management</p>
              <p className="text-[11px] uppercase tracking-[0.16em] text-stone-500">Client Financial Statement</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="hidden items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-500 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-700" />
              Client Access
            </span>
            <Select value={activePeriodId || undefined} onValueChange={onSelectPeriod}>
              <SelectTrigger className="h-9 min-w-[10rem] rounded-full border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 shadow-none hover:bg-white">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                {(periods || []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link to="/login" className="hidden text-xs text-stone-400 underline-offset-4 hover:text-stone-600 hover:underline sm:inline">
              Firm sign-in
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}