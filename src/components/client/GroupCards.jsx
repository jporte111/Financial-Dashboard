import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtCurrency, fmtPct, pct100 } from '@/lib/finance';
import CategoryTable from '@/components/CategoryTable';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import Variance from '@/components/Variance';

function GroupCard({ group, pacePct, onSelect }) {
  const [open, setOpen] = useState(true);
  const c = group.ytd;
  // A group the workbook reports as one line: that line IS the card, so its
  // row would only repeat the card's figures. The card opens its transactions.
  const single = group.lines.length === 1 ? group.lines[0] : null;
  const canDrill = single && single.drilldownEnabled !== false && onSelect;
  const many = group.lines.length > 1;
  return (
    <div className="rounded-2xl border border-stone-300 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]" data-testid={`group-card-${group.key}`}>
      <div className="flex w-full items-start justify-between gap-4 p-5 sm:p-6">
        <div className="min-w-0">
          <p className="font-display text-xl tracking-tight">{group.label}</p>
          <p className="mt-1 text-sm tabular-nums text-stone-500">
            {fmtCurrency(c.actual)} <span className="text-stone-400">of {fmtCurrency(c.annual)} annual budget</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusPill status={c.status} />
          {many && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? `Hide ${group.label} categories` : `Show ${group.label} categories`} className="rounded-full p-1 text-stone-400 hover:bg-stone-100">
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <BudgetBar pct={pct100(c.percentUsed)} status={c.status} />
        <p className="mt-2 text-sm tabular-nums">
          <Variance amount={c.varianceToPace} cents={false} />{' '}
          <span className="text-stone-500">
            · {fmtPct(pct100(c.percentUsed))} used, {fmtPct(pct100(pacePct))} expected by now
          </span>
        </p>
        {single && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-stone-500">This month {single.monthActual == null ? '—' : fmtCurrency(single.monthActual)}</span>
            {canDrill && (
              <button
                type="button"
                onClick={() => onSelect(single)}
                className="inline-flex items-center gap-1 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 transition hover:bg-stone-100"
                data-testid={`view-transactions-${group.key}`}
              >
                View transactions <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {open && many && (
        <div className="border-t border-stone-100">
          <CategoryTable rows={group.lines} monthMode={false} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

// Group Budget vs Actuals — Fixed / Variable / Discretionary cards, each with
// its progress meter. A group of several lines lists them (rows open the
// transaction drill-down); a one-line group opens it from the card itself.
export default function GroupCards({ groups, pacePct, onSelect }) {
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <GroupCard key={g.key} group={g} pacePct={pacePct} onSelect={onSelect} />
      ))}
    </div>
  );
}
