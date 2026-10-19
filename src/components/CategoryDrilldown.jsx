import React from 'react';
import { useDrilldownTransactions } from '@/lib/useDrilldownTransactions';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { bvaComputeYtd, bvaSavingsStatus, fmtCurrency, fmtPct, PACE_VARIANCE_TOOLTIP, pct100 } from '@/lib/finance';
import StatusPill from '@/components/StatusPill';
import InfoHint from '@/components/InfoHint';
import Variance, { VariancePct } from '@/components/Variance';
import { format } from 'date-fns';

function Stat({ label, value, hint = null }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-stone-500 inline-flex items-center gap-1.5">
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="mt-1.5 font-display text-lg tabular-nums">{value}</p>
    </div>
  );
}

// BVA-only: fetches whatever transaction detail already exists locally for a
// category (never QuickBooks — see base44/functions/categoryTransactions).
// Admins only see rows; replaced versions never supply them.
export default function CategoryDrilldown({ line, periodId, monthsElapsed, onClose }) {
  // Admins get the stored rows; a signed-in non-admin gets the public answer
  // (no rows). A failed request shows an error and a retry.
  const detail = useDrilldownTransactions(
    'categoryTransactions',
    line ? { period_id: periodId, category: line.category, qb_account_names: line.qb_account_names || [] } : null,
    [line, periodId]
  );
  const txns = detail.rows;

  const hasBudgetContext = line && (line.has_snapshot || (line.annual_budget && Number(line.annual_budget) > 0));
  const c = hasBudgetContext
    ? line.group === 'savings'
      ? bvaSavingsStatus({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, monthsElapsed)
      : bvaComputeYtd({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, monthsElapsed)
    : null;

  return (
    <Sheet open={!!line} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {line && (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-2xl tracking-tight">{line.category || line.account_name}</SheetTitle>
            </SheetHeader>

            {hasBudgetContext && (
              <>
                <div className="mt-4">
                  <StatusPill status={c.status} />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <Stat label="Annual Budget" value={fmtCurrency(c.annual)} />
                  <Stat label="Actual YTD" value={fmtCurrency(c.actual)} />
                  <Stat label="Remaining" value={fmtCurrency(c.remaining)} />
                  <Stat label="Percent Used" value={fmtPct(pct100(c.percentUsed))} />
                  <Stat label="Expected YTD Budget" value={fmtCurrency(c.expectedYtdBudget)} />
                  <Stat label="Variance to Budget" hint={PACE_VARIANCE_TOOLTIP} value={<Variance amount={c.varianceToPace} />} />
                  <Stat label="Gap to Budget" value={<VariancePct pct={c.variancePct} amount={c.varianceToPace} />} />
                  <Stat label="Current Month" value={line.month_actual == null ? '—' : fmtCurrency(line.month_actual)} />
                </div>
              </>
            )}

            {detail.data?.source === 'detail_report' && <DetailReconciliation data={detail.data} />}

            <div className="mt-8 flex items-center justify-between">
              <h4 className="text-xs uppercase tracking-[0.14em] text-stone-500">Transactions</h4>
              {txns && txns.length > 0 && (
                <span className="text-xs text-stone-500 tabular-nums">
                  {txns.length} · {fmtCurrency(txns.reduce((s, t) => s + t.amount, 0))} YTD
                </span>
              )}
            </div>
            {detail.status === 'loading' ? (
              <p className="py-8 text-sm text-stone-400">Loading transactions…</p>
            ) : detail.status === 'error' ? (
              <div className="py-6 text-sm" role="alert" data-testid="drilldown-error">
                <p className="text-rose-700">{detail.error} The figures above are not affected.</p>
                <button type="button" className="mt-2 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium uppercase tracking-[0.14em] text-stone-700 hover:bg-stone-100" onClick={detail.retry}>
                  Retry
                </button>
              </div>
            ) : detail.status === 'unavailable' ? (
              <p className="py-8 text-sm text-stone-500" data-testid="drilldown-unavailable">
                Transaction-level detail isn&apos;t shown on this dashboard. The figures above come from the monthly workbook.
              </p>
            ) : detail.status === 'empty' ? (
              <p className="py-8 text-sm text-stone-500" data-testid="drilldown-empty">
                No stored transactions match this category. BVA figures come from the monthly workbook, not from transaction-level data.
              </p>
            ) : (
              <div className="mt-3 max-h-[40vh] overflow-y-auto rounded-xl border border-stone-200">
                {txns.map((t, i) => {
                  const sub = t.full_account_path ? t.full_account_path.split(':').pop().replace(/^\d+\s*[-:]?\s*/, '').trim() : '';
                  return (
                    <div key={t.id || i} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t.vendor || t.description || '—'}</p>
                        <p className="text-xs text-stone-500 truncate">
                          {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}
                          {t.description && t.vendor ? ` · ${t.description}` : ''}
                          {sub ? ` · ${sub}` : ''}
                        </p>
                        {t.source === 'detail_report' && (
                          <p className="truncate text-[11px] text-stone-400" data-testid="internal-row">
                            {t.full_account_path}{t.payment_account ? ` · ${t.payment_account}` : ''}{t.qb_type ? ` · ${t.qb_type}` : ''}{t.qb_num ? ` #${t.qb_num}` : ''}
                            {t.client_visible ? '' : ' · not shown to the client (account not confirmed or outside the cost groups)'}
                          </p>
                        )}
                      </div>
                      <p className={`shrink-0 text-sm tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtCurrency(t.amount)}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// Phase 5b (internal): how the attached transaction detail compares with the
// report line, and what the client sees for it.
const usd = (c) => (c == null ? '—' : fmtCurrency(c / 100));
const STATUS_TEXT = { reconciled: 'Reconciled', difference: 'Differs from the report', no_detail: 'No transactions in the detail', bva_missing: 'Report figure missing' };
function DetailReconciliation({ data }) {
  const e = data.reconciliation;
  if (!e) return <p className="mt-6 text-sm text-stone-500" data-testid="detail-reconciliation">This line is not matched to the transaction detail.</p>;
  return (
    <div className={`mt-6 rounded-xl border p-4 text-sm ${e.status === 'reconciled' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`} data-testid="detail-reconciliation" data-status={e.status}>
      <p className="font-medium">Transaction detail: {STATUS_TEXT[e.status] || e.status}</p>
      <p className="mt-1 tabular-nums text-stone-700">Report {usd(e.bva_total)} · detail {usd(e.detail_total)} · difference {usd(e.difference)}</p>
      {e.withheld > 0 && <p className="mt-1 text-stone-600">{e.withheld} transaction(s) from accounts without a confirmed mapping are not shown to the client.</p>}
      <p className="mt-2 text-xs text-stone-500">
        Client sees: {data.client?.transactions?.length ? `${data.client.transactions.length} transaction(s) — ` : 'no transactions — '}
        &ldquo;{data.client?.note}&rdquo;
      </p>
      <p className="mt-1 text-xs text-stone-400">Warnings only: the report figure is used on the dashboard and publishing is never blocked.</p>
    </div>
  );
}