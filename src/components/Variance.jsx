import React from 'react';
import { fmtVariance, fmtSignedPct, isMissingNumber } from '@/lib/finance';

// Tone from the signed amount: negative variance = Over Budget (red),
// positive = Under Budget (green), zero = neutral / On pace.
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

// "$1,234.56 Over Budget" in red / "$1,234.56 Under Budget" in green / "On pace".
export default function Variance({ amount, cents = true, className = '' }) {
  return (
    <span className={`${VARIANCE_TONE_CLASS[varianceTone(amount)]} ${className}`}>
      {fmtVariance(amount, { cents })}
    </span>
  );
}

// The variance percentage, coloured to match. `amount` decides the colour and
// the Over/Under Budget wording; `showLabel={false}` colours the "%" alone.
export function VariancePct({ pct, amount, showLabel = true, className = '' }) {
  const tone = varianceTone(amount);
  const label = !showLabel || tone === 'onpace' || tone === 'missing' ? '' : tone === 'under' ? ' Under Budget' : ' Over Budget';
  return (
    <span className={`${VARIANCE_TONE_CLASS[tone]} ${className}`}>
      {fmtSignedPct(pct)}
      {label}
    </span>
  );
}
