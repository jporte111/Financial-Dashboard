import React, { useState } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import CategoryTable from '@/components/CategoryTable';
import CategoryDrilldown from '@/components/CategoryDrilldown';

const GROUPS = ['fixed', 'variable', 'discretionary'];
const FILTERS = [['all', 'All'], ['fixed', 'Fixed'], ['variable', 'Variable'], ['discretionary', 'Discretionary']];

export default function SpendingDetail() {
  const { period, periodId } = usePeriodContext();
  const { items: lines } = useEntityByPeriod('BudgetLine', periodId);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const me = period.months_elapsed || 12;

  const shown = (lines || [])
    .filter((l) => GROUPS.includes(l.budget_group))
    .filter((l) => filter === 'all' || l.budget_group === filter);

  return (
    <div>
      <SectionHeading
        title="Spending Detail"
        subtitle="Select any category to view the transactions behind it"
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
      <CategoryTable lines={shown} monthsElapsed={me} onSelect={setSelected} />
      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={me} onClose={() => setSelected(null)} />
    </div>
  );
}