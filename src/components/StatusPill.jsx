import React from 'react';
import { STATUS_STYLES, STATUS_TEXT, PACE_STATUS_STYLES, PACE_STATUS_TEXT } from '@/lib/finance';

// Understands both vocabularies: the legacy budget-consumption keys
// (under / near / over) used by the QuickBooks pages, and the BVA pace keys
// (under_pace / over_pace / on_pace / annual_budget_exceeded).
const STYLES = { ...STATUS_STYLES, ...PACE_STATUS_STYLES };
const TEXT = { ...STATUS_TEXT, ...PACE_STATUS_TEXT };

export default function StatusPill({ status, label = null }) {
  const s = STYLES[status] || STYLES.under;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.bg} ${s.border} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label || TEXT[status] || status}
    </span>
  );
}
