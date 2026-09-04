import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { parseBudgetCsv, parseTransactionXlsx } from '@/lib/importParsers';
import { fmtCurrency } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { FileSpreadsheet, FileUp, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

export default function ImportCenter() {
  const [budgetFile, setBudgetFile] = useState(null);
  const [budgetPreview, setBudgetPreview] = useState(null);
  const [txFile, setTxFile] = useState(null);
  const [txPreview, setTxPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);

  const addLog = (line) => setLog((l) => [...l, line]);

  const onBudget = async (file) => {
    setBudgetFile(file);
    const text = await file.text();
    const accounts = parseBudgetCsv(text);
    setBudgetPreview(accounts);
  };

  const onTx = async (file) => {
    setTxFile(file);
    const buf = await file.arrayBuffer();
    const txns = parseTransactionXlsx(buf);
    setTxPreview(txns);
  };

  const commit = async () => {
    setBusy(true);
    setLog([]);
    try {
      // --- Accounts ---
      addLog('Loading existing accounts…');
      const existing = await base44.entities.Account.list('-account_code', 1000);
      const byPath = new Map(existing.map((a) => [a.full_account_path, a]));

      const pathToId = new Map();
      if (budgetPreview) {
        addLog(`Committing ${budgetPreview.length} accounts…`);
        let i = 0;
        for (const a of budgetPreview) {
          i++;
          const cur = byPath.get(a.full_account_path);
          const payload = {
            account_code: a.account_code || '',
            account_name: a.account_name,
            full_account_path: a.full_account_path,
            top_level_group: a.top_level_group,
            annual_budget: a.annual_budget,
            has_own_budget: !a.is_sub,
            source: 'import',
            active: true,
          };
          if (cur) {
            await base44.entities.Account.update(cur.id, payload);
            pathToId.set(a.full_account_path, cur.id);
          } else {
            const created = await base44.entities.Account.create(payload);
            pathToId.set(a.full_account_path, created.id);
          }
          if (i % 25 === 0) addLog(`  accounts ${i}/${budgetPreview.length}`);
        }

        // link parents / budget parents
        addLog('Linking hierarchy…');
        const updates = budgetPreview
          .filter((a) => a.is_sub && a.parent_path && pathToId.has(a.parent_path))
          .map((a) => ({
            id: pathToId.get(a.full_account_path),
            parent_account_id: pathToId.get(a.parent_path),
            budget_parent_id: pathToId.get(a.parent_path),
            has_own_budget: false,
          }));
        if (updates.length) await base44.entities.Account.bulkUpdate(updates);
        addLog(`Linked ${updates.length} sub-accounts to their budget parents.`);
      }

      // --- Transactions ---
      if (txPreview && txPreview.length) {
        addLog('Loading reporting periods…');
        const periods = await base44.entities.ReportingPeriod.list('-year', 200);
        const periodKey = new Map(periods.map((p) => [`${p.year}-${p.month}`, p]));
        const periodIdForKey = new Map(periods.map((p) => [`${p.year}-${p.month}`, p.id]));

        const needed = [...new Set(txPreview.map((t) => `${t.year}-${t.month}`))]
          .filter((k) => !periodKey.has(k));
        if (needed.length) {
          addLog(`Creating ${needed.length} reporting periods…`);
          for (const k of needed) {
            const [y, m] = k.split('-').map(Number);
            const start = new Date(y, m - 1, 1);
            const end = new Date(y, m, 0);
            const created = await base44.entities.ReportingPeriod.create({
              label: format(start, 'MMMM yyyy'),
              month: m,
              year: y,
              start_date: format(start, 'yyyy-MM-dd'),
              end_date: format(end, 'yyyy-MM-dd'),
              months_elapsed: m,
              status: 'transactions_posted',
              published: false,
            });
            periodIdForKey.set(k, created.id);
          }
        }

        const byMonth = {};
        for (const t of txPreview) {
          const k = `${t.year}-${t.month}`;
          (byMonth[k] = byMonth[k] || []).push(t);
        }

        let totalImported = 0;
        let totalSkipped = 0;
        for (const [k, txns] of Object.entries(byMonth)) {
          const periodId = periodIdForKey.get(k);
          addLog(`${format(new Date(txns[0].year, txns[0].month - 1, 1), 'MMM yyyy')}: ${txns.length} rows — deduping…`);
          const existingTxns = await base44.entities.Transaction.filter({ period_id: periodId }, '-date', 5000);
          const seen = new Set(existingTxns.map((t) => `${t.date}|${t.amount}|${t.vendor || ''}|${t.full_account_path || ''}`));

          const groupMap = new Map(budgetPreview.map((a) => [a.full_account_path, a]));
          const fresh = [];
          for (const t of txns) {
            const key = `${t.date}|${t.amount}|${t.vendor || ''}|${t.account_path || ''}`;
            if (seen.has(key)) { totalSkipped++; continue; }
            const acct = groupMap.get(t.account_path) || byPath.get(t.account_path);
            const group = acct?.top_level_group || (budgetPreview ? (budgetPreview.find((a) => a.full_account_path === t.account_path)?.top_level_group) : null);
            const isSnvs = (t.account_path || '').toLowerCase().includes('snvs') || group === 'savings';
            fresh.push({
              period_id: periodId,
              date: t.date,
              vendor: t.vendor,
              description: t.description,
              amount: t.amount,
              transaction_type: t.transaction_type,
              qb_account: t.account_path,
              account_id: acct ? (pathToId.get(t.account_path) || byPath.get(t.account_path)?.id) : null,
              full_account_path: t.account_path,
              budget_group: group || undefined,
              treatment: isSnvs ? 'snvs' : 'personal',
              source: 'import',
              review_status: acct ? 'unreviewed' : 'needs_review',
              review_flags: acct ? [] : ['Account not found in chart of accounts'],
            });
          }

          for (let i = 0; i < fresh.length; i += 500) {
            const batch = fresh.slice(i, i + 500);
            await base44.entities.Transaction.bulkCreate(batch);
            totalImported += batch.length;
          }
          addLog(`  imported ${fresh.length}, skipped ${txns.length - fresh.length} (duplicate)`);
        }
        addLog(`Transactions done — imported ${totalImported}, skipped ${totalSkipped} duplicates.`);
      }

      addLog('✓ Import complete.');
    } catch (e) {
      addLog(`✗ Error: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const ready = (budgetPreview?.length || txPreview?.length) && !busy;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <p className="font-display text-lg">Import Center</p>
        <p className="mt-1 text-sm text-stone-500">
          Upload the QuickBooks <strong>Budget Overview</strong> CSV (builds the chart of accounts + annual budgets) and the <strong>Transaction Report</strong> XLSX (imports transactions linked to those accounts). Preview before committing — duplicates are skipped.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <UploadCard
            icon={<FileSpreadsheet className="h-5 w-5" />}
            title="Budget Overview CSV"
            hint="e.g. BudgetOverview_BVA.csv"
            file={budgetFile}
            onFile={onBudget}
            preview={budgetPreview && (
              <p className="text-xs text-stone-500">
                {budgetPreview.length} accounts parsed · {budgetPreview.filter((a) => !a.is_sub).length} parents, {budgetPreview.filter((a) => a.is_sub).length} sub-accounts · YTD budget total {fmtCurrency(budgetPreview.reduce((s, a) => s + a.annual_budget, 0))}
              </p>
            )}
          />
          <UploadCard
            icon={<FileUp className="h-5 w-5" />}
            title="Transaction Report XLSX"
            hint="e.g. TransactionReport.xlsx"
            file={txFile}
            onFile={onTx}
            preview={txPreview && (
              <p className="text-xs text-stone-500">
                {txPreview.length} transactions parsed · {[...new Set(txPreview.map((t) => `${t.year}-${t.month}`))].length} months ·
                {' '}{txPreview.filter((t) => !t.account_path).length} without an account path
              </p>
            )}
          />
        </div>

        <div className="mt-5 flex items-center gap-3">
          <Button className="rounded-full" disabled={!ready} onClick={commit}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busy ? 'Committing…' : 'Commit to database'}
          </Button>
          {ready && <span className="text-xs text-stone-400">Preview looks good? This creates/updates accounts, periods, and transactions.</span>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-5">
          <p className="mb-2 text-xs uppercase tracking-[0.12em] text-stone-400">Import log</p>
          <div className="space-y-1 font-mono text-xs text-stone-600">
            {log.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadCard({ icon, title, hint, file, onFile, preview }) {
  return (
    <label className="flex flex-col rounded-2xl border border-stone-200 bg-stone-50/50 p-5 hover:border-stone-300">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-white p-2 text-stone-500 shadow-sm">{icon}</span>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-stone-400">{hint}</p>
        </div>
      </div>
      <input
        type="file"
        accept={title.includes('CSV') ? '.csv,text/csv' : '.xlsx'}
        className="mt-3 text-xs text-stone-500 file:mr-3 file:rounded-full file:border-0 file:bg-stone-900 file:px-4 file:py-2 file:text-white file:cursor-pointer"
        onChange={(e) => e.target.files[0] && onFile(e.target.files[0])}
      />
      {file && <p className="mt-2 text-xs text-stone-500">Selected: {file.name}</p>}
      {preview && <div className="mt-2">{preview}</div>}
    </label>
  );
}