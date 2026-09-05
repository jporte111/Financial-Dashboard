import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { bvaComputeYtd, fmtCurrency, fmtPct, PACE_VARIANCE_TOOLTIP } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import Variance, { VariancePct } from '@/components/Variance';
import { format } from 'date-fns';

function Stat({ label, value, hint = null }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-stone-500 inline-flex items-center gap-1.5">
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="mt-1.5 font-display text-lg tabular-nums">{value}</p>
    </div>
  );
}

// BVA-only: fetches whatever transaction detail already exists locally for a
// category (never QuickBooks — see base44/functions/categoryTransactions).
export default function CategoryDrilldown({ line, periodId, monthsElapsed, onClose }) {
  const [txns, setTxns] = useState(null);

  useEffect(() => {
    if (!line) return;
    let cancelled = false;
    setTxns(null);
    base44.functions
      .invoke('categoryTransactions', {
        period_id: periodId,
        category: line.category,
        qb_account_names: line.qb_account_names || [],
      })
      .then((res) => {
        if (cancelled) return;
        const data = res.data || res;
        setTxns(data.transactions || []);
      })
      .catch(() => !cancelled && setTxns([]));
    return () => {
      cancelled = true;
    };
  }, [line, periodId]);

  const hasBudgetContext = line && (line.has_snapshot || (line.annual_budget && Number(line.annual_budget) > 0));
  const c = hasBudgetContext
    ? bvaComputeYtd({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, monthsElapsed)
    : null;

  return (
    <Sheet open={!!line} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {line && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl tracking-tight">{line.category || line.account_name}</SheetTitle>
            </SheetHeader>

            {hasBudgetContext && (
              <>
                <div className="mt-4">
                  <StatusPill status={c.status} />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Stat label="Annual Budget" value={fmtCurrency(c.annual)} />
                  <Stat label="Actual YTD" value={fmtCurrency(c.actual)} />
                  <Stat label="Remaining" value={fmtCurrency(c.remaining)} />
                  <Stat label="Percent Used" value={fmtPct(c.percentUsed * 100)} />
                  <Stat label="Expected YTD Budget" value={fmtCurrency(c.expectedYtdBudget)} />
                  <Stat label="Variance to Expected Pace" hint={PACE_VARIANCE_TOOLTIP} value={<Variance amount={c.varianceToPace} />} />
                  <Stat label="Variance Percentage" value={<VariancePct pct={c.variancePct} amount={c.varianceToPace} showLabel={false} />} />
                  <Stat label="Current Month" value={fmtCurrency(line.month_actual)} />
                </div>
              </>
            )}

            <div className="mt-8 flex items-center justify-between">
              <h4 className="text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</h4>
              {txns && txns.length > 0 && (
                <span className="text-xs text-stone-500 tabular-nums">
                  {txns.length} · {fmtCurrency(txns.reduce((s, t) => s + t.amount, 0))} YTD
                </span>
              )}
            </div>
            {txns === null ? (
              <p className="py-8 text-sm text-stone-400">Loading transactions…</p>
            ) : txns.length === 0 ? (
              <p className="py-8 text-sm text-stone-500">
                No underlying transactions are stored for this category. BVA figures come from the monthly workbook, not from transaction-level data.
              </p>
            ) : (
              <div className="mt-3 max-h-[40vh] overflow-y-auto rounded-xl border border-stone-200">
                {txns.map((t, i) => {
                  const sub = t.full_account_path ? t.full_account_path.split(':').pop().replace(/^\d+\s*[-:]?\s*/, '').trim() : '';
                  return (
                    <div key={t.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t.vendor || t.description || '—'}</p>
                        <p className="text-xs text-stone-500 truncate">
                          {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}
                          {t.description && t.vendor ? ` · ${t.description}` : ''}
                          {sub ? ` · ${sub}` : ''}
                        </p>
                      </div>
                      <p className={`shrink-0 text-sm tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtCurrency(t.amount)}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
