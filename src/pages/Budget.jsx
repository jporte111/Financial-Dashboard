import React, { useMemo, useState } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import { useBvaDashboard } from '@/lib/useBvaDashboard';
import { bvaComputeYtd, bvaSavingsStatus, fmtCurrency, fmtPct } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import { SECTION_STATE, SECTION_STATE_TEXT } from '@/lib/bvaDashboard';
import SectionHeading from '@/components/SectionHeading';
import GroupOverview from '@/components/GroupOverview';
import BudgetBar from '@/components/BudgetBar';
import CategoryTable from '@/components/CategoryTable';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import ImportedAccountsSection from '@/components/ImportedAccountsSection';

// Budget (Excel) tab — every number comes from the validated BVA workbook
// snapshot (BudgetLine / ReportingPeriod). No QuickBooks data is read here.
export default function Budget() {
  const { periodId } = usePeriodContext();
  const { vm, loading } = useBvaDashboard();
  const { items: lines } = useEntityByPeriod('BudgetLine', periodId);
  const [selected, setSelected] = useState(null);

  const savingsLines = useMemo(() => (lines || []).filter((l) => l.budget_group === 'savings'), [lines]);

  if (loading) return <div className="py-24 text-center text-sm text-stone-400">Loading…</div>;

  const monthMode = vm.monthMode;
  const incomeUsed = vm.snapshot.annualBudgetedIncome ? vm.snapshot.ytdIncome / vm.snapshot.annualBudgetedIncome : 0;

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading
          title="Budget Overview"
          subtitle={`${vm.labels.displayMonth} · ${monthMode ? 'This Month' : 'Year to Date'} · BVA snapshot`}
        />
        {vm.states.groups === SECTION_STATE.NOT_IMPORTED ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
            {SECTION_STATE_TEXT[SECTION_STATE.NOT_IMPORTED]}
          </p>
        ) : (
          <GroupOverview groups={vm.groups} monthMode={monthMode} expectedPacePct={vm.pacePct} />
        )}
      </section>

      <section>
        <SectionHeading title="Budget Progress by Category" subtitle="Monitored BVA categories — click a category for detail" />
        <CategoryTable rows={vm.detail} monthMode={monthMode} onSelect={setSelected} />
      </section>

      <section>
        <SectionHeading title="Income" subtitle="Received against annual budgeted income · BVA snapshot" />
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
          <div className="hidden grid-cols-6 gap-4 border-b border-stone-100 px-6 py-3 text-xs uppercase tracking-[0.12em] text-stone-500 md:grid">
            <span className="col-span-2">Account / Category</span>
            <span className="text-right">Current Month</span>
            <span className="text-right">Actual YTD</span>
            <span className="text-right">Annual Budget</span>
            <span className="text-right">Remaining · % Received</span>
          </div>
          {vm.incomeRows.map((l) => (
            <div key={l.id} className="grid gap-2 border-b border-stone-100 px-6 py-4 text-sm last:border-0 md:grid-cols-6 md:gap-4">
              <span className="col-span-2 font-medium">{l.code ? `${l.code} · ` : ''}{l.category}</span>
              <span className="tabular-nums md:text-right">{l.monthActual == null ? <span className="text-stone-400">—</span> : fmtCurrency(l.monthActual)}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.actualYtd)}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.annualBudget)}</span>
              <span className="tabular-nums md:text-right">{fmtCurrency(l.remaining)} · {fmtPct(l.percentUsed * 100)}</span>
            </div>
          ))}
          <div className="grid gap-2 bg-stone-50 px-6 py-4 text-sm font-medium md:grid-cols-6 md:gap-4">
            <span className="col-span-2">Total Income</span>
            <span className="tabular-nums md:text-right">
              {vm.snapshot.monthIncome == null ? <span className="text-stone-400">—</span> : fmtCurrency(vm.snapshot.monthIncome)}
            </span>
            <span className="tabular-nums md:text-right">{fmtCurrency(vm.snapshot.ytdIncome)}</span>
            <span className="tabular-nums md:text-right">{fmtCurrency(vm.snapshot.annualBudgetedIncome)}</span>
            <span className="tabular-nums md:text-right">{fmtCurrency(vm.snapshot.remainingIncomeBudget)} · {fmtPct(incomeUsed * 100)}</span>
          </div>
        </div>
        {vm.snapshot.monthIncomeMissing && (
          <p className="mt-2 text-xs text-stone-400">
            Current-month income is not provided by the BVA workbook for this period — shown as “—”, not $0.00.
          </p>
        )}
        {vm.snapshot.incomeWorkbookBudget != null && (
          <p className="mt-2 text-xs text-stone-400">
            Workbook displayed an annual income budget of {fmtCurrency(vm.snapshot.incomeWorkbookBudget)}; the independently calculated
            total {fmtCurrency(vm.snapshot.annualBudgetedIncome)} is used.
          </p>
        )}
      </section>

      {savingsLines.length > 0 && (
        <section>
          <SectionHeading title="Planned Monthly Savings" subtitle="Separate from savings-funded spending and entity distributions" />
          <div className="grid gap-4 sm:grid-cols-2">
            {savingsLines.map((l) => {
              const c = bvaSavingsStatus({ actualYtd: l.ytd_actual, annualBudget: l.annual_budget }, vm.elapsedMonths);
              return (
                <div key={l.id} className="rounded-2xl border border-stone-200 bg-white p-6">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{l.category}</p>
                    <StatusPill status={c.status} />
                  </div>
                  <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(c.actual)}</p>
                  <p className="text-sm text-stone-500">of {fmtCurrency(c.annual)} annual target</p>
                  <div className="mt-4"><BudgetBar pct={c.percentUsed * 100} status={c.status} /></div>
                  <div className="mt-3 flex justify-between text-sm text-stone-500">
                    <span>Current month {l.month_actual == null ? '—' : fmtCurrency(l.month_actual)}</span>
                    <span>{fmtPct(c.percentUsed * 100)} of goal</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <ImportedAccountsSection />

      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={vm.elapsedMonths} onClose={() => setSelected(null)} />
    </div>
  );
}