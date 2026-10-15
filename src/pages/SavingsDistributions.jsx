import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import { fmtCurrency } from '@/lib/finance';
import { SECTION_STATE, SECTION_STATE_TEXT, QUARTER_STATE, buildBvaDashboard } from '@/lib/bvaDashboard';
import { effectiveRecord } from '../../base44/shared/sourceMissing.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { format } from 'date-fns';

export default function SavingsDistributions() {
  const { period: rawPeriod, periodId } = usePeriodContext();
  // Fields listed as missing are missing, whatever number is stored.
  const period = effectiveRecord(rawPeriod || {});
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
  // Quarter states come from the REPORT's cutoff date: a quarter that starts
  // after it is not yet applicable; a begun quarter with no figure is missing;
  // a stored 0 is a confirmed $0.00.
  const dv = buildBvaDashboard({ period, distributions: list }).distributions;
  const QS = ['q1', 'q2', 'q3', 'q4'];
  // The workbook's printed totals are shown when stored (they may not equal
  // the sum of the rows; a note below says so); else the rows are summed.
  const colTotal = (k) => {
    if (dv.printedQuarterTotals[k] != null) return { value: dv.printedQuarterTotals[k], partial: false };
    if (!dv.quarterApplicable[k] && dv.entities.every((e) => e.quarterState[k] !== QUARTER_STATE.VALUE)) return { value: null, notYet: true };
    const counted = dv.entities.filter((e) => e.quarterState[k] !== QUARTER_STATE.NOT_YET);
    const knownVals = counted.filter((e) => e[k] != null).map((e) => e[k]);
    return { value: knownVals.length ? knownVals.reduce((s, v) => s + v, 0) : null, partial: knownVals.length < counted.length };
  };
  const cell = (e, k) =>
    e.quarterState[k] === QUARTER_STATE.NOT_YET
      ? { text: '—', title: 'Not yet applicable — this quarter starts after the report cutoff' }
      : e.quarterState[k] === QUARTER_STATE.MISSING
        ? { text: '—', title: SECTION_STATE_TEXT[SECTION_STATE.MISSING] }
        : { text: fmtCurrency(e[k]), title: undefined };
  const anyNotYet = QS.some((k) => !dv.quarterApplicable[k]);
  const anyMissing = dv.entities.some((e) => QS.some((k) => e.quarterState[k] === QUARTER_STATE.MISSING));
  // Printed-total periods show the workbook's grand total; earlier periods
  // keep the sum of the entities they were published with.
  const grand = dv.printedTotals ? dv.total : dv.entitySum;
  const grandPartial = grand === dv.entitySum && dv.partial;
  const summed = (k) => dv.entities.reduce((t, e) => t + (e[k] ?? 0), 0);
  const doesNotAddUp =
    dv.entities.some((e) => e.ytdReconciles === false) ||
    (dv.total != null && dv.entitySum != null && !dv.partial && Math.round(dv.total * 100) !== Math.round(dv.entitySum * 100)) ||
    QS.some((k) => dv.printedQuarterTotals[k] != null && Math.round(dv.printedQuarterTotals[k] * 100) !== Math.round(summed(k) * 100));
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
              {dv.entities.map((e) => (
                <tr key={e.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-6 py-3 font-medium">{e.name}</td>
                  {QS.map((k) => {
                    const c = cell(e, k);
                    return (
                      <td key={k} className={`px-6 py-3 text-right tabular-nums ${c.title ? 'text-stone-400' : ''}`} title={c.title}>
                        {c.text}
                      </td>
                    );
                  })}
                  <td className="px-6 py-3 text-right font-medium tabular-nums">
                    {fmtCurrency(e.ytd)}
                    {e.ytdPartial && e.ytd != null && <span className="ml-1 text-xs font-normal text-amber-700">partial</span>}
                  </td>
                </tr>
              ))}
              <tr className="bg-stone-50 font-medium">
                <td className="px-6 py-3">Total</td>
                {QS.map((k) => {
                  const t = colTotal(k);
                  return (
                    <td key={k} className={`px-6 py-3 text-right tabular-nums ${t.notYet ? 'text-stone-400' : ''}`} title={t.notYet ? 'Not yet applicable' : undefined}>
                      {t.notYet ? '—' : fmtCurrency(t.value)}
                      {t.partial && t.value != null && <span className="ml-1 text-xs font-normal text-amber-700">partial</span>}
                    </td>
                  );
                })}
                <td className="px-6 py-3 text-right tabular-nums">
                  {fmtCurrency(grand)}
                  {grandPartial && grand != null && <span className="ml-1 text-xs font-normal text-amber-700">partial</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {doesNotAddUp && (
          <p className="mt-3 text-xs text-rose-700" data-testid="distributions-do-not-add-up">
            The workbook does not add up: some of its printed totals differ from the sum of the figures above them. The workbook&apos;s totals are shown.
          </p>
        )}
        {(anyNotYet || anyMissing) && (
          <p className="mt-3 text-xs text-stone-500" data-testid="distribution-legend">
            {anyNotYet && <>— in {QS.filter((k) => !dv.quarterApplicable[k]).map((k) => k.toUpperCase()).join(', ')}: not yet applicable (the report covers data through its cutoff date). </>}
            {anyMissing && <>— in a quarter that has begun: source value missing; totals marked “partial” leave it out.</>}
          </p>
        )}
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