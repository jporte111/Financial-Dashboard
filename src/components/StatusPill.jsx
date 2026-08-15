import React from 'react';
import { STATUS_STYLES, STATUS_TEXT } from '@/lib/finance';

export default function StatusPill({ status, label }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.under;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.bg} ${s.border} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {label || STATUS_TEXT[status]}
    </span>
  );
}