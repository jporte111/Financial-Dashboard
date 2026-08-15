import React from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import { aggregateGroup, computeLine, fmtCurrency, fmtPct } from '@/lib/finance';
import SectionHeading from '@/components/SectionHeading';
import GroupOverview from '@/components/GroupOverview';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';

const GROUPS = ['fixed', 'variable', 'discretionary'];

export default function Budget() {
  const { period, periodId } = usePeriodContext();
  const { items: lines } = useEntityByPeriod('BudgetLine', periodId);
  const me = period.months_elapsed || 12;
  const all = lines || [];
  const expenseLines = all.filter((l) => GROUPS.includes(l.budget_group));
  const incomeLines = all.filter((l) => l.budget_group === 'income');
  const savingsLines = all.filter((l) => l.budget_group === 'savings');
  const groups = GROUPS.map((key) => ({ key, totals: aggregateGroup(expenseLines.filter((l) => l.budget_group === key), me) }));

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading title="Budget Overview" subtitle={period.label} />
        <GroupOverview groups={groups} />
      </section>

      <section>
        <SectionHeading title="Budget Progress by Category" />
        <div className="space-y-3">
          {expenseLines.map((l) => {
            const c = computeLine(l, me);
            return (
              <div key={l.id} className="rounded-2xl border border-stone-200 bg-white p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="font-medium">{l.category}</p>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums text-stone-600">
                      {fmtCurrency(c.ytd)} / {fmtCurrency(c.annual)}
                    </span>
                    <StatusPill status={c.status} />
                  </div>
                </div>
                <div className="mt-4">
                  <BudgetBar pct={c.pctUsed} status={c.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-y-2 text-sm md:grid-cols-4">
                  <p className="text-stone-500">Remaining <span className="ml-1 tabular-nums text-stone-900">{fmtCurrency(c.remaining)}</span></p>
                  <p className="text-stone-500">Used <span className="ml-1 tabular-nums text-stone-900">{fmtPct(c.pctUsed)}</span></p>
                  <p className="text-stone-500">Expected YTD <span className="ml-1 tabular-nums text-stone-900">{fmtCurrency(c.expected)}</span></p>
                  <p className="text-stone-500">
                    Pace <span className="ml-1 tabular-nums text-stone-900">{fmtCurrency(Math.abs(c.variance))} {c.variance >= 0 ? 'under' : 'over'}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeading title="Income" subtitle="Received against expected income" />
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
          <div className="hidden grid-cols-6 gap-4 border-b border-stone-100 px-6 py-3 text-xs uppercase tracking-[0.12em] text-stone-500 md:grid">
            <span className="col-span-2">Source</span><span className="text-right">Current Month</span><span className="text-right">YTD</span><span className="text-right">Expected</span><span className="text-right">% Received</span>
          </div>
          {incomeLines.map((l) => (
            <div key={l.id} className="grid gap-2 border-b border-stone-100 px-6 py-4 text-sm last:border-0 md:grid-cols-6 md:gap-4">
              <span className="col-span-2 font-medium">{l.category}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.month_actual)}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.ytd_actual)}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.annual_budget)}</span>
              <span className="tabular-nums md:text-right">{fmtPct(l.annual_budget ? (l.ytd_actual / l.annual_budget) * 100 : 0)}</span>
            </div>
          ))}
          <div className="grid gap-2 bg-stone-50 px-6 py-4 text-sm font-medium md:grid-cols-6 md:gap-4">
            <span className="col-span-2">Total Income</span>
            <span className="tabular-nums md:text-right">{fmtCurrency(period.month_income)}</span>
            <span className="tabular-nums md:text-right">{fmtCurrency(period.ytd_income)}</span>
            <span className="md:col-span-2" />
          </div>
        </div>
      </section>

      {savingsLines.length > 0 && (
        <section>
          <SectionHeading title="Planned Monthly Savings" subtitle="Separate from savings-funded spending and entity distributions" />
          <div className="grid gap-4 sm:grid-cols-2">
            {savingsLines.map((l) => {
              const c = computeLine(l, me);
              return (
                <div key={l.id} className="rounded-2xl border border-stone-200 bg-white p-6">
                  <p className="font-medium">{l.category}</p>
                  <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(c.ytd)}</p>
                  <p className="text-sm text-stone-500">of {fmtCurrency(c.annual)} annual target</p>
                  <div className="mt-4"><BudgetBar pct={c.pctUsed} status="under" /></div>
                  <div className="mt-3 flex justify-between text-sm text-stone-500">
                    <span>Current month {fmtCurrency(l.month_actual)}</span>
                    <span>{fmtPct(c.pctUsed)} of goal</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}