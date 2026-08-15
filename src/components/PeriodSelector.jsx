import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function PeriodSelector({ periods, periodId, onChange }) {
  if (!periods?.length) return null;
  return (
    <Select value={periodId || ''} onValueChange={onChange}>
      <SelectTrigger className="w-[190px] h-11 rounded-full border-stone-300 bg-white font-display text-base">
        <SelectValue placeholder="Select month" />
      </SelectTrigger>
      <SelectContent>
        {periods.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.label}{p.status !== 'final' ? ' · Preliminary' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}