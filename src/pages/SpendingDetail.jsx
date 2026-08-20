import React, { useState } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useLiveRollup } from '@/lib/useLiveRollup';
import SectionHeading from '@/components/SectionHeading';
import SpendingComparisonTable from '@/components/SpendingComparisonTable';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import { AlertTriangle } from 'lucide-react';

const FILTERS = [['all', 'All'], ['fixed', 'Fixed'], ['variable', 'Variable'], ['discretionary', 'Discretionary']];
const GROUPS = ['fixed', 'variable', 'discretionary'];

export default function SpendingDetail() {
  const { period, periodId, ytdMode } = usePeriodContext();
  const { rows, notice, loading } = useLiveRollup(periodId);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const me = period.months_elapsed || 12;
  const useMonth = !ytdMode;

  const shown = (rows || [])
    .filter((r) => GROUPS.includes(r.budget_group))
    .filter((r) => filter === 'all' || r.budget_group === filter);

  return (
    <div>
      <SectionHeading
        title="Spending Detail"
        subtitle="Live QuickBooks totals beside the Excel snapshot — compare both sources"
        right={
          <div className="flex gap-1">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`rounded-full px-3 py-1.5 text-sm transition ${filter === k ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {loading ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center text-sm text-stone-400">Calculating live totals…</div>
      ) : (
        <SpendingComparisonTable rows={shown} monthsElapsed={me} useMonth={useMonth} onSelect={setSelected} />
      )}
      {notice && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{notice}</p>
        </div>
      )}
      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={me} onClose={() => setSelected(null)} />
    </div>
  );
}