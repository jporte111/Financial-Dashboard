import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { validateBva } from '@/lib/bvaValidation';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import { ChevronDown } from 'lucide-react';

// Admin review of every BVA import: source file, reporting period, import
// status, extracted vs independently calculated values, discrepancies,
// unverified mappings, overrides + reasons, and who finalized it and when.
export default function BvaReview() {
  const [periods, setPeriods] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [lines, setLines] = useState({}); // periodId -> BudgetLine[]

  useEffect(() => {
    base44.entities.ReportingPeriod.list('-year', 300).then((all) => {
      setPeriods(all.filter((p) => p.bva_parsed_source || p.source_filename || (p.bva_validation_warnings || []).length));
    });
  }, []);

  const toggle = async (p) => {
    const next = openId === p.id ? null : p.id;
    setOpenId(next);
    if (next && !lines[p.id]) {
      const bl = await base44.entities.BudgetLine.filter({ period_id: p.id }, undefined, 1000);
      setLines((m) => ({ ...m, [p.id]: bl }));
    }
  };

  if (periods == null) return <p className="py-8 text-sm text-stone-400">Loading…</p>;
  if (!periods.length)
    return <p className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">No BVA imports yet.</p>;

  return (
    <div className="space-y-3">
      {periods.map((p) => (
        <BvaReviewRow key={p.id} period={p} open={openId === p.id} onToggle={() => toggle(p)} budgetLines={lines[p.id]} />
      ))}
    </div>
  );
}

function BvaReviewRow({ period, open, onToggle, budgetLines }) {
  const validation = useMemo(() => {
    if (!period.bva_parsed_source) return null;
    return validateBva(period.bva_parsed_source, {
      cutoffDate: period.reporting_cutoff_date || period.end_date,
      overrides: period.bva_overrides || {},
    });
  }, [period]);

  const warnings = period.bva_validation_warnings || validation?.warnings || [];
  const overrides = period.bva_overrides || {};
  const unverifiedMappings = (budgetLines || []).filter((l) => l.bva_detail && !l.group_confirmed);
  const R = validation?.reconciled;

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <button onClick={onToggle} className="flex w-full items-center justify-between px-6 py-4 text-left">
        <div>
          <p className="font-medium">
            {period.label}
            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${period.bva_import_status === 'final' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              {period.bva_import_status === 'final' ? 'Final' : 'Draft'}
            </span>
          </p>
          <p className="text-xs text-stone-500">
            {period.source_filename || '—'} · cutoff {period.reporting_cutoff_date || '—'} · imported{' '}
            {period.imported_at ? new Date(period.imported_at).toLocaleString() : '—'}
            {period.imported_by ? ` by ${period.imported_by}` : ''}
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 text-stone-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-stone-100 px-6 py-5 text-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source file" value={period.source_filename || '—'} />
            <Field label="Reporting period" value={`${period.label} · through ${period.reporting_cutoff_date || period.end_date || '—'}`} />
            <Field label="Import status" value={period.bva_import_status || 'draft'} />
            <Field label="Imported by / at" value={`${period.imported_by || '—'} · ${period.imported_at ? new Date(period.imported_at).toLocaleString() : '—'}`} />
            <Field label="Finalized by / at" value={period.finalized_at ? `${period.finalized_by || '—'} · ${new Date(period.finalized_at).toLocaleString()}` : 'Not finalized'} />
            <Field label="Elapsed months / pace" value={validation ? `${validation.elapsedMonths} / ${fmtPct(validation.pacePct * 100)}` : '—'} />
          </div>

          {R && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-[0.12em] text-stone-400">Extracted vs calculated</p>
              <div className="overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-xs uppercase tracking-[0.1em] text-stone-400">
                    <tr>
                      <th className="px-4 py-2 text-left font-normal">Figure</th>
                      <th className="px-4 py-2 text-right font-normal">Workbook</th>
                      <th className="px-4 py-2 text-right font-normal">Calculated</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ReconRow label="Total Cash" src={period.bva_parsed_source?.cash?.reportedTotal} calc={R.cash.total} />
                    <ReconRow label="YTD Income" src={period.bva_parsed_source?.income?.reportedActualTotal} calc={R.income.actualTotal} />
                    <ReconRow label="Annual Budgeted Income" src={R.income.workbookBudgetTotal} calc={R.income.budgetTotal} />
                    <ReconRow label="YTD Expenses" src={period.bva_parsed_source?.expenseSummary?.reportedActualTotal} calc={R.expenses.actualTotal} />
                    <ReconRow label="Annual Budgeted Expenses" src={period.bva_parsed_source?.expenseSummary?.reportedBudgetTotal} calc={R.expenses.budgetTotal} />
                    <ReconRow label="Overall pace variance" src={period.bva_parsed_source?.expenseSummary?.reportedVarianceAmount} calc={R.expenses.overall.varianceToPace} />
                    <ReconRow label="Distributions YTD" src={R.distributions.workbookReportedTotal} calc={R.distributions.entitySum} note="calculated entity-quarter total is authoritative; workbook total is audit-only" />
                    <ReconRow label="Recurring transfers" src={period.bva_parsed_source?.transfers?.reportedTotal} calc={R.transfers.total} />
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.12em] text-stone-400">Discrepancies &amp; overrides</p>
            {warnings.length === 0 ? (
              <p className="text-emerald-700">No discrepancies recorded.</p>
            ) : (
              <div className="space-y-2">
                {warnings.map((w) => {
                  const ov = overrides[w.code] || (w.overridden ? w.override : null);
                  return (
                    <div key={w.code} className="rounded-xl border border-stone-200 p-3">
                      <p className="font-medium">{w.code} {ov ? <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">overridden</span> : w.blocksFinalize ? <span className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700">blocks finalize</span> : null}</p>
                      <p className="text-stone-600">{w.message}</p>
                      {w.sourceValue != null && (
                        <p className="text-xs tabular-nums text-stone-500">workbook {fmtCurrency(w.sourceValue)} · calculated {fmtCurrency(w.calculatedValue)}</p>
                      )}
                      {ov && <p className="mt-1 text-xs text-stone-500">Override: “{ov.reason}”{ov.by ? ` — ${ov.by}` : ''}{ov.at ? ` (${new Date(ov.at).toLocaleString()})` : ''}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.12em] text-stone-400">Group mapping required</p>
            {!budgetLines ? (
              <p className="text-stone-400">Loading…</p>
            ) : unverifiedMappings.length === 0 ? (
              <p className="text-emerald-700">All monitored categories are mapped to a confirmed group.</p>
            ) : (
              <ul className="list-inside list-disc text-stone-600">
                {unverifiedMappings.map((l) => (
                  <li key={l.id}>
                    {l.qb_code ? `${l.qb_code} · ` : ''}{l.category} — Unassigned; confirm Fixed / Variable / Discretionary
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-stone-400">
              &ldquo;Savings / Distributions In&rdquo; and &ldquo;Expenses Paid From Savings&rdquo; are not in the BVA workbook; they remain
              manually entered and are flagged for Admin review.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.12em] text-stone-400">{label}</p>
      <p className="mt-0.5">{value}</p>
    </div>
  );
}

function ReconRow({ label, src, calc, note = null }) {
  const mismatch = src != null && calc != null && Math.round(src * 100) !== Math.round(calc * 100);
  return (
    <tr className="border-t border-stone-100">
      <td className="px-4 py-2">{label}{note ? <span className="ml-2 text-xs text-stone-400">{note}</span> : null}</td>
      <td className="px-4 py-2 text-right tabular-nums">{src == null ? '—' : fmtCurrency(src)}</td>
      <td className={`px-4 py-2 text-right tabular-nums ${mismatch ? 'text-rose-700' : ''}`}>{calc == null ? '—' : fmtCurrency(calc)}</td>
    </tr>
  );
}
