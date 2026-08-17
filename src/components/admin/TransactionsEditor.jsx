import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus, RefreshCw } from 'lucide-react';
import { fmtCurrency } from '@/lib/finance';

const TREATMENTS = [
  ['personal', 'Personal'],
  ['savings_distribution', 'Savings / Distribution'],
  ['unclassified', 'Unclassified'],
];

export default function TransactionsEditor({ periodId, lines }) {
  const [txns, setTxns] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const load = () => base44.entities.Transaction.filter({ period_id: periodId }, '-date').then(setTxns);
  useEffect(() => { if (periodId) load(); }, [periodId]);

  const syncQuickbooks = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('quickbooksTransactionSync', { period_id: periodId });
      setSyncResult(res.data);
      load();
    } catch (e) {
      setSyncResult({ error: e.message || 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  };

  const patch = async (id, data) => { await base44.entities.Transaction.update(id, data); load(); };
  const add = async () => {
    await base44.entities.Transaction.create({
      period_id: periodId,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      transaction_type: 'expense',
      treatment: 'personal',
      source: 'manual',
    });
    load();
  };
  const remove = async (id) => { await base44.entities.Transaction.delete(id); load(); };

  const categories = (lines || []).map((l) => l.category);

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-display text-lg">Transaction Detail</p>
          <p className="mt-1 text-sm text-stone-500">
            {txns.length} transactions · {fmtCurrency(txns.reduce((s, t) => s + Number(t.amount || 0), 0))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="rounded-full" onClick={syncQuickbooks} disabled={syncing}>
            {syncing ? 'Syncing…' : <><RefreshCw className="mr-1 h-4 w-4" /> Sync from QuickBooks</>}
          </Button>
          <Button variant="outline" className="rounded-full" onClick={add}><Plus className="mr-1 h-4 w-4" /> Add Transaction</Button>
        </div>
      </div>
      {syncResult && (
        <div className={`mt-3 rounded-xl border p-3 text-xs ${syncResult.error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {syncResult.error
            ? `Sync failed: ${syncResult.error}`
            : `QuickBooks sync for ${syncResult.period || ''} — pulled ${syncResult.quickbooksTransactions} transactions, imported ${syncResult.importedLines} line${syncResult.importedLines === 1 ? '' : 's'} into this period (${syncResult.existingBeforeSync || 0} already existed).`}
        </div>
      )}
      <div className="mt-5 space-y-3">
        {txns.map((t) => (
          <div key={t.id} className="grid items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/50 p-3 md:grid-cols-12">
            <Input className="md:col-span-2 bg-white" type="date" defaultValue={t.date || ''} onBlur={(e) => patch(t.id, { date: e.target.value })} />
            <Input className="md:col-span-2 bg-white" placeholder="Vendor" defaultValue={t.vendor || ''} onBlur={(e) => patch(t.id, { vendor: e.target.value })} />
            <Input className="md:col-span-3 bg-white" placeholder="Description" defaultValue={t.description || ''} onBlur={(e) => patch(t.id, { description: e.target.value })} />
            <Input className="md:col-span-1 bg-white" type="number" step="0.01" placeholder="Amount" defaultValue={t.amount} onBlur={(e) => patch(t.id, { amount: Number(e.target.value || 0) })} />
            <div className="md:col-span-2">
              <Select value={t.category || ''} onValueChange={(v) => patch(t.id, { category: v })}>
                <SelectTrigger className="bg-white"><SelectValue placeholder="Category" /></SelectTrigger>
                <SelectContent>{categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="md:col-span-1">
              <Select value={t.treatment || 'personal'} onValueChange={(v) => patch(t.id, { treatment: v })}>
                <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                <SelectContent>{TREATMENTS.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <button onClick={() => remove(t.id)} className="justify-self-end p-2 text-stone-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {!txns.length && <p className="text-sm text-stone-500">No transactions for this period yet.</p>}
      </div>
    </div>
  );
}