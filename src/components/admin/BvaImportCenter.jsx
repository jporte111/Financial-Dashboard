import React, { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { parseBvaWorkbook } from '@/lib/bvaParser';
import { validateBva } from '@/lib/bvaValidation';
import { planBvaImport, importPreflight, groupMapFromLines } from '@/lib/bvaImport';
import { periodTransition } from '@/lib/periodTransition';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Line({ label, value, sub = null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="tabular-nums">{value}{sub ? <span className="ml-2 text-xs text-stone-400">{sub}</span> : null}</span>
    </div>
  );
}

export default function BvaImportCenter() {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [confirm, setConfirm] = useState({ month: '', year: '', cutoffDate: '' });
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [applied, setApplied] = useState(null); // { periodId }
  const [overrides, setOverrides] = useState({});
  const [blockers, setBlockers] = useState([]); // refusals returned by the server-side gate

  const addLog = (l) => setLog((x) => [...x, l]);

  const validation = useMemo(() => {
    if (!parsed) return null;
    return validateBva(parsed, { cutoffDate: confirm.cutoffDate || parsed.meta.cutoffDate });
  }, [parsed, confirm.cutoffDate]);

  const onFile = async (f) => {
    setFile(f);
    setApplied(null);
    setLog([]);
    const buf = await f.arrayBuffer();
    const p = parseBvaWorkbook(buf);
    setParsed(p);
    const cd = p.meta.cutoffDate ? new Date(p.meta.cutoffDate) : null;
    setConfirm({
      month: p.meta.suggestedMonth || (cd ? cd.getUTCMonth() + 1 : ''),
      year: p.meta.suggestedYear || (cd ? cd.getUTCFullYear() : ''),
      cutoffDate: p.meta.cutoffDate || '',
    });
  };

  const apply = async () => {
    if (!parsed || !validation) return;
    setBusy(true);
    setLog([]);
    try {
      const me = await base44.auth.me();
      const existingPeriods = await base44.entities.ReportingPeriod.list('-year', 300);
      const match = existingPeriods.find(
        (p) => Number(p.month) === Number(confirm.month) && Number(p.year) === Number(confirm.year)
      );
      // Refuse before any write: published months are read-only until draft
      // revisions exist; an existing unpublished month is first reset to draft
      // on the server, so no earlier "final" state can cover re-imported figures.
      const pre = importPreflight(match);
      if (!pre.allowed) {
        addLog(`✗ ${pre.reason} Nothing was changed.`);
        return;
      }
      if (pre.needsInvalidate) {
        const inv = await periodTransition('invalidate', match.id);
        if (!inv.ok) {
          addLog(`✗ Import refused by the server: ${(inv.blockers[0] && inv.blockers[0].message) || inv.error}. Nothing was changed.`);
          return;
        }
      }
      let existing = { budgetLines: [], cashAccounts: [], distributions: [], transfers: [] };
      if (match) {
        addLog(`Existing ${MONTHS[confirm.month - 1]} ${confirm.year} period found (not published) — updating the draft in place.`);
        const [budgetLines, cashAccounts, distributions, transfers] = await Promise.all([
          base44.entities.BudgetLine.filter({ period_id: match.id }, undefined, 1000),
          base44.entities.CashAccount.filter({ period_id: match.id }, undefined, 500),
          base44.entities.Distribution.filter({ period_id: match.id }, undefined, 500),
          base44.entities.RecurringTransfer.filter({ period_id: match.id }, undefined, 500),
        ]);
        existing = { budgetLines, cashAccounts, distributions, transfers };
      }
      const groupMap = groupMapFromLines(existing.budgetLines);
      const plan = planBvaImport({
        parsed,
        validation,
        confirm: { ...confirm, filename: file?.name, importedBy: me?.email || me?.full_name || '' },
        existingPeriods,
        existing,
        groupMap,
      });

      // 1. period
      let periodId = plan.periodId;
      if (plan.action === 'create') {
        addLog('Creating reporting period…');
        const created = await base44.entities.ReportingPeriod.create(plan.periodData);
        periodId = created.id;
      } else {
        addLog('Updating reporting period…');
        await base44.entities.ReportingPeriod.update(periodId, plan.periodData);
      }

      // 2. child entities
      for (const [name, entity] of [
        ['BudgetLine', 'BudgetLine'],
        ['CashAccount', 'CashAccount'],
        ['Distribution', 'Distribution'],
        ['RecurringTransfer', 'RecurringTransfer'],
      ]) {
        const key = { BudgetLine: 'budgetLines', CashAccount: 'cashAccounts', Distribution: 'distributions', RecurringTransfer: 'transfers' }[name];
        const bucket = plan[key];
        if (bucket.toCreate.length) {
          await base44.entities[entity].bulkCreate(bucket.toCreate.map((d) => ({ ...d, period_id: periodId })));
        }
        for (const u of bucket.toUpdate) await base44.entities[entity].update(u.id, u.data);
        for (const id of bucket.toDelete) await base44.entities[entity].delete(id);
        addLog(`${name}: +${bucket.toCreate.length} ~${bucket.toUpdate.length} -${bucket.toDelete.length}`);
      }

      addLog('✓ Import applied as Draft (not visible to clients). Review discrepancies below, then finalize.');
      setApplied({ periodId, action: plan.action });
    } catch (e) {
      addLog(`✗ ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Finalize runs on the server: every rule is re-checked there and the period
  // becomes Final (validated, locked) in one write. It is NOT published --
  // publishing is a separate step in Review & Publish.
  const finalize = async () => {
    if (!applied || !validation) return;
    setBusy(true);
    try {
      const res = await periodTransition('finalize', applied.periodId, { overrides });
      if (res.ok) {
        setBlockers([]);
        addLog('✓ Period marked Final (validated). Publish it from Review & Publish when ready.');
        setApplied({ ...applied, finalized: true });
      } else {
        setBlockers(res.blockers);
        addLog(`✗ Not finalized: ${res.blockers.length ? `${res.blockers.length} item(s) must be resolved (listed below)` : res.error}. Nothing was changed.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const R = validation?.reconciled;
  const openWarnings = (validation?.warnings || []).filter((w) => w.blocksFinalize && !overrides[w.code]);
  const canFinalize = applied && !applied.finalized && openWarnings.length === 0;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-stone-100 p-2 text-stone-600"><FileSpreadsheet className="h-5 w-5" /></span>
          <div>
            <p className="font-display text-lg">Monthly BVA Workbook</p>
            <p className="text-sm text-stone-500">
              The BVA Excel report is the source of truth for the dashboard. Upload it, confirm the reporting month and
              cutoff date, review the independent validation, then finalize.
            </p>
          </div>
        </div>

        <input
          type="file"
          accept=".xlsx"
          className="mt-4 text-xs text-stone-500 file:mr-3 file:rounded-full file:border-0 file:bg-stone-900 file:px-4 file:py-2 file:text-white file:cursor-pointer"
          onChange={(e) => e.target.files[0] && onFile(e.target.files[0])}
        />
        {file && <p className="mt-2 text-xs text-stone-500">Selected: {file.name}</p>}

        {parsed && (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <Label className="text-xs text-stone-500">Reporting month</Label>
                <select
                  className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
                  value={confirm.month}
                  onChange={(e) => setConfirm({ ...confirm, month: Number(e.target.value) })}
                >
                  <option value="">—</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs text-stone-500">Reporting year</Label>
                <Input type="number" className="mt-1" value={confirm.year} onChange={(e) => setConfirm({ ...confirm, year: Number(e.target.value) })} />
              </div>
              <div>
                <Label className="text-xs text-stone-500">Reporting cutoff date</Label>
                <Input type="date" className="mt-1" value={confirm.cutoffDate} onChange={(e) => setConfirm({ ...confirm, cutoffDate: e.target.value })} />
              </div>
            </div>
            <p className="mt-2 text-xs text-stone-400">
              Workbook title: <span className="font-medium">{parsed.meta.titleText || '—'}</span> · sheet tab:{' '}
              <span className="font-medium">{parsed.meta.sheetName}</span> · detected cutoff:{' '}
              <span className="font-medium">{parsed.meta.cutoffDate || 'none'}</span>. Confirm above — the period is not
              inferred from the filename.
            </p>
          </>
        )}
      </div>

      {parsed && validation && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Extracted &amp; independently validated</p>
            <div className="mt-3 divide-y divide-stone-100">
              <Line label="Elapsed months / expected pace" value={`${validation.elapsedMonths} / ${fmtPct(validation.pacePct * 100)}`} />
              <Line label="Total Cash" value={fmtCurrency(R.cash.total)} />
              <Line label="YTD Income" value={fmtCurrency(R.income.actualTotal)} />
              <Line label="Annual Budgeted Income" value={fmtCurrency(R.income.budgetTotal)} sub={R.income.workbookBudgetTotal != null && R.income.workbookBudgetTotal !== R.income.budgetTotal ? `workbook ${fmtCurrency(R.income.workbookBudgetTotal)}` : ''} />
              <Line label="YTD Expenses" value={fmtCurrency(R.expenses.actualTotal)} />
              <Line label="Annual Budgeted Expenses" value={fmtCurrency(R.expenses.budgetTotal)} />
              <Line label="Overall variance to expected pace" value={`${fmtCurrency(R.expenses.overall.varianceToPace)} (${fmtPct(R.expenses.overall.variancePct * 100)})`} />
              <Line
                label="Distributions YTD (calculated from quarterly distributions)"
                value={fmtCurrency(R.distributions.entitySum)}
                sub={R.distributions.workbookReportedTotal != null && !R.distributions.reconciled ? `workbook displayed ${fmtCurrency(R.distributions.workbookReportedTotal)}` : ''}
              />
              <Line label="Recurring transfers total" value={fmtCurrency(R.transfers.total)} />
              <Line
                label="Monitored detail categories"
                value={R.detail.categories.length}
                sub={`${R.detail.categories.filter((c) => (c.group || 'unassigned') === 'unassigned').length} need group mapping`}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Validation discrepancies</p>
            {validation.warnings.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> No discrepancies — every reconciliation passed.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {validation.warnings.map((w) => (
                  <div key={w.code} className={`rounded-xl border p-3 text-sm ${w.blocksFinalize && !overrides[w.code] ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <div className="min-w-0">
                        <p className="font-medium">{w.code}</p>
                        <p className="text-stone-600">{w.message}</p>
                        {w.sourceValue != null && (
                          <p className="mt-1 text-xs tabular-nums text-stone-500">
                            workbook {fmtCurrency(w.sourceValue)} · calculated {fmtCurrency(w.calculatedValue)} · Δ {fmtCurrency(w.difference)}
                          </p>
                        )}
                        {w.blocksFinalize && (
                          <div className="mt-2">
                            <Input
                              placeholder="Override reason (required to finalize)"
                              className="h-8 text-xs"
                              value={overrides[w.code]?.reason || ''}
                              onChange={(e) =>
                                setOverrides((o) => ({
                                  ...o,
                                  [w.code]: e.target.value ? { reason: e.target.value, at: new Date().toISOString() } : undefined,
                                }))
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {parsed && (
        <div className="flex flex-wrap items-center gap-3">
          <Button className="rounded-full" disabled={busy || !confirm.month || !confirm.year || !confirm.cutoffDate} onClick={apply}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {applied ? 'Re-apply import' : 'Apply import (Draft)'}
          </Button>
          {applied && !applied.finalized && (
            <Button variant="outline" className="rounded-full" disabled={busy || !canFinalize} onClick={finalize}>
              Mark Final (validated)
            </Button>
          )}
          {applied && !applied.finalized && openWarnings.length > 0 && (
            <span className="text-xs text-rose-700">{openWarnings.length} reconciliation(s) need an override reason before finalizing.</span>
          )}
          {applied?.finalized && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Final</span>}
        </div>
      )}

      {blockers.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
          <p className="mb-2 text-xs uppercase tracking-[0.12em] text-rose-700">Finalization blocked by the server</p>
          <div className="space-y-3 text-sm">
            {blockers.map((b) => (
              <div key={b.code}>
                <p className="text-stone-700">{b.message}</p>
                {b.overridable && (
                  <Input
                    placeholder={b.code.startsWith('detail_unassigned:') ? 'Exclusion reason (documented; required)' : 'Override reason (required)'}
                    className="mt-1 h-8 text-xs"
                    value={overrides[b.code]?.reason || ''}
                    onChange={(e) => setOverrides((o) => ({ ...o, [b.code]: e.target.value ? { reason: e.target.value } : undefined }))}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-5">
          <p className="mb-2 text-xs uppercase tracking-[0.12em] text-stone-400">Import log</p>
          <div className="space-y-1 font-mono text-xs text-stone-600">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      )}
    </div>
  );
}
