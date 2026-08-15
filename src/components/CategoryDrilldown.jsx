import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { computeLine, fmtCurrency, fmtPct } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import { format } from 'date-fns';

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-stone-500">{label}</p>
      <p className="mt-1.5 font-display text-lg tabular-nums">{value}</p>
    </div>
  );
}

export default function CategoryDrilldown({ line, periodId, monthsElapsed, onClose }) {
  const [txns, setTxns] = useState(null);

  useEffect(() => {
    if (!line) return;
    setTxns(null);
    base44.entities.Transaction.filter({ period_id: periodId, category: line.category }, '-date').then(setTxns);
  }, [line, periodId]);

  const c = line ? computeLine(line, monthsElapsed) : null;

  return (
    <Sheet open={!!line} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {line && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl tracking-tight">{line.category}</SheetTitle>
            </SheetHeader>
            <div className="mt-4">
              <StatusPill status={c.status} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Stat label="Annual Budget" value={fmtCurrency(c.annual)} />
              <Stat label="YTD Actual" value={fmtCurrency(c.ytd)} />
              <Stat label="Budget Remaining" value={fmtCurrency(c.remaining)} />
              <Stat label="Budget Used" value={fmtPct(c.pctUsed)} />
              <Stat
                label="Budget Pace Variance"
                value={`${fmtCurrency(Math.abs(c.variance))} ${c.variance >= 0 ? 'Under' : 'Over'}`}
              />
              <Stat label="Current Month" value={fmtCurrency(line.month_actual)} />
            </div>

            <h4 className="mt-8 text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</h4>
            {txns === null ? (
              <p className="py-8 text-sm text-stone-400">Loading…</p>
            ) : txns.length === 0 ? (
              <p className="py-8 text-sm text-stone-500">No transaction detail available for this category yet.</p>
            ) : (
              <div className="mt-3 overflow-hidden rounded-xl border border-stone-200">
                {txns.map((t, i) => (
                  <div key={t.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
                    <div>
                      <p className="text-sm font-medium">{t.vendor || '—'}</p>
                      <p className="text-xs text-stone-500">
                        {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}{t.description ? ` · ${t.description}` : ''}
                      </p>
                    </div>
                    <p className={`shrink-0 text-sm tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtCurrency(t.amount)}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}