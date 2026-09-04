import React from 'react';
import { fmtCurrency, fmtPct, fmtVariance, fmtSignedPct } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import { ChevronRight, AlertTriangle } from 'lucide-react';

const GROUP_LABEL = { fixed: 'Fixed', variable: 'Variable', discretionary: 'Discretionary', unassigned: 'Unassigned' };

// Spending Detail table, fed by pre-computed BVA detail rows (see
// buildBvaDashboard). No QuickBooks data is read here.
export default function CategoryTable({ rows, monthMode = false, onSelect }) {
  if (!rows || !rows.length)
    return (
      <p className="rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">
        No monitored categories for this period.
      </p>
    );

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      {rows.map((r, i) => {
        const c = monthMode ? r.month : r.ytd;
        const clickable = r.drilldownEnabled !== false;
        return (
          <div
            key={r.id || r.code || r.category}
            onClick={() => clickable && onSelect && onSelect(r)}
            className={`grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-12 md:items-center ${i ? 'border-t border-stone-100' : ''} ${
              clickable ? 'cursor-pointer transition hover:bg-stone-50' : ''
            }`}
          >
            <div className="md:col-span-4">
              <div className="flex items-center gap-2">
                <p className="font-medium">{r.category}</p>
                {clickable && <ChevronRight className="h-4 w-4 text-stone-300" />}
                {r.hasUnresolvedWarning && (
                  <span title="Unresolved validation warning" className="inline-flex">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-stone-400">
                {GROUP_LABEL[r.group] || ''}{r.code ? ` · ${r.code}` : ''}
                {r.group === 'unassigned' ? ' · group mapping required' : ''}
              </p>
            </div>

            <div className="md:col-span-4">
              <p className="text-sm tabular-nums">
                {fmtCurrency(c.actual)} <span className="text-stone-400">/ {fmtCurrency(monthMode ? c.monthlyBudget : c.annual)}</span>
              </p>
              <div className="mt-2">
                <BudgetBar pct={c.percentUsed * 100} status={monthMode ? 'under' : c.status} />
              </div>
              <p className="mt-1.5 text-xs text-stone-500">
                {monthMode ? (
                  <>{fmtPct(c.percentUsed * 100)} of monthly budget</>
                ) : (
                  <>
                    {fmtPct(c.percentUsed * 100)} used · {fmtCurrency(c.remaining)} remaining · expected {fmtCurrency(c.expectedYtdBudget)}
                  </>
                )}
              </p>
            </div>

            <div className="md:col-span-2 text-sm">
              <p className="tabular-nums">{fmtVariance(monthMode ? c.varianceToBudget : c.varianceToPace, { cents: false })}</p>
              {!monthMode && <p className="text-xs text-stone-500">{fmtSignedPct(c.variancePct)}</p>}
              {!monthMode && r.currentMonthShown !== false && (
                <p className="mt-1 text-xs text-stone-400">This month {fmtCurrency(r.monthActual)}</p>
              )}
            </div>

            <div className="md:col-span-2 md:text-right">
              {monthMode ? <span className="text-xs text-stone-400">This month</span> : <StatusPill status={c.status} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
