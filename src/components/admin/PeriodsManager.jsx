import React, { useState } from 'react';
import { isRevision, isSuperseded, revisionNumber } from '../../../base44/shared/periodVersions.ts';
import { StateChip } from '@/components/ContextBar';
import { periodTransition } from '@/lib/periodTransition';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { format, endOfMonth } from 'date-fns';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Published and final periods are read-only in the admin workflow, so their
// row offers View; drafts offer Edit. Both select the period and open its
// Monthly Data, where the read-only notice and disabled editors apply.
const isReadOnly = (p) => !!p.published || p.status === 'final' || isSuperseded(p);

export default function PeriodsManager({ periods, selectedId, reload, onOpen }) {
  const [month, setMonth] = useState(1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [error, setError] = useState('');

  const create = async () => {
    const start = new Date(year, month - 1, 1);
    const end = endOfMonth(start);
    // Created and initialized (draft, unpublished) on the server; refused if
    // the month already exists.
    const res = await periodTransition('create', null, { data: {
      label: `${MONTHS[month - 1]} ${year}`,
      month: Number(month),
      year: Number(year),
      start_date: format(start, 'yyyy-MM-dd'),
      end_date: format(end, 'yyyy-MM-dd'),
      months_elapsed: Number(month),
      // status / published take their schema defaults (draft, unpublished);
      // state changes go only through the periodTransition function.
      last_updated: format(new Date(), 'yyyy-MM-dd'),
    } });
    if (!res.ok) setError((res.blockers[0] && res.blockers[0].message) || res.error || 'The period could not be created.');
    else setError('');
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
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      <div className="mt-6 divide-y divide-stone-100">
        {periods.map((p) => {
          const selected = p.id === selectedId;
          const action = isReadOnly(p) ? 'View' : 'Edit';
          return (
          <div
            key={p.id}
            className={`flex items-center justify-between py-3 text-sm ${selected ? '-mx-3 rounded-xl bg-stone-50 px-3' : ''}`}
            aria-current={selected ? 'true' : undefined}
            data-testid={`period-row-${p.id}`}
          >
            <div>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {p.label}
                {revisionNumber(p) > 1 && <span className="text-xs font-normal text-stone-500">revision {revisionNumber(p)}</span>}
                <StateChip period={p} />
                {selected && <span className="rounded-full bg-stone-900 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-white">Selected</span>}
              </p>
              <p className="text-xs text-stone-500">
                Review stage: {p.status ? p.status.replace(/_/g, ' ') : 'not initialized (cannot be finalized)'}
                {isRevision(p) && p.copy_status !== 'verified' ? ` · copy ${p.copy_status || 'unverified'}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" className="rounded-full" aria-label={`${action} ${p.label}`} onClick={() => onOpen(p.id)}>{action}</Button>
          </div>
          );
        })}
      </div>
    </div>
  );
}