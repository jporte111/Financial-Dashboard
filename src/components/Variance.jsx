import React from 'react';
import { fmtVariance, fmtPacePoints, isMissingNumber } from '@/lib/finance';

// Tone from the signed amount: negative variance = above expected pace (red),
// positive = below expected pace (green), zero = neutral / On pace.
// A missing variance is 'missing' (neutral dash), never "On pace".
export function varianceTone(amount) {
  if (isMissingNumber(amount)) return 'missing';
  const r = Math.round(Number(amount) * 100) / 100;
  return r === 0 ? 'onpace' : r > 0 ? 'under' : 'over';
}

export const VARIANCE_TONE_CLASS = {
  over: 'text-rose-600',
  under: 'text-emerald-600',
  onpace: 'text-stone-500',
  missing: 'text-stone-400',
};

// "$1,234.56 above expected pace" in red / "$1,234.56 below expected pace" in
// green / "On pace". basis 'month': against the monthly budget.
export default function Variance({ amount, cents = true, basis = 'pace', className = '' }) {
  return (
    <span className={`${VARIANCE_TONE_CLASS[varianceTone(amount)]} ${className}`}>
      {fmtVariance(amount, { cents, basis })}
    </span>
  );
}

// The pace gap in percentage points ("7.69 pts below pace"), coloured to match
// the amount's direction.
export function VariancePct({ pct, amount, className = '' }) {
  return <span className={`${VARIANCE_TONE_CLASS[varianceTone(amount)]} ${className}`}>{fmtPacePoints(pct)}</span>;
}
