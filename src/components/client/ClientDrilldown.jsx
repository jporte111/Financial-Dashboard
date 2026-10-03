import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { bvaComputeYtd, bvaSavingsStatus, fmtCurrency, fmtPct, PACE_VARIANCE_TOOLTIP, pct100 } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import Variance, { VariancePct } from '@/components/Variance';
import { format } from 'date-fns';

function Stat({ label, value, hint = null }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-stone-500">
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="mt-1.5 font-display text-lg tabular-nums">{value}</p>
    </div>
  );
}

// Body shared by the desktop side sheet and the mobile full-screen sheet.
function DrilldownBody({ line, periodId, monthsElapsed }) {
  const [txns, setTxns] = useState(null);

  useEffect(() => {
    if (!line) return;
    let cancelled = false;
    setTxns(null);
    base44.functions
      .invoke('publicCategoryTransactions', {
        period_id: periodId,
        // The server resolves the line and its account names itself.
        budget_line_id: line.id,
        category: line.category,
      })
      .then((res) => {
        if (!cancelled) setTxns((res.data || res).transactions || []);
      })
      .catch(() => !cancelled && setTxns([]));
    return () => {
      cancelled = true;
    };
  }, [line, periodId]);

  const c = line.group === 'savings'
    ? bvaSavingsStatus({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, monthsElapsed)
    : bvaComputeYtd({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, monthsElapsed);

  return (
    <>
      <div className="mt-4">
        <StatusPill status={c.status} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Stat label="Annual Budget" value={fmtCurrency(c.annual)} />
        <Stat label="Actual YTD" value={fmtCurrency(c.actual)} />
        <Stat label="Remaining" value={fmtCurrency(c.remaining)} />
        <Stat label="Percent Used" value={fmtPct(pct100(c.percentUsed))} />
        <Stat label="Expected YTD Budget" value={fmtCurrency(c.expectedYtdBudget)} />
        <Stat label="Variance to Expected Pace" hint={PACE_VARIANCE_TOOLTIP} value={<Variance amount={c.varianceToPace} />} />
        <Stat label="Variance Percentage" value={<VariancePct pct={c.variancePct} amount={c.varianceToPace} showLabel={false} />} />
        <Stat label="Current Month" value={line.month_actual == null ? '—' : fmtCurrency(line.month_actual)} />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h4 className="text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</h4>
        {txns && txns.length > 0 && (
          <span className="text-xs tabular-nums text-stone-500">
            {txns.length} · {fmtCurrency(txns.reduce((s, t) => s + t.amount, 0))} YTD
          </span>
        )}
      </div>
      {txns === null ? (
        <p className="py-8 text-sm text-stone-400">Loading transactions…</p>
      ) : txns.length === 0 ? (
        <p className="py-8 text-sm text-stone-500">
          No underlying transactions are stored for this category. Reported figures come from the monthly workbook.
        </p>
      ) : (
        <div className="mt-3 overflow-y-auto rounded-xl border border-stone-200 lg:max-h-[40vh]">
          {txns.map((t, i) => {
            const sub = t.full_account_path ? t.full_account_path.split(':').pop().replace(/^\d+\s*[-:]?\s*/, '').trim() : '';
            return (
              <div key={t.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t.vendor || t.description || '—'}</p>
                  <p className="truncate text-xs text-stone-500">
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
  );
}

// Public drill-down for the client view: a right-side slide-over on desktop, a
// full-height bottom sheet on mobile. Reads only published-period transactions
// through the public endpoint.
export default function ClientDrilldown({ line, periodId, monthsElapsed, onClose }) {
  const isMobile = useIsMobile();
  if (!line) return null;

  const title = line.category;

  if (isMobile) {
    return (
      <Drawer open={!!line} onOpenChange={(o) => !o && onClose()}>
        <DrawerContent className="max-h-[94vh]">
          <DrawerHeader className="text-left">
            <DrawerTitle className="font-display text-2xl tracking-tight">{title}</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-8">
            <DrilldownBody line={line} periodId={periodId} monthsElapsed={monthsElapsed} />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={!!line} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-display text-2xl tracking-tight">{title}</SheetTitle>
        </SheetHeader>
        <DrilldownBody line={line} periodId={periodId} monthsElapsed={monthsElapsed} />
      </SheetContent>
    </Sheet>
  );
}