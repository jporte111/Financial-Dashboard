import React from 'react';
import { STATUS_STYLES, PACE_STATUS_STYLES } from '@/lib/finance';

const STYLES = { ...STATUS_STYLES, ...PACE_STATUS_STYLES };

export default function BudgetBar({ pct, status }) {
  const s = STYLES[status] || STYLES.under;
  const capped = Math.min(Number(pct || 0), 100);
  const over = Math.min(Math.max(Number(pct || 0) - 100, 0), 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
      <div className="flex h-full w-full">
        <div className={`h-full ${s.bar} transition-all duration-700`} style={{ width: `${capped}%` }} />
        {over > 0 && (
          <div className="h-full bg-rose-700 transition-all duration-700" style={{ width: `${Math.min(over, 100 - capped) || over / 4}%` }} />
        )}
      </div>
    </div>
  );
}