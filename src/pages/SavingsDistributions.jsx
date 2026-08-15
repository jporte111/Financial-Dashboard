import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import { fmtCurrency } from '@/lib/finance';
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
  const savingsIn = Number(period.savings_in_ytd || 0);
  const savingsOut = Number(period.savings_spend_ytd || 0);

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading title="Savings & Other Spending" subtitle="Extraordinary items funded from accumulated savings — excluded from the personal budget" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ['Savings / Distributions In', savingsIn],
            ['Expenses Paid From Savings', savingsOut],
            ['Net Savings', savingsIn - savingsOut],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
              <p className="mt-3 font-display text-2xl tracking-tight tabular-nums">{fmtCurrency(value)}</p>
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
        <p className="mb-5 font-display text-3xl tracking-tight tabular-nums">{fmtCurrency(period.distributions_ytd)}</p>
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