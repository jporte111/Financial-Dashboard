import React from 'react';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';

function Metric({ label, value, children }) {
  return (
    <div className="min-w-[78%] snap-start rounded-2xl border border-stone-300 bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:min-w-[45%] lg:min-w-0">
      <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
      <p className="mt-2 font-display text-2xl leading-tight tracking-tight tabular-nums text-stone-900 sm:text-3xl">{value}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
      {children}
    </span>
  );
}

// Top hero metric band: the four headline figures of the statement, with
// monumental Cormorant numbers and micro indicator pills. On mobile the cards
// become a horizontal snap carousel at thumb height.
export default function HeroMetrics({ vm }) {
  const s = vm.snapshot;
  return (
    <div className="mt-8 grid grid-cols-4 gap-6 max-sm:flex max-sm:snap-x max-sm:gap-4 max-sm:overflow-x-auto max-sm:pb-2">
      <Metric label="Net Cash Position" value={fmtCurrency(s.totalCash)}>
        {vm.labels.cashAsOf ? <Tag>{vm.labels.cashAsOf}</Tag> : null}
      </Metric>
      <Metric label="Total Income (YTD)" value={fmtCurrency(s.ytdIncome)}>
        <Tag>{fmtPct(s.incomeBudgetUsedPct * 100)} of annual budget</Tag>
      </Metric>
      <Metric label="Total Expenses (YTD)" value={fmtCurrency(s.ytdExpenses)}>
        <StatusPill status={s.status} />
      </Metric>
      <Metric label="Net Distributions" value={fmtCurrency(vm.distributions.total)}>
        <Tag>{vm.labels.expensesThrough || 'Year-to-date'}</Tag>
      </Metric>
    </div>
  );
}