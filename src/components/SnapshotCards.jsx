import React from 'react';
import { fmtCurrency, fmtPct, fmtVariance, fmtSignedPct } from '@/lib/finance';
import { SECTION_STATE, SECTION_STATE_TEXT } from '@/lib/bvaDashboard';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import { PACE_VARIANCE_TOOLTIP } from '@/lib/finance';

function Card({ label, value, subtitle = null, children = null, muted = false }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 transition hover:shadow-[0_2px_24px_rgba(0,0,0,0.05)]">
      <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
      <p className={`mt-3 font-body text-2xl md:text-[28px] leading-tight tracking-tight tabular-nums ${muted ? 'text-stone-400' : ''}`}>
        {value}
      </p>
      {subtitle && <p className="mt-2 text-sm text-stone-500">{subtitle}</p>}
      {children}
    </div>
  );
}

export default function SnapshotCards({ vm }) {
  const s = vm.snapshot;
  const monthMode = vm.monthMode;
  const notImported = vm.states.snapshot === SECTION_STATE.NOT_IMPORTED;

  if (notImported) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        {SECTION_STATE_TEXT[SECTION_STATE.NOT_IMPORTED]} — no BVA figures have been imported for {vm.labels.displayMonth || 'this period'}.
      </div>
    );
  }

  if (monthMode) {
    const noActivity = vm.states.groups === SECTION_STATE.NO_MONTH_ACTIVITY;
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Total Cash" value={fmtCurrency(s.totalCash)} subtitle={vm.labels.cashAsOf} />
        <Card
          label="Current-Month Income"
          value={noActivity ? '$0.00' : fmtCurrency(s.monthIncome)}
          subtitle={noActivity ? SECTION_STATE_TEXT[SECTION_STATE.NO_MONTH_ACTIVITY] : `${vm.labels.displayMonth}`}
          muted={noActivity}
        />
        <Card
          label="Current-Month Expenses"
          value={noActivity ? '$0.00' : fmtCurrency(s.monthExpenses)}
          subtitle={noActivity ? SECTION_STATE_TEXT[SECTION_STATE.NO_MONTH_ACTIVITY] : `${vm.labels.displayMonth}`}
          muted={noActivity}
        />
        <Card
          label="Expected Monthly Expense Budget"
          value={fmtCurrency(s.annualExpenseBudget / 12)}
          subtitle="Annual expense budget ÷ 12"
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Total Cash" value={fmtCurrency(s.totalCash)} subtitle={vm.labels.cashAsOf}>
        {s.cashReconciles === false && (
          <p className="mt-2 text-xs text-rose-700">{SECTION_STATE_TEXT[SECTION_STATE.DISCREPANCY]} — accounts do not match the reported total.</p>
        )}
      </Card>

      <Card label="YTD Income" value={fmtCurrency(s.ytdIncome)} subtitle={vm.labels.incomeThrough} />
      <Card label="Total Annual Budgeted Income" value={fmtCurrency(s.annualBudgetedIncome)} subtitle={`${fmtPct(s.incomeBudgetUsedPct * 100)} received`} />
      <Card label="Remaining Income Budget" value={fmtCurrency(s.remainingIncomeBudget)} />

      <Card label="YTD Expenses" value={fmtCurrency(s.ytdExpenses)} subtitle={vm.labels.expensesThrough} />
      <Card label="Total Annual Budgeted Expenses" value={fmtCurrency(s.annualExpenseBudget)} subtitle={`${fmtPct(s.expenseBudgetUsedPct * 100)} used`} />
      <Card label="Remaining Annual Expense Budget" value={fmtCurrency(s.remainingAnnualBudget)} />
      <Card label="Expected Pace" value={fmtPct(s.expectedPacePct * 100)} subtitle={vm.labels.elapsedLabel} />

      <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:col-span-2 lg:col-span-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500 inline-flex items-center gap-1.5">
            Overall Variance to Expected Pace
            <InfoHint text={PACE_VARIANCE_TOOLTIP} />
          </p>
          <StatusPill status={s.status} />
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-1">
          <p className="font-body text-2xl md:text-[28px] leading-tight tracking-tight tabular-nums">
            {fmtVariance(s.overallVarianceAmount)}
          </p>
          <p className="text-lg tabular-nums text-stone-500">
            {fmtSignedPct(s.overallVariancePct)} {s.onPace ? '' : s.favorable ? 'favorable' : 'unfavorable'}
          </p>
        </div>
      </div>
    </div>
  );
}
