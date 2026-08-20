import React, { useState } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useLiveRollup } from '@/lib/useLiveRollup';
import SectionHeading from '@/components/SectionHeading';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import { computeLine, fmtCurrency, fmtPct, GROUP_LABELS } from '@/lib/finance';
import { ChevronRight, AlertTriangle } from 'lucide-react';

// Live (QuickBooks) tab — every number here comes from synced QuickBooks
// transactions. No Excel snapshot data is read on this tab. Progress and
// pacing are computed from each account's live total vs its annual budget.
export default function LiveQuickbooks() {
  const { period, periodId, ytdMode } = usePeriodContext();
  const { liveAccounts, notice, loading } = useLiveRollup(periodId);
  const [selected, setSelected] = useState(null);
  const me = period.months_elapsed || 12;
  const useMonth = !ytdMode;

  const totalYtd = (liveAccounts || []).reduce((s, a) => s + a.live_ytd, 0);
  const totalMonth = (liveAccounts || []).reduce((s, a) => s + a.live_month_value, 0);

  const open = (a) =>
    setSelected({
      ...a,
      category: a.account_name,
      ytd_actual: a.live_ytd,
      month_actual: a.live_month_value,
      has_snapshot: false,
    });

  return (
    <div>
      <SectionHeading
        title="Live (QuickBooks)"
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
              <div className="col-span-4 text-[11px] uppercase tracking-[0.12em] text-stone-400">Account</div>
              <div className="col-span-5 text-[11px] uppercase tracking-[0.12em] text-stone-400">Live Spend vs Budget</div>
              <div className="col-span-2 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">Pace</div>
              <div className="col-span-1 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">Status</div>
            </div>
            {liveAccounts.map((a, i) => {
              const c = computeLine(
                { annual_budget: a.annual_budget, ytd_actual: a.live_ytd, month_actual: a.live_month_value },
                me,
                useMonth
              );
              return (
                <button
                  key={a.account_id}
                  onClick={() => open(a)}
                  className={`grid w-full grid-cols-1 gap-4 px-6 py-4 text-left transition hover:bg-stone-50 md:grid-cols-12 md:items-center ${
                    i ? 'border-t border-stone-100' : ''
                  }`}
                >
                  <div className="md:col-span-4">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{a.account_name}</p>
                      <ChevronRight className="h-4 w-4 text-stone-300" />
                    </div>
                    <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-stone-400">
                      {GROUP_LABELS[a.budget_group] || ''}{a.qb_code ? ` · ${a.qb_code}` : ''}
                    </p>
                  </div>
                  <div className="md:col-span-5">
                    <p className="text-sm tabular-nums">
                      {fmtCurrency(c.ytd)} <span className="text-stone-400">/ {fmtCurrency(c.annual)}</span>
                    </p>
                    <div className="mt-2"><BudgetBar pct={c.pctUsed} status={c.status} /></div>
                    <p className="mt-1.5 text-xs text-stone-500">{fmtPct(c.pctUsed)} used · {fmtCurrency(c.remaining)} remaining</p>
                  </div>
                  <div className="text-sm md:col-span-2 md:text-right">
                    <p className="tabular-nums">{fmtCurrency(Math.abs(c.variance))}</p>
                    <p className="text-xs text-stone-500">{c.variance >= 0 ? 'under pace' : 'over pace'}</p>
                  </div>
                  <div className="md:col-span-1 md:text-right">
                    <StatusPill status={c.status} />
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {notice && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{notice}</p>
        </div>
      )}

      <CategoryDrilldown
        line={selected}
        periodId={periodId}
        monthsElapsed={me}
        sourceFilter="quickbooks"
        onClose={() => setSelected(null)}
      />
    </div>
  );
}