import React from 'react';
import { fmtCurrency, fmtPct, pct100 } from '@/lib/finance';
import { SECTION_STATE, SECTION_STATE_TEXT } from '@/lib/bvaDashboard';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import Variance, { VariancePct } from '@/components/Variance';
import { PACE_VARIANCE_TOOLTIP } from '@/lib/finance';

// The workbook's printed total is shown; when its rows add up to something
// else, the card says so (the sum is kept for checking).
const differs = (shown, calc) => shown != null && calc != null && Math.round(shown * 100) !== Math.round(calc * 100);
function DoesNotAddUp({ shown, calc, rows }) {
  if (!differs(shown, calc)) return null;
  return <p className="mt-2 text-xs text-rose-700" data-testid="does-not-add-up">The workbook does not add up — its {rows} total {fmtCurrency(calc)}; the workbook&apos;s figure is shown.</p>;
}

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
    // Three distinct states per current-month figure:
    //   missing  — the BVA workbook carried no month column ("Source value missing")
    //   zero     — a real imported $0 ("No current-month activity imported.")
    //   value    — an actual figure (marked partial when some lines had none)
    const monthCard = (label, amount, missing, partial) => {
      const zero = !missing && !partial && Math.round(Number(amount) * 100) / 100 === 0;
      return (
        <Card
          label={label}
          value={missing ? SECTION_STATE_TEXT[SECTION_STATE.MISSING] : fmtCurrency(amount)}
          subtitle={
            missing
              ? 'Not provided by the BVA workbook'
              : partial
                ? 'Partial — excludes lines with no current-month figure in the workbook'
                : zero
                ? SECTION_STATE_TEXT[SECTION_STATE.NO_MONTH_ACTIVITY]
                : `${vm.labels.displayMonth}`
          }
          muted={missing || zero}
        />
      );
    };
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Total Cash" value={fmtCurrency(s.totalCash)} subtitle={vm.labels.cashAsOf} />
        {monthCard('Current-Month Income', s.monthIncome, s.monthIncomeMissing, s.monthIncomePartial)}
        {monthCard('Current-Month Expenses', s.monthExpenses, s.monthExpensesMissing, s.monthExpensesPartial)}
        <Card
          label="Expected Monthly Expense Budget"
          value={fmtCurrency(s.annualExpenseBudget == null ? null : s.annualExpenseBudget / 12)}
          subtitle={s.annualExpenseBudget == null ? 'Annual expense budget not stored for this period' : 'Annual expense budget ÷ 12'}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Total Cash" value={fmtCurrency(s.totalCash)} subtitle={vm.labels.cashAsOf}>
        {s.cashReconciles === false && (
          <p className="mt-2 text-xs text-rose-700">{SECTION_STATE_TEXT[SECTION_STATE.DISCREPANCY]} — the accounts do not add up to the workbook&apos;s Total Cash, which is shown.</p>
        )}
      </Card>

      <Card label="Total Income (YTD)" value={fmtCurrency(s.ytdIncome)} subtitle={vm.labels.incomeThrough}>
        <DoesNotAddUp shown={s.ytdIncome} calc={s.incomeCalculatedYtd} rows="income lines" />
      </Card>
      <Card
        label="Total Annual Budgeted Income"
        value={fmtCurrency(s.annualBudgetedIncome)}
        subtitle={s.annualBudgetedIncome == null ? 'Not stored for this period' : `${fmtPct(pct100(s.incomeBudgetUsedPct))} received`}
      >
        <DoesNotAddUp shown={s.annualBudgetedIncome} calc={s.incomeCalculatedBudget} rows="income lines' budgets" />
      </Card>
      <Card label="Remaining Income Budget" value={fmtCurrency(s.remainingIncomeBudget)} />

      <Card label="Total Expenses (YTD)" value={fmtCurrency(s.ytdExpenses)} subtitle={vm.labels.expensesThrough}>
        <DoesNotAddUp shown={s.ytdExpenses} calc={s.expensesCalculatedYtd} rows="expense groups" />
      </Card>
      <Card
        label="Total Annual Budgeted Expenses"
        value={fmtCurrency(s.annualExpenseBudget)}
        subtitle={s.annualExpenseBudget == null ? 'Not stored for this period' : `${fmtPct(pct100(s.expenseBudgetUsedPct))} used`}
      >
        <DoesNotAddUp shown={s.annualExpenseBudget} calc={s.expensesCalculatedBudget} rows="expense groups' budgets" />
      </Card>
      <Card label="Remaining Annual Expense Budget" value={fmtCurrency(s.remainingAnnualBudget)} />
      <Card label="Expected Pace" value={fmtPct(pct100(s.expectedPacePct))} subtitle={vm.labels.elapsedLabel} />

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
            <Variance amount={s.overallVarianceAmount} />
          </p>
          <p className="text-lg tabular-nums">
            <VariancePct pct={s.overallVariancePct} amount={s.overallVarianceAmount} />
          </p>
        </div>
      </div>
    </div>
  );
}
