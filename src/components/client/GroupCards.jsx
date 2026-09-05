import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import CategoryTable from '@/components/CategoryTable';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import Variance, { VariancePct } from '@/components/Variance';

function GroupCard({ group, pacePct, onSelect }) {
  const [open, setOpen] = useState(true);
  const c = group.ytd;
  return (
    <div className="rounded-2xl border border-stone-300 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 p-6 text-left"
        aria-expanded={open}
      >
        <div>
          <p className="font-display text-xl tracking-tight">{group.label}</p>
          <p className="mt-1 text-sm tabular-nums text-stone-500">
            {fmtCurrency(c.actual)} <span className="text-stone-400">of {fmtCurrency(c.annual)} annual budget</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <StatusPill status={c.status} />
          <ChevronDown className={`h-4 w-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      <div className="px-6 pb-6">
        <BudgetBar pct={c.percentUsed * 100} status={c.status} />
        <p className="mt-2 text-sm tabular-nums">
          <Variance amount={c.varianceToPace} cents={false} />{' '}
          <span className="text-stone-500">
            · <VariancePct pct={c.variancePct} amount={c.varianceToPace} showLabel={false} /> vs expected pace ({fmtPct(pacePct * 100)})
          </span>
        </p>
      </div>

      {open && group.lines.length > 0 && (
        <div className="border-t border-stone-100">
          <CategoryTable rows={group.lines} monthMode={false} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

// Group Budget vs Actuals — collapsible Fixed / Variable / Discretionary cards,
// each with its progress meter and full category breakdown table. Rows open the
// transaction drill-down.
export default function GroupCards({ groups, pacePct, onSelect }) {
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <GroupCard key={g.key} group={g} pacePct={pacePct} onSelect={onSelect} />
      ))}
    </div>
  );
}