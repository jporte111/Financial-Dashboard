import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import { aggregateGroup, computeLine, fmtCurrency } from '@/lib/finance';
import SnapshotCards from '@/components/SnapshotCards';
import GroupOverview from '@/components/GroupOverview';
import SectionHeading from '@/components/SectionHeading';
import CategoryTable from '@/components/CategoryTable';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import CashCard from '@/components/CashCard';
import RecurringTransfersCard from '@/components/RecurringTransfersCard';
import StatusPill from '@/components/StatusPill';

const GROUPS = ['fixed', 'variable', 'discretionary'];

export default function Dashboard() {
  const { period, periodId } = usePeriodContext();
  const { items: lines } = useEntityByPeriod('BudgetLine', periodId);
  const { items: accounts } = useEntityByPeriod('CashAccount', periodId, 'sort_order');
  const { items: transfers } = useEntityByPeriod('RecurringTransfer', periodId);
  const [selected, setSelected] = useState(null);

  const me = period.months_elapsed || 12;
  const expenseLines = (lines || []).filter((l) => GROUPS.includes(l.budget_group));
  const groups = GROUPS.map((key) => ({ key, totals: aggregateGroup(expenseLines.filter((l) => l.budget_group === key), me) }));
  const disc = groups.find((g) => g.key === 'discretionary').totals;
  const budgetStatus = {
    variance: disc.variance,
    pct: disc.annual ? (Math.abs(disc.variance) / disc.annual) * 100 : 0,
    status: disc.status,
  };

  const attention = expenseLines
    .map((l) => ({ l, c: computeLine(l, me) }))
    .filter((x) => x.c.variance < 0)
    .sort((a, b) => a.c.variance - b.c.variance)
    .slice(0, 6);

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading title="Financial Snapshot" subtitle={period.label} />
        <SnapshotCards period={period} budgetStatus={budgetStatus} />
      </section>

      <section>
        <SectionHeading title="Budget Overview" subtitle="Performance by budget group against annual plan" />
        <GroupOverview groups={groups} />
      </section>

      {attention.length > 0 && (
        <section>
          <SectionHeading title="Categories Needing Attention" subtitle="Above expected pace for this point in the year" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {attention.map(({ l, c }) => (
              <button
                key={l.id}
                onClick={() => setSelected(l)}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left transition hover:shadow-[0_2px_24px_rgba(0,0,0,0.05)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{l.category}</p>
                  <StatusPill status={c.status} />
                </div>
                <p className="mt-3 font-display text-xl tabular-nums">{fmtCurrency(Math.abs(c.variance))}</p>
                <p className="text-sm text-stone-500">over expected pace</p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeading
          title="Spending Detail"
          subtitle="Select a category to view underlying transactions"
          right={<Link to="/spending" className="text-sm text-stone-500 underline-offset-4 hover:underline">View all</Link>}
        />
        <CategoryTable lines={expenseLines.slice(0, 6)} monthsElapsed={me} onSelect={setSelected} />
      </section>

      <section>
        <SectionHeading title="Savings & Distributions" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Distributions YTD', period.distributions_ytd],
            ['Savings / Distributions In', period.savings_in_ytd],
            ['Expenses Paid From Savings', period.savings_spend_ytd],
            ['Net Savings', Number(period.savings_in_ytd || 0) - Number(period.savings_spend_ytd || 0)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
              <p className="mt-3 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(value)}</p>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Link to="/savings" className="text-sm text-stone-500 underline-offset-4 hover:underline">View savings activity</Link>
        </div>
      </section>

      <section>
        <SectionHeading title="Cash" />
        <CashCard total={period.total_cash} accounts={accounts} />
      </section>

      <section>
        <RecurringTransfersCard transfers={(transfers || []).filter((t) => t.visible_to_client !== false)} />
      </section>

      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={me} onClose={() => setSelected(null)} />
    </div>
  );
}