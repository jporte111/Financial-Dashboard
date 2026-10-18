import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isSuperseded, isDiscarded } from '../../base44/shared/periodVersions.ts';
import { pickerLabel } from '@/lib/periodState';

// The month picker names each version by month and state (Phase 9a: "October
// 2026 · Draft", "September 2026 · Published correction"). A replaced or
// discarded version is left out (History & recovery and the Periods tab still
// reach it) unless it is the one selected.
export { pickerLabel };

export default function PeriodSelector({ periods, periodId, onChange }) {
  if (!periods?.length) return null;
  const shown = periods.filter((p) => p.id === periodId || (!isSuperseded(p) && !isDiscarded(p)));
  return (
    <Select value={periodId || ''} onValueChange={onChange}>
      <SelectTrigger aria-label="Report month" className="h-11 w-[min(22rem,100%)] rounded-full border-stone-300 bg-white font-display text-base">
        <SelectValue placeholder="Select month" />
      </SelectTrigger>
      <SelectContent>
        {shown.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {pickerLabel(p)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
