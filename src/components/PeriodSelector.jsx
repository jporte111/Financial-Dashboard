import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isSuperseded, isDiscarded, plainLabel } from '../../base44/shared/periodVersions.ts';

// The month picker speaks in months, not versions: a replaced or discarded
// version is left out (History & recovery and the Periods tab still reach it)
// unless it is the one selected, and a correction not yet published is named
// as such rather than by revision number.
export const pickerLabel = (p) => `${plainLabel(p)}${p.status !== 'final' && !p.supersedes ? ' · Preliminary' : ''}`;

export default function PeriodSelector({ periods, periodId, onChange }) {
  if (!periods?.length) return null;
  const shown = periods.filter((p) => p.id === periodId || (!isSuperseded(p) && !isDiscarded(p)));
  return (
    <Select value={periodId || ''} onValueChange={onChange}>
      <SelectTrigger className="w-[220px] h-11 rounded-full border-stone-300 bg-white font-display text-base">
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
