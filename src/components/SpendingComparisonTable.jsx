import React from 'react';
import { computeLine, fmtCurrency, fmtPct, GROUP_LABELS } from '@/lib/finance';
import BudgetBar from '@/components/BudgetBar';
import StatusPill from '@/components/StatusPill';
import { ChevronRight } from 'lucide-react';

// Side-by-side comparison table: live QuickBooks-rolled-up totals beside the
// stored Excel (BudgetLine) snapshots. Each row is a BudgetLine (the report of
// record); the live column sums every QBO account whose account_code equals
// the line's qb_code.
export default function SpendingComparisonTable({ rows, monthsElapsed, useMonth = false, onSelect }) {
  if (!rows || !rows.length)
    return <p className="rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">No categories for this period.</p>;

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <div className="hidden grid-cols-12 gap-4 border-b border-stone-100 bg-stone-50/60 px-6 py-3 md:grid">
        <div className="col-span-3 text-[11px] uppercase tracking-[0.12em] text-stone-400">Category</div>
        <div className="col-span-4 text-[11px] uppercase tracking-[0.12em] text-stone-400">Live · QuickBooks</div>
        <div className="col-span-2 text-[11px] uppercase tracking-[0.12em] text-stone-400">Excel Snapshot</div>
        <div className="col-span-3 text-[11px] uppercase tracking-[0.12em] text-stone-400">Variance · Status</div>
      </div>
      {rows.map((r, i) => {
        const pseudo = {
          annual_budget: r.annual_budget,
          ytd_actual: r.live_ytd,
          month_actual: r.live_month_value,
          pace_method: r.pace_method,
          expected_ytd_override: r.expected_ytd_override,
        };
        const c = computeLine(pseudo, monthsElapsed, useMonth);
        const liveVal = useMonth ? r.live_month_value : r.live_ytd;
        const snapVal = useMonth ? r.snapshot_month : r.snapshot_ytd;
        const diff = liveVal - snapVal;
        const clickable = r.drilldown_enabled !== false;
        const line = { ...r, ytd_actual: r.live_ytd, month_actual: r.live_month_value };
        return (
          <div
            key={r.qb_code || r.category}
            onClick={() => clickable && onSelect(line)}
            className={`grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-12 md:items-center ${i ? 'border-t border-stone-100' : ''} ${
              clickable ? 'cursor-pointer transition hover:bg-stone-50' : ''
            }`}
          >
            <div className="md:col-span-3">
              <div className="flex items-center gap-2">
                <p className="font-medium">{r.category}</p>
                {clickable && <ChevronRight className="h-4 w-4 text-stone-300" />}
              </div>
              <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-stone-400">
                {GROUP_LABELS[r.budget_group] || ''}{r.qb_code ? ` · ${r.qb_code}` : ''}
              </p>
            </div>
            <div className="md:col-span-4">
              <p className="text-sm tabular-nums">
                {fmtCurrency(c.ytd)} <span className="text-stone-400">/ {fmtCurrency(c.annual)}</span>
              </p>
              <div className="mt-2">
                <BudgetBar pct={c.pctUsed} status={c.status} />
              </div>
              <p className="mt-1.5 text-xs text-stone-500">{fmtPct(c.pctUsed)} used · {fmtCurrency(c.remaining)} remaining</p>
            </div>
            <div className="md:col-span-2">
              <p className="text-sm tabular-nums">
                {r.has_snapshot ? fmtCurrency(snapVal) : <span className="text-stone-300">—</span>}
              </p>
              {r.has_snapshot && (
                <p
                  className={`mt-1 text-xs tabular-nums ${
                    Math.abs(diff) < 0.01 ? 'text-stone-400' : diff > 0 ? 'text-rose-600' : 'text-emerald-600'
                  }`}
                >
                  {Math.abs(diff) < 0.01 ? 'matches' : `${diff > 0 ? '+' : '-'}${fmtCurrency(Math.abs(diff), { cents: false })}`}
                </p>
              )}
            </div>
            <div className="md:col-span-3 md:flex md:items-center md:justify-between md:gap-3">
              <div>
                <p className="text-sm tabular-nums">{fmtCurrency(Math.abs(c.variance))}</p>
                <p className="text-xs text-stone-500">{c.variance >= 0 ? 'under pace' : 'over pace'}</p>
              </div>
              <StatusPill status={c.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}