import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import { fmtCurrency } from '@/lib/finance';
import { SECTION_STATE, SECTION_STATE_TEXT } from '@/lib/bvaDashboard';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { format } from 'date-fns';

export default function SavingsDistributions() {
  const { period, periodId } = usePeriodContext();
  const { items: dists } = useEntityByPeriod('Distribution', periodId);
  const { items: spends } = useEntityByPeriod('SavingsSpend', periodId);
  const [drill, setDrill] = useState(null);
  const [txns, setTxns] = useState(null);

  const openDrill = async (category) => {
    setDrill(category);
    setTxns(null);
    const rows = await base44.entities.Transaction.filter(
      { period_id: periodId, category, treatment: 'savings_distribution' },
      '-date'
    );
    setTxns(rows);
  };

  const list = dists || [];
  const q = (k) => list.reduce((s, d) => s + Number(d[k] || 0), 0);
  const ytdOf = (d) => Number(d.q1 || 0) + Number(d.q2 || 0) + Number(d.q3 || 0) + Number(d.q4 || 0);
  // A missing / never-entered scalar stays null — it is not a confirmed $0.
  // (These two fields are not in the BVA workbook; they are entered in Admin.)
  const savingsIn = period.savings_in_ytd == null ? null : Number(period.savings_in_ytd);
  const savingsOut = period.savings_spend_ytd == null ? null : Number(period.savings_spend_ytd);
  const netSavings = savingsIn == null || savingsOut == null ? null : savingsIn - savingsOut;
  const distributionsYtd = period.distributions_ytd == null ? null : Number(period.distributions_ytd);

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading title="Savings & Other Spending" subtitle="Extraordinary items funded from accumulated savings — excluded from the personal budget" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ['Savings / Distributions In', savingsIn, SECTION_STATE.NEEDS_REVIEW],
            ['Expenses Paid From Savings', savingsOut, SECTION_STATE.NEEDS_REVIEW],
            ['Net Savings', netSavings, SECTION_STATE.MISSING],
          ].map(([label, value, missingState]) => (
            <div key={label} className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
              <p className={`mt-3 font-display tracking-tight tabular-nums ${value == null ? 'text-base text-stone-400' : 'text-2xl'}`}>
                {value == null ? SECTION_STATE_TEXT[missingState] : fmtCurrency(value)}
              </p>
              {value == null && (
                <p className="mt-2 text-xs text-stone-400">
                  {missingState === SECTION_STATE.NEEDS_REVIEW
                    ? 'Not in the BVA workbook — enter and confirm in Admin'
                    : 'Needs both inputs before it can be calculated'}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-stone-200 bg-white">
          <div className="border-b border-stone-100 px-6 py-3 text-xs uppercase tracking-[0.12em] text-stone-500">
            Savings-Funded Expenses by Category
          </div>
          {(spends || []).map((s) => (
            <button
              key={s.id}
              onClick={() => openDrill(s.category)}
              className="flex w-full items-center justify-between border-b border-stone-100 px-6 py-4 text-left text-sm transition last:border-0 hover:bg-stone-50"
            >
              <span className="font-medium">{s.category}</span>
              <span className="tabular-nums">{fmtCurrency(s.ytd_amount)}</span>
            </button>
          ))}
          {!spends?.length && <p className="px-6 py-6 text-sm text-stone-500">No savings-funded expenses recorded.</p>}
        </div>
      </section>

      <section>
        <SectionHeading title={`${period.year} YTD Distributions`} subtitle="By entity and quarter" />
        <p className={`mb-5 font-display tracking-tight tabular-nums ${distributionsYtd == null ? 'text-lg text-stone-400' : 'text-3xl'}`}>
          {distributionsYtd == null ? SECTION_STATE_TEXT[SECTION_STATE.MISSING] : fmtCurrency(distributionsYtd)}
        </p>
        <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-xs uppercase tracking-[0.12em] text-stone-500">
                <th className="px-6 py-3 text-left font-normal">Entity</th>
                {['Q1', 'Q2', 'Q3', 'Q4', 'YTD'].map((h) => (
                  <th key={h} className="px-6 py-3 text-right font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-6 py-3 font-medium">{d.entity_name}</td>
                  {['q1', 'q2', 'q3', 'q4'].map((k) => (
                    <td key={k} className="px-6 py-3 text-right tabular-nums">{fmtCurrency(d[k])}</td>
                  ))}
                  <td className="px-6 py-3 text-right font-medium tabular-nums">{fmtCurrency(ytdOf(d))}</td>
                </tr>
              ))}
              <tr className="bg-stone-50 font-medium">
                <td className="px-6 py-3">Total</td>
                {['q1', 'q2', 'q3', 'q4'].map((k) => (
                  <td key={k} className="px-6 py-3 text-right tabular-nums">{fmtCurrency(q(k))}</td>
                ))}
                <td className="px-6 py-3 text-right tabular-nums">{fmtCurrency(q('q1') + q('q2') + q('q3') + q('q4'))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <Sheet open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader><SheetTitle className="font-display text-2xl tracking-tight">{drill}</SheetTitle></SheetHeader>
          {txns === null ? (
            <p className="py-8 text-sm text-stone-400">Loading…</p>
          ) : txns.length === 0 ? (
            <p className="py-8 text-sm text-stone-500">No transaction detail available yet.</p>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-stone-200">
              {txns.map((t, i) => (
                <div key={t.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
                  <div>
                    <p className="text-sm font-medium">{t.vendor || '—'}</p>
                    <p className="text-xs text-stone-500">
                      {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}{t.description ? ` · ${t.description}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm tabular-nums">{fmtCurrency(t.amount)}</p>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}