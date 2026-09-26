import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { format, endOfMonth } from 'date-fns';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default function PeriodsManager({ periods, reload, onSelect }) {
  const [month, setMonth] = useState(1);
  const [year, setYear] = useState(new Date().getFullYear());

  const create = async () => {
    const start = new Date(year, month - 1, 1);
    const end = endOfMonth(start);
    await base44.entities.ReportingPeriod.create({
      label: `${MONTHS[month - 1]} ${year}`,
      month: Number(month),
      year: Number(year),
      start_date: format(start, 'yyyy-MM-dd'),
      end_date: format(end, 'yyyy-MM-dd'),
      months_elapsed: Number(month),
      // status / published take their schema defaults (draft, unpublished);
      // state changes go only through the periodTransition function.
      last_updated: format(new Date(), 'yyyy-MM-dd'),
    });
    reload();
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Reporting Periods</p>
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs text-stone-500">Month (1–12)</Label>
          <Input className="mt-1 w-28" type="number" min="1" max="12" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs text-stone-500">Year</Label>
          <Input className="mt-1 w-32" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <Button className="rounded-full" onClick={create}>Create Period</Button>
      </div>
      <div className="mt-6 divide-y divide-stone-100">
        {periods.map((p) => (
          <div key={p.id} className="flex items-center justify-between py-3 text-sm">
            <div>
              <p className="font-medium">{p.label}</p>
              <p className="text-xs text-stone-500">
                {p.status.replace(/_/g, ' ')}{p.published ? ' · published' : ' · not published'}
              </p>
            </div>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => onSelect(p.id)}>Edit</Button>
          </div>
        ))}
      </div>
    </div>
  );
}