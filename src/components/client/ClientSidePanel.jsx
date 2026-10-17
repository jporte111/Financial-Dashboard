import React from 'react';
import { fmtCurrency, fmtPct, pct100 } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import { LABEL, NOT_PROVIDED } from '@/lib/reportText';

const CARD = 'rounded-2xl border border-stone-300 bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]';
const LABEL_CLASS = 'text-xs uppercase tracking-[0.14em] text-stone-500';

// A missing figure is "—", with a quiet caption when it was not provided.
function Stat({ label, value, missingNote = null }) {
  return (
    <div>
      <p className={LABEL_CLASS}>{label}</p>
      <p className="mt-1 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(value)}</p>
      {value == null && missingNote && <p className="text-xs text-stone-400">{missingNote}</p>}
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
        {/* The total is the hero's Total Cash; here it closes the account list. */}
        <p className={LABEL_CLASS}>Cash Accounts</p>
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
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-stone-200 pt-2.5" data-testid="cash-total">
          <p className="text-sm font-medium">{LABEL.totalCash}</p>
          <p className="shrink-0 text-sm font-medium tabular-nums">{fmtCurrency(cash.total)}</p>
        </div>
      </div>

      <div className={`${CARD} space-y-5`}>
        <p className={LABEL_CLASS}>Savings Allocation</p>
        <div className="grid grid-cols-2 gap-4">
          <Stat label={LABEL.savingsIn} value={sd.savingsIn} missingNote={NOT_PROVIDED} />
          <Stat label={LABEL.netSavings} value={sd.netSavings} missingNote={NOT_PROVIDED} />
          <Stat label={LABEL.savingsSpend} value={sd.savingsSpend} missingNote={NOT_PROVIDED} />
          <Stat label={LABEL.distributionsYtd} value={sd.distributionsYtd} />
        </div>
        {retainedPct != null && (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-stone-500">
              <span>Share of savings retained</span>
              <span className="tabular-nums">{fmtPct(pct100(retainedPct))}</span>
            </div>
            <BudgetBar pct={pct100(retainedPct)} status="under" />
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
          <p className={LABEL_CLASS}>Distributions by Entity</p>
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
          <p className={LABEL_CLASS}>Recurring Transfers</p>
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