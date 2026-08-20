import React from 'react';
import { computeLine, fmtCurrency, fmtPct, GROUP_LABELS } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import { ChevronRight } from 'lucide-react';

export default function CategoryTable({ lines, monthsElapsed, onSelect }) {
  if (!lines || !lines.length)
    return <p className="rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">No categories for this period.</p>;

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      {lines.map((l, i) => {
        const c = computeLine(l, monthsElapsed);
        const clickable = l.drilldown_enabled !== false;
        return (
          <div
            key={l.id}
            onClick={() => clickable && onSelect(l)}
            className={`grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-12 md:items-center ${i ? 'border-t border-stone-100' : ''} ${
              clickable ? 'cursor-pointer transition hover:bg-stone-50' : ''
            }`}
          >
            <div className="md:col-span-4">
              <div className="flex items-center gap-2">
                <p className="font-medium">{l.category}</p>
                {clickable && <ChevronRight className="h-4 w-4 text-stone-300" />}
              </div>
              <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-stone-400">
                {GROUP_LABELS[l.budget_group] || ''}{l.qb_code ? ` · ${l.qb_code}` : ''}
              </p>
            </div>
            <div className="md:col-span-4">
              <p className="text-sm tabular-nums">
                {fmtCurrency(c.ytd)} <span className="text-stone-400">/ {fmtCurrency(c.annual)}</span>
              </p>
              <div className="mt-2">
                <BudgetBar pct={c.pctUsed} status={c.status} />
              </div>
              <p className="mt-1.5 text-xs text-stone-500">
                {fmtPct(c.pctUsed)} used · {fmtCurrency(c.remaining)} remaining
              </p>
            </div>
            <div className="md:col-span-2 text-sm">
              <p className="tabular-nums">{fmtCurrency(Math.abs(c.variance))}</p>
              <p className="text-xs text-stone-500">{c.variance >= 0 ? 'under pace' : 'over pace'}</p>
            </div>
            <div className="md:col-span-2 md:text-right">
              <StatusPill status={c.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}