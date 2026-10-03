import React from 'react';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';

const CARD = 'rounded-2xl border border-stone-300 bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]';
const LABEL = 'text-xs uppercase tracking-[0.14em] text-stone-500';

function Stat({ label, value, missingText = '—' }) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <p className="mt-1 font-display text-2xl tracking-tight tabular-nums">
        {value == null ? missingText : fmtCurrency(value)}
      </p>
    </div>
  );
}

// Sticky side panel: Cash Reserves breakdown, Savings Allocation progress,
// distribution entities and client-visible recurring transfers.
export default function ClientSidePanel({ vm }) {
  const cash = vm.cash;
  const sd = vm.savingsDistributions;
  const retainedPct = sd.savingsIn > 0 ? Math.max(Math.min(sd.netSavings / sd.savingsIn, 1), 0) : null;

  return (
    <aside className="space-y-6 lg:sticky lg:top-32">
      <div className={CARD}>
        <p className={LABEL}>Cash Reserves</p>
        <p className="mt-2 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(cash.total)}</p>
        {vm.labels.cashAsOf && <p className="mt-1 text-xs text-stone-400">{vm.labels.cashAsOf}</p>}
        {cash.accounts.length > 0 && (
          <div className="mt-4 divide-y divide-stone-100">
            {cash.accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="text-xs text-stone-500">{a.accountType === 'investment' ? 'Investment' : 'Bank'}</p>
                </div>
                <p className="shrink-0 text-sm tabular-nums">{fmtCurrency(a.balance)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`${CARD} space-y-5`}>
        <p className={LABEL}>Savings Allocation</p>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Distributions In" value={sd.savingsIn} missingText="Not provided" />
          <Stat label="Net Savings" value={sd.netSavings} missingText="Not provided" />
          <Stat label="Expenses From Savings" value={sd.savingsSpend} missingText="Not provided" />
          <Stat label="Distributions YTD" value={sd.distributionsYtd} />
        </div>
        {retainedPct != null && (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-stone-500">
              <span>Share of savings retained</span>
              <span className="tabular-nums">{fmtPct(retainedPct * 100)}</span>
            </div>
            <BudgetBar pct={retainedPct * 100} status="under" />
          </div>
        )}
        {sd.savingsSpendCategories.length > 0 && (
          <div className="divide-y divide-stone-100 border-t border-stone-100 pt-1">
            {sd.savingsSpendCategories.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <p className="min-w-0 truncate text-sm">{s.category}</p>
                <p className="shrink-0 text-sm tabular-nums">{fmtCurrency(s.ytdAmount)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {vm.distributions.entities.length > 0 && (
        <div className={CARD}>
          <p className={LABEL}>Distributions by Entity</p>
          <div className="mt-3 divide-y divide-stone-100">
            {vm.distributions.entities.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                <p className="min-w-0 truncate text-sm font-medium">{e.name}</p>
                <p className="shrink-0 text-sm tabular-nums">{fmtCurrency(e.ytd)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {vm.transfers.items.length > 0 && (
        <div className={CARD}>
          <p className={LABEL}>Recurring Transfers</p>
          <div className="mt-3 divide-y divide-stone-100">
            {vm.transfers.items.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.purpose || 'Recurring transfer'}</p>
                  {t.source && <p className="truncate text-xs text-stone-500">From {t.source}</p>}
                </div>
                <p className="shrink-0 text-sm tabular-nums">{fmtCurrency(t.amount)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}