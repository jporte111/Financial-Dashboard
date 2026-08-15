import React from 'react';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import { format } from 'date-fns';

function Card({ label, value, subtitle, children }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 transition hover:shadow-[0_2px_24px_rgba(0,0,0,0.05)]">
      <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
      <p className="mt-3 font-display text-2xl md:text-[28px] leading-tight tracking-tight">{value}</p>
      {subtitle && <p className="mt-2 text-sm text-stone-500">{subtitle}</p>}
      {children}
    </div>
  );
}

export default function SnapshotCards({ period, budgetStatus }) {
  const asOf = period.end_date ? format(new Date(period.end_date), 'MMMM d, yyyy') : period.label;
  const over = budgetStatus.variance < 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Total Cash" value={fmtCurrency(period.total_cash)} subtitle={`As of ${asOf}`} />
      <Card label="YTD Income" value={fmtCurrency(period.ytd_income)} subtitle={`Income received through ${period.label.split(' ')[0]}`} />
      <Card label="YTD Expenses" value={fmtCurrency(period.ytd_expenses)} subtitle={`Expenses through ${period.label.split(' ')[0]}`} />
      <Card
        label="Budget Status"
        value={`${fmtCurrency(Math.abs(budgetStatus.variance))} ${over ? 'Over' : 'Under'} Budget`}
        subtitle={`${fmtPct(Math.abs(budgetStatus.pct))} ${over ? 'Over' : 'Under'} Budget`}
      >
        <div className="mt-3">
          <StatusPill status={budgetStatus.status} />
        </div>
      </Card>
    </div>
  );
}