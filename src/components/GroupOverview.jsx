import React from 'react';
import { fmtCurrency, fmtPct, PACE_VARIANCE_TOOLTIP, pct100 } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import Variance, { VariancePct } from '@/components/Variance';

function Row({ label, value, hint = null }) {
  return (
    <div className="flex items-baseline justify-between py-1.5 text-sm">
      <span className="text-stone-500 inline-flex items-center gap-1.5">
        {label}
        {hint && <InfoHint text={hint} />}
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function GroupOverview({ groups, monthMode, expectedPacePct }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {groups.map((g) => {
        const c = monthMode ? g.month : g.ytd;
        return (
          <div key={g.key} className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg">{g.label}</h3>
              {!monthMode && <StatusPill status={c.status} />}
            </div>

            <p className="mt-4 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(c.actual)}</p>
            <p className="text-sm text-stone-500">
              {monthMode
                ? `of ${fmtCurrency(c.monthlyBudget)} expected this month`
                : `of ${fmtCurrency(c.annual)} annual budget`}
            </p>

            <div className="mt-4">
              <BudgetBar pct={pct100(c.percentUsed)} status={monthMode ? 'under' : c.status} />
              <p className="mt-2 text-xs text-stone-500">{fmtPct(pct100(c.percentUsed))} {monthMode ? 'of monthly budget' : 'of budget used'}</p>
            </div>

            <div className="mt-4 divide-y divide-stone-100 border-t border-stone-100 pt-2">
              {monthMode ? (
                <>
                  <Row label="Current Month" value={fmtCurrency(c.actual)} />
                  <Row label="Expected This Month" value={fmtCurrency(c.monthlyBudget)} />
                  <Row label="Difference" value={<Variance amount={c.varianceToBudget} />} />
                </>
              ) : (
                <>
                  <Row label="Actual YTD" value={fmtCurrency(c.actual)} />
                  <Row label="Annual Budget" value={fmtCurrency(c.annual)} />
                  <Row label="Remaining" value={fmtCurrency(c.remaining)} />
                  <Row label="Percent Used" value={fmtPct(pct100(c.percentUsed))} />
                  <Row label="Expected Pace" value={fmtPct(pct100(expectedPacePct ?? c.pacePct))} />
                  <Row label="Variance to Expected Pace" hint={PACE_VARIANCE_TOOLTIP} value={<Variance amount={c.varianceToPace} />} />
                  <Row label="Variance Percentage" value={<VariancePct pct={c.variancePct} amount={c.varianceToPace} />} />
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
