import React, { useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { parseBvaWorkbook } from '@/lib/bvaParser';
import { validateBva } from '@/lib/bvaValidation';
import { planBvaImport, importTarget, groupMapFromLines } from '@/lib/bvaImport';
import {
  applyCorrections,
  overridesFromCorrections,
  groupMapFromCorrections,
  periodWriteWithCorrections,
  makeCorrection,
  correctionKey,
  WARNING_SOURCE_PATHS,
} from '@/lib/bvaCorrections';
import { periodTransition } from '@/lib/periodTransition';
import { monthStates, isSuperseded, isDiscarded, isRevision, versionLabel } from '../../../base44/shared/periodVersions.ts';
import { fmtCurrency, fmtPct } from '@/lib/finance';
import BvaCorrectionsPanel from '@/components/admin/BvaCorrectionsPanel';
import { SourceValueControl } from '@/components/admin/BvaCorrectionCards';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

// The shared Label is an untyped forwardRef component; this typed wrapper
// states the props passed below so the typecheck verifies them.
/** @param {React.LabelHTMLAttributes<HTMLLabelElement>} props */
const CaptionLabel = (props) => <Label {...props} />;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A missing figure is shown as missing, never as $0.00.
const money = (v) => (v == null ? 'Missing in workbook' : fmtCurrency(v));

// Pace warnings carry percentage points, not dollars.
const warnValue = (w, v) => (v == null ? '—' : w.code === 'pace_proxy_divergence' ? `${Number(v).toFixed(2)}%` : fmtCurrency(v));

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
  const [blockers, setBlockers] = useState([]); // refusals returned by the server-side gate
  const [previous, setPrevious] = useState(null); // latest earlier validated period: what to expect
  const [drafts, setDrafts] = useState([]); // existing draft periods that can be opened and corrected
  const [corrections, setCorrections] = useState([]); // adjustments layer, persisted to the draft
  const [matched, setMatched] = useState(null); // the existing period this import targets (may be null)
  // Draft revisions: the version the admin chose to import into (null: the
  // month's default -- its open revision, or its only editable version).
  const [targetId, setTargetId] = useState(null);
  const [targetInfo, setTargetInfo] = useState(null); // importTarget() result for the confirmed month
  const [savedGroupMap, setSavedGroupMap] = useState({}); // confirmed group mappings from the draft's saved lines
  const [me, setMe] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const lastPersistedRef = useRef('');
  const by = me?.email || me?.full_name || '';

  const addLog = (l) => setLog((x) => [...x, l]);

  const setSaveCorrection = (spec) =>
    setCorrections((prev) => {
      const key = `${spec.kind}:${spec.path || spec.target || ''}`;
      const existing = prev.find((c) => correctionKey(c) === key);
      if (existing) {
        // Original value, id and who-recorded stay stable; only the value /
        // reason / time are refreshed.
        return [
          ...prev.filter((c) => correctionKey(c) !== key),
          { ...existing, value: spec.value, reason: spec.reason, by: spec.by || existing.by, at: new Date().toISOString() },
        ];
      }
      return [...prev, makeCorrection(spec)];
    });

  const removeCorrection = (c) => setCorrections((prev) => prev.filter((x) => correctionKey(x) !== correctionKey(c)));

  // Sign-in identity for the adjustment audit trail.
  useEffect(() => {
    base44.auth.me().then(setMe).catch(() => setMe(null));
  }, []);

  // Existing import drafts that can be opened (and corrected) without
  // re-uploading the workbook.
  useEffect(() => {
    let cancelled = false;
    base44.entities.ReportingPeriod.list('-year', 300).then((all) => {
      if (cancelled) return;
      setDrafts((all || []).filter((p) => p.bva_parsed_source && !p.published && p.bva_import_status !== 'final' && !isSuperseded(p) && !isDiscarded(p) && (!isRevision(p) || p.copy_status === 'verified')));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Read-only: the latest validated BVA period before the target month sets
  // which sections this workbook is expected to contain (watch list,
  // transfers) and which reporting convention it used.
  useEffect(() => {
    if (!parsed || !confirm.month || !confirm.year) {
      setPrevious(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const target = Number(confirm.year) * 12 + Number(confirm.month);
        const periods = await base44.entities.ReportingPeriod.list('-year', 300);
        // One version per month: the current published one, else the latest final one.
        const prior = [...monthStates((periods || []).filter((p) => Number(p.year) * 12 + Number(p.month) < target)).values()]
          .map((st) => st.current || st.working)
          .filter((p) => p && p.bva_import_status === 'final')
          .sort((a, b) => b.year - a.year || b.month - a.month)[0];
        if (!prior) {
          if (!cancelled) setPrevious(null);
          return;
        }
        const [lines, transfers] = await Promise.all([
          base44.entities.BudgetLine.filter({ period_id: prior.id }, undefined, 1000),
          base44.entities.RecurringTransfer.filter({ period_id: prior.id }, undefined, 500),
        ]);
        if (!cancelled) {
          setPrevious({
            label: prior.label,
            month: prior.month,
            year: prior.year,
            cutoffDate: prior.reporting_cutoff_date || null,
            detailCodes: (lines || []).filter((l) => l.bva_detail && l.qb_code).map((l) => String(l.qb_code)),
            transferCount: (transfers || []).length,
          });
        }
      } catch {
        if (!cancelled) setPrevious(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, confirm.month, confirm.year]);

  // The existing period this import targets: its confirmed group mappings feed
  // the validation display, and its persisted corrections are re-attached so
  // they survive refreshes.
  useEffect(() => {
    if (!parsed || !confirm.month || !confirm.year) {
      setMatched(null);
      setSavedGroupMap({});
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const periods = await base44.entities.ReportingPeriod.list('-year', 300);
        const info = importTarget(periods || [], confirm.month, confirm.year, targetId);
        const match = info.target;
        if (cancelled) return;
        setTargetInfo(info);
        setMatched(match);
        if (match) {
          const lines = await base44.entities.BudgetLine.filter({ period_id: match.id }, undefined, 1000);
          if (cancelled) return;
          setSavedGroupMap(groupMapFromLines(lines || []));
          const persisted = Array.isArray(match.bva_corrections) ? match.bva_corrections : [];
          setCorrections(persisted);
          lastPersistedRef.current = JSON.stringify(persisted);
        } else {
          setSavedGroupMap({});
          setCorrections([]);
          lastPersistedRef.current = '';
        }
      } catch {
        if (!cancelled) {
          setMatched(null);
          setSavedGroupMap({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, confirm.month, confirm.year, targetId]);

  // The corrections layer: the original workbook stays untouched; adjusted
  // values are overlaid and every dependent total is recalculated from them.
  const adjusted = useMemo(() => applyCorrections(parsed, corrections), [parsed, corrections]);
  const overrideMap = useMemo(() => overridesFromCorrections(corrections), [corrections]);
  const mergedGroupMap = useMemo(() => ({ ...savedGroupMap, ...groupMapFromCorrections(corrections) }), [savedGroupMap, corrections]);

  const validation = useMemo(() => {
    if (!parsed) return null;
    return validateBva(adjusted, {
      cutoffDate: confirm.cutoffDate || adjusted.meta.cutoffDate,
      period: confirm.month && confirm.year ? { month: confirm.month, year: confirm.year } : null,
      previous,
      overrides: overrideMap,
      groupMap: mergedGroupMap,
    });
  }, [adjusted, confirm.cutoffDate, confirm.month, confirm.year, previous, overrideMap, mergedGroupMap]);

  const onFile = async (f) => {
    setFile(f);
    setApplied(null);
    setLog([]);
    setBlockers([]);
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

  // Open a persisted import draft without the workbook file: its stored
  // (original) parse is restored and its corrections re-attached.
  const openDraft = (p) => {
    setFile(null);
    setApplied({ periodId: p.id, action: 'update', reopened: true });
    setTargetId(p.id);
    setLog([]);
    setBlockers([]);
    setParsed(p.bva_parsed_source);
    setConfirm({ month: p.month, year: p.year, cutoffDate: p.reporting_cutoff_date || '' });
  };

  const apply = async () => {
    if (!adjusted || !validation) return;
    setBusy(true);
    setLog([]);
    try {
      const meNow = me || (await base44.auth.me());
      const existingPeriods = await base44.entities.ReportingPeriod.list('-year', 300);
      // Refuse before any write. The target is the chosen draft revision, or the
      // month's only editable version -- never a published, superseded or
      // discarded one (importTarget). An existing unpublished final version is
      // first reset to draft on the server, so no earlier "final" state can
      // cover re-imported figures. The server refuses the first write (the
      // period record) for a published or superseded period.
      const pre = importTarget(existingPeriods, confirm.month, confirm.year, targetId);
      const match = pre.target;
      if (!pre.allowed) {
        addLog(`✗ ${pre.reason} Nothing was changed.`);
        return;
      }
      if (match) addLog(`Importing into ${versionLabel(match)}.`);
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
        existing = { budgetLines: budgetLines || [], cashAccounts: cashAccounts || [], distributions: distributions || [], transfers: transfers || [] };
      }
      const groupMap = { ...groupMapFromLines(existing.budgetLines), ...groupMapFromCorrections(corrections) };
      const plan = planBvaImport({
        parsed: adjusted,
        validation,
        confirm: {
          ...confirm,
          filename: file?.name || match?.source_filename || undefined,
          importedBy: meNow?.email || meNow?.full_name || '',
        },
        existingPeriods: match ? [match] : [],
        existing,
        groupMap,
      });
      // The stored parsed source stays the ORIGINAL workbook; corrections ride
      // along (and savings entries become period values).
      const periodWrite = periodWriteWithCorrections(plan, parsed, corrections);

      // 1. period
      let periodId = plan.periodId;
      if (plan.action === 'create') {
        // Created on the server as draft + unpublished in one write, verified
        // before success is reported; an existing month is never duplicated.
        addLog('Creating reporting period…');
        const created = await periodTransition('create', null, { data: periodWrite });
        if (!created.ok || !created.period_id) {
          const why = (created.blockers[0] && created.blockers[0].message) || created.error;
          addLog(`✗ The period was not created: ${why}. No budget lines, cash accounts, distributions or transfers were written.`);
          return;
        }
        periodId = created.period_id;
      } else {
        addLog('Updating reporting period…');
        await base44.entities.ReportingPeriod.update(periodId, periodWrite);
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
        addLog(`${name}: +${bucket.toCreate.length} ~${bucket.toUpdate.length} -${bucket.toDelete.length}${bucket.replaced?.length ? ` (${bucket.replaced.length} replaced: a value became missing)` : ''}`);
      }
      lastPersistedRef.current = JSON.stringify(corrections);

      addLog(
        corrections.length
          ? `✓ Import applied as Draft with ${corrections.length} adjustment(s) — workbook preserved, not visible to clients.`
          : '✓ Import applied as Draft (not visible to clients). Review discrepancies below, then finalize.'
      );
      setApplied({ periodId, action: plan.action });
      setMatched(match ? { ...match, bva_corrections: corrections } : { id: periodId, published: false, month: Number(confirm.month), year: Number(confirm.year) });
      setSaveState('saved');
    } catch (e) {
      addLog(`✗ ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Finalize runs on the server: every rule is re-checked there and the period
  // becomes Final (validated, locked) in one write. It is NOT published --
  // publishing is a separate step in Review & Publish. Override reasons come
  // from the persisted corrections, so a failed finalize never loses them.
  const finalize = async () => {
    if (!applied || !validation) return;
    setBusy(true);
    try {
      const res = await periodTransition('finalize', applied.periodId, { overrides: overrideMap });
      if (res.ok) {
        setBlockers([]);
        addLog('✓ Period marked Final (validated). Publish it from Review & Publish when ready.');
        setApplied({ ...applied, finalized: true });
      } else {
        setBlockers(res.blockers);
        addLog(`✗ Not finalized: ${res.blockers.length ? `${res.blockers.length} item(s) must be resolved (listed below)` : res.error}. Corrections and override reasons stay saved on the draft.`);
      }
    } finally {
      setBusy(false);
    }
  };

  // Persist corrections to the draft as they are made (when a draft exists).
  // Before the first Apply they live in the session and ride through Apply.
  // (Defined after apply/finalize so the importer's published-month preflight
  // stays ahead of every entity write in this file — see publicationPaths.)
  const canPersist = !!matched && !matched.published;
  useEffect(() => {
    if (!canPersist) return undefined;
    const json = JSON.stringify(corrections);
    if (json === lastPersistedRef.current) return undefined;
    const t = setTimeout(async () => {
      setSaveState('saving');
      try {
        await base44.entities.ReportingPeriod.update(matched.id, { bva_corrections: corrections });
        lastPersistedRef.current = json;
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [corrections, canPersist, matched]);

  const R = validation?.reconciled;
  const openWarnings = (validation?.warnings || []).filter((w) => w.blocksFinalize);
  const mustFix = openWarnings.filter((w) => w.overridable === false);
  const canFinalize = applied && !applied.finalized && openWarnings.length === 0;
  const SECTION_LABEL = { cash: 'Cash', distributions: 'Distributions', income: 'Income', expenseSummary: 'Expense groups', detail: 'Watch list (DETAIL)', transfers: 'Recurring transfers' };
  const sectionCount = { cash: R?.cash.accounts.length, distributions: R?.distributions.entities.length, income: R?.income.categories.length, expenseSummary: R?.expenses.groups.length, detail: R?.detail.categories.length, transfers: R?.transfers.items.length };
  const unmappedDetail = R ? R.detail.categories.filter((c) => (c.group || 'unassigned') === 'unassigned').length : null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-stone-100 p-2 text-stone-600"><FileSpreadsheet className="h-5 w-5" /></span>
          <div>
            <p className="font-display text-lg">Monthly BVA Workbook</p>
            <p className="text-sm text-stone-500">
              The BVA Excel report is the source of truth for the dashboard. Upload it, confirm the reporting month and
              cutoff date, resolve every validation issue inline, then finalize.
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

        {drafts.length > 0 && (
          <div className="mt-4">
            <CaptionLabel className="text-xs text-stone-500">Or open an existing import draft — corrections and override reasons are restored from it</CaptionLabel>
            <select
              className="mt-1 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
              value=""
              onChange={(e) => {
                const p = drafts.find((d) => d.id === e.target.value);
                if (p) openDraft(p);
              }}
            >
              <option value="">Open a draft period…</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {versionLabel(d)} — draft{d.source_filename ? ` · ${d.source_filename}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

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
              Workbook title: <span className="font-medium">{parsed.meta.titleText || '—'}</span> · sheets:{' '}
              <span className="font-medium">{(parsed.meta.sheetNames || [parsed.meta.sheetName]).join(', ')}</span> · detected cutoff:{' '}
              <span className="font-medium">{parsed.meta.cutoffDate || 'none'}</span>. Confirm above — the period is not
              inferred from the filename.
            </p>
            {targetInfo && confirm.month && confirm.year && (
              <div className={`mt-2 rounded-lg border p-3 text-xs ${targetInfo.allowed ? 'border-stone-200 bg-stone-50 text-stone-600' : 'border-rose-200 bg-rose-50 text-rose-800'}`} data-testid="import-target">
                {!targetInfo.allowed ? (
                  <p>{targetInfo.reason}</p>
                ) : targetInfo.target ? (
                  <>
                    <p>
                      Imports into: <span className="font-medium">{versionLabel(targetInfo.target)}</span>
                      {isRevision(targetInfo.target) ? ' — clients keep seeing the published version until this revision is published.' : ''}
                    </p>
                    {targetInfo.candidates.length > 1 && (
                      <select
                        className="mt-2 w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
                        value={targetInfo.target.id}
                        onChange={(e) => setTargetId(e.target.value)}
                      >
                        {targetInfo.candidates.map((c) => <option key={c.id} value={c.id}>{versionLabel(c)}</option>)}
                      </select>
                    )}
                  </>
                ) : (
                  <p>Creates a new period for this month.</p>
                )}
              </div>
            )}
            {parsed.sections && (
              <div className="mt-3 rounded-xl border border-stone-100 bg-stone-50 p-3 text-xs text-stone-600" data-testid="section-inventory">
                <p className="mb-1 uppercase tracking-[0.12em] text-stone-400">Sections found</p>
                {Object.keys(SECTION_LABEL).map((k) => {
                  const sec = parsed.sections[k] || { status: 'absent' };
                  const where = sec.sheet != null ? `sheet ${sec.sheet + 1}, row ${sec.row}${sec.layout && sec.layout !== 'labelled' ? `, ${sec.layout}` : ''}` : '';
                  return (
                    <div key={k} className="flex justify-between gap-3">
                      <span>{SECTION_LABEL[k]}</span>
                      <span className={sec.status === 'parsed' ? 'text-stone-600' : 'text-rose-700'}>
                        {sec.status === 'parsed' ? `${sectionCount[k] ?? 0} row(s) · ${where}` : `${sec.status}${where ? ` · ${where}` : ''}`}
                      </span>
                    </div>
                  );
                })}
                {(parsed.sections.informational || []).length > 0 && (
                  <p className="mt-1 text-stone-400">
                    Recognized but not imported:{' '}
                    {parsed.sections.informational.map((i) => `${i.type.replace(/_/g, ' ')} (sheet ${i.sheet + 1}, row ${i.row})`).join('; ')}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {parsed && validation && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Extracted &amp; independently validated</p>
            <div className="mt-3 divide-y divide-stone-100">
              <Line label="Elapsed months / expected pace" value={`${validation.elapsedMonths ?? "missing"} / ${validation.elapsedMonths == null ? "—" : fmtPct(validation.pacePct * 100)}`} />
              <Line label="Total Cash" value={money(R.cash.total)} />
              <Line label="YTD Income" value={money(R.income.actualTotal)} />
              <Line label="Annual Budgeted Income" value={money(R.income.budgetTotal)} sub={R.income.workbookBudgetTotal != null && R.income.workbookBudgetTotal !== R.income.budgetTotal ? `workbook ${money(R.income.workbookBudgetTotal)}` : ''} />
              <Line label="YTD Expenses" value={money(R.expenses.actualTotal)} />
              <Line label="Annual Budgeted Expenses" value={money(R.expenses.budgetTotal)} />
              <Line label="Overall variance to expected pace" value={`${money(R.expenses.overall.varianceToPace)} (${R.expenses.overall.variancePct == null ? "—" : fmtPct(R.expenses.overall.variancePct * 100)})`} />
              <Line
                label="Distributions YTD (calculated from quarterly distributions)"
                value={money(R.distributions.entitySum)}
                sub={R.distributions.workbookReportedTotal != null && !R.distributions.reconciled ? `workbook displayed ${money(R.distributions.workbookReportedTotal)}` : ''}
              />
              <Line label="Recurring transfers total" value={money(R.transfers.total)} />
              <Line
                label="Monitored detail categories"
                value={R.detail.categories.length}
                sub={unmappedDetail ? `${unmappedDetail} need group mapping` : 'all group-mapped'}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Validation discrepancies</p>
            {validation.warnings.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> No discrepancies — every reconciliation passed.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {validation.warnings.map((w) => {
                  const srcPath = WARNING_SOURCE_PATHS[w.code] || null;
                  const srcCorrection = srcPath ? corrections.find((c) => c.kind === 'source' && c.path === srcPath) : null;
                  const ovrCorrection = corrections.find((c) => c.kind === 'override' && c.target === w.code);
                  return (
                    <div key={w.code} className={`rounded-xl border p-3 text-sm ${w.blocksFinalize ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}>
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <div className="min-w-0">
                          <p className="font-medium">{w.code}</p>
                          <p className="text-stone-600">{w.message}</p>
                          {w.sourceValue != null && (
                            <p className="mt-1 text-xs tabular-nums text-stone-500">
                              workbook {warnValue(w, w.sourceValue)} · calculated {warnValue(w, w.calculatedValue)}
                              {w.difference != null && w.code !== 'pace_proxy_divergence' ? ` · Δ ${fmtCurrency(w.difference)}` : ''}
                            </p>
                          )}
                          {w.blocksFinalize && w.overridable === false && (
                            <p className="mt-2 text-xs font-medium text-rose-700">Must be corrected before finalizing — this cannot be overridden.</p>
                          )}
                          {srcPath && (
                            <SourceValueControl
                              warning={{ ...w, sourcePath: srcPath }}
                              correction={srcCorrection}
                              onSave={setSaveCorrection}
                              onRemove={removeCorrection}
                              by={by}
                            />
                          )}
                          {w.blocksFinalize && w.overridable !== false && !srcCorrection && (
                            <div className="mt-2">
                              <Input
                                placeholder="Override reason (required to finalize; saved to the draft)"
                                className="h-8 text-xs"
                                key={`ovr-${w.code}-${ovrCorrection ? ovrCorrection.at : 'none'}`}
                                defaultValue={ovrCorrection ? ovrCorrection.reason : ''}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v) {
                                    setSaveCorrection({ kind: 'override', target: w.code, originalValue: null, value: null, reason: v, by });
                                  } else if (ovrCorrection) {
                                    removeCorrection(ovrCorrection);
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {parsed && validation && (
        <BvaCorrectionsPanel
          validation={validation}
          parsed={parsed}
          corrections={corrections}
          onSave={setSaveCorrection}
          onRemove={removeCorrection}
          savedGroupMap={savedGroupMap}
          cutoffDate={confirm.cutoffDate}
          saveState={saveState}
          by={by}
        />
      )}

      {parsed && (
        <div className="flex flex-wrap items-center gap-3">
          <Button className="rounded-full" disabled={busy || !confirm.month || !confirm.year || !confirm.cutoffDate} onClick={apply}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {applied ? 'Re-apply import (writes corrections to the draft)' : 'Apply import (Draft)'}
          </Button>
          {applied && !applied.finalized && (
            <Button variant="outline" className="rounded-full" disabled={busy || !canFinalize} onClick={finalize}>
              Mark Final (validated)
            </Button>
          )}
          {applied && !applied.finalized && openWarnings.length > 0 && (
            <span className="text-xs text-rose-700">
              {mustFix.length > 0
                ? `${mustFix.length} issue(s) must be resolved before finalizing.`
                : `${openWarnings.length} reconciliation(s) still open before finalizing.`}
            </span>
          )}
          {applied?.finalized && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Final</span>}
        </div>
      )}

      {blockers.length > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
          <p className="mb-2 text-xs uppercase tracking-[0.12em] text-rose-700">Finalization blocked by the server</p>
          <div className="space-y-3 text-sm">
            {blockers.map((b) => {
              const ovrCorrection = corrections.find((c) => c.kind === 'override' && c.target === b.code);
              return (
                <div key={b.code}>
                  <p className="text-stone-700">{b.message}</p>
                  {b.overridable && (
                    <Input
                      placeholder="Override reason (required; saved to the draft)"
                      className="mt-1 h-8 text-xs"
                      key={`blk-${b.code}-${ovrCorrection ? ovrCorrection.at : 'none'}`}
                      defaultValue={ovrCorrection ? ovrCorrection.reason : ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v) {
                          setSaveCorrection({ kind: 'override', target: b.code, originalValue: null, value: null, reason: v, by });
                        } else if (ovrCorrection) {
                          removeCorrection(ovrCorrection);
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
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