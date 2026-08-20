import React, { useState } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useLiveRollup } from '@/lib/useLiveRollup';
import SectionHeading from '@/components/SectionHeading';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import { fmtCurrency, GROUP_LABELS } from '@/lib/finance';
import { ChevronRight, AlertTriangle } from 'lucide-react';

// Live QuickBooks layer: one row per synced QBO account with live YTD/month
// spend, drilled down into the underlying QBO transactions. No budget-vs-actual
// reporting here — that lives on the Excel (BudgetLine) side.
export default function LiveQuickbooks() {
  const { period, periodId, ytdMode } = usePeriodContext();
  const { liveAccounts, notice, loading } = useLiveRollup(periodId);
  const [selected, setSelected] = useState(null);
  const me = period.months_elapsed || 12;
  const useMonth = !ytdMode;

  const totalYtd = (liveAccounts || []).reduce((s, a) => s + a.live_ytd, 0);
  const totalMonth = (liveAccounts || []).reduce((s, a) => s + a.live_month_value, 0);

  return (
    <div>
      <SectionHeading
        title="Live QuickBooks"
        subtitle="Synced P&L accounts with live spend, straight from QuickBooks"
      />

      {loading ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center text-sm text-stone-400">Loading live totals…</div>
      ) : !liveAccounts.length ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center">
          <p className="font-display text-xl">No synced QuickBooks accounts yet</p>
          <p className="mt-2 text-sm text-stone-500">Run the QuickBooks sync from the Admin page to populate the live layer.</p>
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{useMonth ? 'Month Spend' : 'YTD Spend'}</p>
              <p className="mt-3 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(useMonth ? totalMonth : totalYtd)}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">QBO Accounts</p>
              <p className="mt-3 font-display text-2xl tracking-tight tabular-nums">{liveAccounts.length}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</p>
              <p className="mt-3 font-display text-2xl tracking-tight tabular-nums">{liveAccounts.reduce((s, a) => s + a.count, 0)}</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
            <div className="hidden grid-cols-12 gap-4 border-b border-stone-100 bg-stone-50/60 px-6 py-3 md:grid">
              <div className="col-span-5 text-[11px] uppercase tracking-[0.12em] text-stone-400">Account</div>
              <div className="col-span-2 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">Month</div>
              <div className="col-span-2 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">YTD</div>
              <div className="col-span-3 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">Txns</div>
            </div>
            {liveAccounts.map((a, i) => (
              <button
                key={a.account_id}
                onClick={() => setSelected(a)}
                className={`grid w-full grid-cols-1 gap-4 px-6 py-4 text-left transition hover:bg-stone-50 md:grid-cols-12 md:items-center ${
                  i ? 'border-t border-stone-100' : ''
                }`}
              >
                <div className="md:col-span-5">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{a.account_name}</p>
                    <ChevronRight className="h-4 w-4 text-stone-300" />
                  </div>
                  <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-stone-400">
                    {GROUP_LABELS[a.budget_group] || ''}{a.qb_code ? ` · ${a.qb_code}` : ''}
                  </p>
                </div>
                <div className="text-right tabular-nums md:col-span-2">{fmtCurrency(a.live_month_value)}</div>
                <div className="text-right tabular-nums md:col-span-2">{fmtCurrency(a.live_ytd)}</div>
                <div className="text-right tabular-nums text-stone-500 md:col-span-3">{a.count}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {notice && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{notice}</p>
        </div>
      )}

      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={me} onClose={() => setSelected(null)} />
    </div>
  );
}