import React from 'react';
import { fmtCurrency, fmtPct, pct100 } from '@/lib/finance';
import Variance from '@/components/Variance';
import { LABEL, heroTakeaway } from '@/lib/reportText';

function Metric({ label, value, children }) {
  return (
    <div className="min-w-0 rounded-2xl border border-stone-300 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] sm:p-6">
      <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500 sm:text-xs">{label}</p>
      <p className="mt-2 font-display text-xl leading-tight tracking-tight tabular-nums text-stone-900 sm:text-3xl">{value}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
      {children}
    </span>
  );
}

// Top hero metric band: the four headline figures of the statement, each with
// the one comparison that explains it, and a one-line takeaway built from the
// same figures. Two columns on a phone, so all four stay in view.
export default function HeroMetrics({ vm }) {
  const s = vm.snapshot;
  const takeaway = heroTakeaway(vm);
  return (
    <div className="mt-6 sm:mt-8">
      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
        <Metric label={LABEL.totalCash} value={fmtCurrency(s.totalCash)}>
          {vm.labels.cashAsOf ? <Tag>{vm.labels.cashAsOf}</Tag> : null}
        </Metric>
        <Metric label={LABEL.incomeYtd} value={fmtCurrency(s.ytdIncome)}>
          <Tag>
            {fmtPct(pct100(s.incomeBudgetUsedPct))} of annual budget · {fmtPct(pct100(vm.pacePct))} expected
          </Tag>
        </Metric>
        <Metric label={LABEL.expensesYtd} value={fmtCurrency(s.ytdExpenses)}>
          <Tag>
            <Variance amount={s.overallVarianceAmount} cents={false} />
          </Tag>
        </Metric>
        <Metric label={LABEL.distributionsYtd} value={fmtCurrency(vm.distributions.total)}>
          <Tag>Year to date</Tag>
        </Metric>
      </div>
      {takeaway && (
        <p className="mt-4 text-sm text-stone-600 sm:text-base" data-testid="hero-takeaway">
          {takeaway}
        </p>
      )}
    </div>
  );
}
