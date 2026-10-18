import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePeriodContext } from '@/lib/usePeriod';
import { parseDetailWorkbook } from '@/lib/detailWorkbook';
import { periodTransition } from '@/lib/periodTransition';
import { fmtCurrency } from '@/lib/finance';
import {
  readDetailReport, validateDetailReport, buildDetailRows, reconcileDetail, chunkRows, validationPackage, normPath, plainAccountName,
} from '../../../base44/shared/detailReport.ts';
import { attachRefusal } from '../../../base44/shared/detailServer.ts';
import { plainLabel } from '../../../base44/shared/periodVersions.ts';
import { reportName } from '@/lib/periodState';
import { StateChip } from '@/components/ContextBar';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

// Phase 5b: attach the QuickBooks Transaction Report (Excel) to the selected
// report version as drill-down detail. Nothing is written until "Attach"; the
// server checks everything again and switches the version to the new detail
// in one step. The BVA figures are never changed by this.
const usd = (c) => (c == null ? '—' : fmtCurrency(c / 100));
const STATUS = { reconciled: ['Reconciled', 'text-emerald-700'], difference: ['Differs', 'text-amber-700'], no_detail: ['No transactions', 'text-stone-500'], bva_missing: ['Report figure missing', 'text-stone-500'] };
const sha256 = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');

export default function TransactionDetailImport() {
  const { period, reload } = usePeriodContext();
  const [file, setFile] = useState(null); // { name, sha256 }
  const [model, setModel] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [maps, setMaps] = useState(null);
  const [lines, setLines] = useState(null);
  const [names, setNames] = useState({}); // path -> plain name being confirmed
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const loadMaps = async () => setMaps(new Map(((await base44.entities.DetailAccountMap.list('-created_date', 5000)) || []).map((m) => [normPath(m.account_path), m.plain_name])));
  useEffect(() => { loadMaps().catch(() => setMaps(new Map())); }, []);
  useEffect(() => {
    setLines(null); setResult(null);
    if (!period?.id) return;
    base44.entities.BudgetLine.filter({ period_id: period.id }, undefined, 5000).then((l) => setLines(l || [])).catch(() => setLines([]));
  }, [period?.id]);

  const refusal = attachRefusal(period);
  const read = useMemo(() => (model ? readDetailReport(model) : null), [model]);
  const checks = useMemo(() => (read ? validateDetailReport(read) : null), [read]);
  const built = useMemo(() => (read && period && maps ? buildDetailRows(read, { cutoff: period.reporting_cutoff_date, year: period.year }, maps) : null), [read, period, maps]);
  const rec = useMemo(() => (built && lines ? reconcileDetail(built.rows, lines) : null), [built, lines]);

  const onFile = async (f) => {
    setModel(null); setParseError(null); setResult(null); setFile(null);
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      setFile({ name: f.name, sha256: await sha256(buf) });
      setModel(await parseDetailWorkbook(buf));
    } catch (e) {
      setParseError(e?.message || 'The file could not be read as an Excel workbook.');
    }
  };

  const confirm = async (path) => {
    const plain = (names[path] ?? plainAccountName(path)).trim();
    if (!plain) return;
    setBusy(true);
    try {
      const me = await base44.auth.me().catch(() => null);
      await base44.entities.DetailAccountMap.create({ account_path: path, plain_name: plain, confirmed_by: me?.email || 'admin', confirmed_at: new Date().toISOString() });
      await loadMaps();
    } finally { setBusy(false); }
  };

  const attach = async () => {
    if (!built || !checks?.ok || refusal) return;
    setBusy(true); setResult(null);
    const importId = `${Date.now()}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
    try {
      const parts = chunkRows(built.rows);
      for (let seq = 0; seq < parts.length; seq++) {
        setProgress(`Uploading ${seq + 1} of ${parts.length}…`);
        const s = await periodTransition('stage_detail', period.id, { import_id: importId, seq, rows: parts[seq] });
        if (!s.ok) { setResult({ ok: false, text: (s.blockers[0] && s.blockers[0].message) || s.error }); return; }
      }
      setProgress('Checking and attaching…');
      const c = await periodTransition('commit_detail', period.id, { import_id: importId, package: validationPackage(model), file });
      if (!c.ok) {
        const failed = (c.checks || []).filter((x) => !x.ok).map((x) => x.message).join(' ');
        setResult({ ok: false, text: `${(c.blockers[0] && c.blockers[0].message) || c.error}${failed ? ` ${failed}` : ''} Nothing was attached.` });
        return;
      }
      setResult({ ok: true, text: `Attached ${c.detail_import.rows_stored} transactions to ${plainLabel(period)}.` });
      reload?.();
    } finally { setBusy(false); setProgress(null); }
  };

  if (!period) return <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm text-stone-500">Select a report first.</div>;
  const di = period.detail_import?.status === 'attached' ? period.detail_import : null;

  return (
    <div className="space-y-5" data-testid="detail-import">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <p className="flex flex-wrap items-center gap-2 font-display text-lg">Transaction Detail — {period.label} <StateChip period={period} /></p>
        <p className="mt-1 text-sm text-stone-600">
          Attach the QuickBooks <span className="font-medium">Transaction Report</span> (exported to Excel) to this report as drill-down detail.
          The report figures stay exactly as the BVA has them; differences are shown as warnings and never block publishing.
        </p>
        {di && (
          <p className="mt-3 text-sm text-stone-700" data-testid="detail-attached">
            Attached: {di.file_name || 'transaction report'} · {di.rows_stored} transactions through {di.cutoff} · {di.basis || ''} {di.run_at ? `· run ${di.run_at}` : ''} · by {di.attached_by}
          </p>
        )}
        {refusal && <p className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700" data-testid="detail-refusal">{refusal.message}</p>}
        <input type="file" accept=".xlsx" className="mt-4 block text-sm" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} data-testid="detail-file" />
        {parseError && <p className="mt-2 text-sm text-rose-700">{parseError}</p>}
      </div>

      {checks && (
        <div className="rounded-2xl border border-stone-200 bg-white p-6 text-sm" data-testid="detail-checks">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Checks before anything is stored</p>
          <ul className="mt-2 space-y-1">
            {checks.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2" data-testid={`detail-check-${c.key}`} data-ok={c.ok ? 'yes' : 'no'}>
                {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />}
                <span className={c.ok ? 'text-stone-700' : 'text-rose-800'}>{c.message}</span>
              </li>
            ))}
          </ul>
          {!checks.ok && <p className="mt-3 font-medium text-rose-800">This file cannot be attached until it passes every check. Export the report from QuickBooks again without editing it.</p>}
          {built?.issues?.length > 0 && <p className="mt-3 text-rose-800">{built.issues.join(' ')}</p>}
        </div>
      )}

      {checks?.ok && built && rec && (
        <>
          <div className="rounded-2xl border border-stone-200 bg-white p-6 text-sm" data-testid="detail-summary">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">What would be attached</p>
            <p className="mt-2 text-stone-700">
              {read.transactions.length} transactions in the report ({read.meta.period}, {read.meta.basis || 'basis not stated'}).
              {' '}<span className="font-medium">{built.rows.length}</span> through the cutoff ({period.reporting_cutoff_date}) would be stored;
              {' '}<span data-testid="detail-after-cutoff">{built.after.count} dated later ({usd(built.after.cents)}) are counted here only and not stored</span>.
              {' '}{built.rows.filter((r) => r.a < 0).length} credits/refunds kept as negative amounts.
            </p>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-6 text-sm" data-testid="detail-reconciliation-table">
            <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Reconciliation with the report (the report figure is always used)</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[560px] tabular-nums">
                <thead><tr className="text-left text-xs text-stone-500"><th className="py-1 pr-3">Line</th><th className="pr-3 text-right">Report</th><th className="pr-3 text-right">Detail</th><th className="pr-3 text-right">Difference</th><th>Status</th></tr></thead>
                <tbody>
                  {rec.lines.map((e) => (
                    <tr key={e.key} className="border-t border-stone-100" data-testid={`detail-line-${e.key}`} data-status={e.status}>
                      <td className="py-1.5 pr-3">{e.label}{e.kind === 'watch' && e.status !== 'reconciled' ? <span className="block text-xs text-stone-400">transactions hidden from the client</span> : null}</td>
                      <td className="pr-3 text-right">{usd(e.bva_total)}</td>
                      <td className="pr-3 text-right">{usd(e.detail_total)}</td>
                      <td className="pr-3 text-right">{usd(e.difference)}</td>
                      <td className={STATUS[e.status]?.[1]}>{STATUS[e.status]?.[0]}{e.withheld ? ` · ${e.withheld} unconfirmed` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rec.unmapped.count > 0 && (
              <p className="mt-3 text-stone-600" data-testid="detail-unmapped">
                {rec.unmapped.count} transaction(s) ({usd(rec.unmapped.cents)}) are outside the three cost groups — {rec.unmapped.accounts.map((a) => a.path).join(', ')}. They are kept internal and never shown to the client.
              </p>
            )}
          </div>

          {rec.unconfirmed.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm" data-testid="detail-unconfirmed">
              <p className="font-medium text-stone-800">Accounts without their own number ({rec.unconfirmed.length})</p>
              <p className="mt-1 text-stone-600">Their transactions count toward their cost group but are not shown to the client, and count toward no watch-list line, until you confirm the account. Confirmations apply when you attach.</p>
              <ul className="mt-3 space-y-2">
                {rec.unconfirmed.map((u) => (
                  <li key={u.path} className="rounded-xl border border-amber-200 bg-white p-3">
                    <p className="break-words text-stone-700">{u.path} <span className="text-stone-400">· {u.count} · {usd(u.cents)}</span></p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input className="h-8 min-w-[12rem] flex-1 rounded-md border border-stone-200 px-2 text-xs" aria-label="Plain name shown to the client" value={names[u.path] ?? plainAccountName(u.path)} onChange={(e) => setNames((n) => ({ ...n, [u.path]: e.target.value }))} />
                      <button type="button" className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-medium hover:bg-stone-100 disabled:opacity-50" disabled={busy} onClick={() => confirm(u.path)}>Confirm</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="rounded-full bg-stone-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !!refusal || built.issues.length > 0} onClick={attach} data-testid="detail-attach">
              {busy ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}{di ? `Replace the detail attached to ${reportName(period)}` : `Attach to ${reportName(period)}`}
            </button>
            {progress && <span className="text-sm text-stone-500">{progress}</span>}
          </div>
        </>
      )}
      {result && <p className={`rounded-xl border p-3 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-800'}`} data-testid="detail-result">{result.text}</p>}
    </div>
  );
}
