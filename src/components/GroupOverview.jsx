import React from 'react';
import { fmtCurrency, fmtPct, GROUP_LABELS } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between py-1.5 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function GroupOverview({ groups }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {groups.map(({ key, totals }) => (
        <div key={key} className="rounded-2xl border border-stone-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg">{GROUP_LABELS[key]}</h3>
            <StatusPill status={totals.status} />
          </div>
          <p className="mt-4 font-display text-2xl tracking-tight">{fmtCurrency(totals.ytd)}</p>
          <p className="text-sm text-stone-500">of {fmtCurrency(totals.annual)} annual budget</p>
          <div className="mt-4">
            <BudgetBar pct={totals.pctUsed} status={totals.status} />
            <p className="mt-2 text-xs text-stone-500">{fmtPct(totals.pctUsed)} of budget used</p>
          </div>
          <div className="mt-4 divide-y divide-stone-100 border-t border-stone-100 pt-2">
            <Row label="Current Month" value={fmtCurrency(totals.month)} />
            <Row label="Remaining" value={fmtCurrency(totals.remaining)} />
            <Row
              label="Pace Variance"
              value={`${fmtCurrency(Math.abs(totals.variance))} ${totals.variance >= 0 ? 'favorable' : 'unfavorable'}`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}