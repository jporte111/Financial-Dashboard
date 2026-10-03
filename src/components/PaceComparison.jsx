import React from 'react';
import { fmtCurrency } from '@/lib/finance';
import { VARIANCE_TONE_CLASS } from '@/components/Variance';

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// The two distinct comparisons every year-to-date category card shows:
//   1. against the FULL annual budget (only shown when it has been exceeded)
//   2. against the expected YTD pace
// For savings lines the comparison is against the savings target instead, with
// the tone inverted (saving less than expected is the unfavorable outcome).
export default function PaceComparison({ view, savings = false, emphasized = false }) {
  if (!view || view.mode !== 'ytd') return null;
  // Without both figures there is no comparison — never an implied "On pace".
  if (view.varianceToPace == null || view.actual == null || view.annual == null) {
    return <p className="text-xs text-stone-400">Comparison unavailable — source value missing</p>;
  }
  const rows = [];
  if (savings) {
    const v = r2(view.varianceToPace); // expected − actual
    if (v === 0) rows.push({ label: 'On savings target', amount: 0, tone: 'onpace' });
    else if (v > 0) rows.push({ label: 'Below savings target', amount: v, tone: 'over' });
    else rows.push({ label: 'Above savings target', amount: -v, tone: 'under' });
  } else {
    const overAnnual = r2(view.actual - view.annual);
    if (overAnnual > 0) rows.push({ label: 'Above full annual budget', amount: overAnnual, tone: 'over' });
    const v = r2(view.varianceToPace);
    if (v === 0) rows.push({ label: 'On expected YTD pace', amount: 0, tone: 'onpace' });
    else if (v > 0) rows.push({ label: 'Below expected YTD pace', amount: v, tone: 'under' });
    else rows.push({ label: 'Above expected YTD pace', amount: -v, tone: 'over' });
  }
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <p
          key={row.label}
          className={`tabular-nums ${emphasized && i === 0 ? 'font-display text-xl tracking-tight' : 'text-xs'}`}
        >
          {row.amount !== 0 && (
            <span className={VARIANCE_TONE_CLASS[row.tone]}>{fmtCurrency(row.amount, { cents: false })}</span>
          )}{' '}
          <span className={emphasized && i === 0 ? 'font-body text-sm text-stone-500' : 'text-stone-500'}>
            {row.label}
          </span>
        </p>
      ))}
    </div>
  );
}