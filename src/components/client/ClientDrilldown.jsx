import React from 'react';
import { useDrilldownTransactions } from '@/lib/useDrilldownTransactions';
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
  // The public endpoint resolves the line itself and returns no transaction
  // rows (no transaction-detail source is approved for clients).
  const detail = useDrilldownTransactions(
    'publicCategoryTransactions',
    line ? { period_id: periodId, budget_line_id: line.id, category: line.category } : null,
    [line, periodId]
  );

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
        <Stat label="Gap to Expected Pace" value={<VariancePct pct={c.variancePct} amount={c.varianceToPace} />} />
        <Stat label="Current Month" value={line.month_actual == null ? '—' : fmtCurrency(line.month_actual)} />
      </div>

      <div className="mt-8">
        <h4 className="text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</h4>
      </div>
      <DrilldownDetail detail={detail} />
    </>
  );
}

// What the transactions section says. A failed request is an error with a
// retry -- never "no transactions".
function DrilldownDetail({ detail }) {
  if (detail.status === 'loading') return <p className="py-8 text-sm text-stone-400">Loading…</p>;
  if (detail.status === 'error') {
    return (
      <div className="py-6 text-sm" role="alert" data-testid="drilldown-error">
        <p className="text-rose-700">Transaction detail could not be loaded. The figures above are not affected.</p>
        <button type="button" className="mt-2 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium uppercase tracking-[0.14em] text-stone-700 hover:bg-stone-100" onClick={detail.retry}>
          Retry
        </button>
      </div>
    );
  }
  if (detail.status !== 'rows') {
    return (
      <p className="py-8 text-sm text-stone-500" data-testid="drilldown-unavailable">
        Transaction-level detail isn&apos;t shown on this dashboard. The figures above come from the monthly workbook.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-y-auto rounded-xl border border-stone-200 lg:max-h-[40vh]">
      {detail.rows.map((t, i) => (
        <div key={i} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t.vendor || t.description || '—'}</p>
            <p className="truncate text-xs text-stone-500">{t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}</p>
          </div>
          <p className={`shrink-0 text-sm tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtCurrency(t.amount)}</p>
        </div>
      ))}
    </div>
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