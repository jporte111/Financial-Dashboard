import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus } from 'lucide-react';

const GROUPS = ['fixed', 'variable', 'discretionary', 'income', 'savings'];

// Parse a comma/newline-separated textarea value into a clean string array.
function parseNames(v) {
  return String(v || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function BudgetLinesEditor({ periodId, lines, reload }) {
  const [busy, setBusy] = useState(false);

  const patch = async (id, data) => { await base44.entities.BudgetLine.update(id, data); reload(); };
  const add = async () => {
    setBusy(true);
    await base44.entities.BudgetLine.create({ period_id: periodId, category: 'New Category', budget_group: 'variable' });
    setBusy(false);
    reload();
  };
  const remove = async (id) => { await base44.entities.BudgetLine.delete(id); reload(); };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg">Budget Categories</p>
        <Button variant="outline" className="rounded-full" onClick={add} disabled={busy}>
          <Plus className="mr-1 h-4 w-4" /> Add Category
        </Button>
      </div>
      <div className="mt-5 space-y-3">
        {(lines || []).map((l) => (
          <div key={l.id} className="rounded-xl border border-stone-100 bg-stone-50/50 p-3">
            <div className="grid items-center gap-2 md:grid-cols-12">
              <Input className="md:col-span-2 bg-white" defaultValue={l.qb_code || ''} placeholder="QB code (ref)" onBlur={(e) => patch(l.id, { qb_code: e.target.value })} />
              <Input className="md:col-span-3 bg-white" defaultValue={l.category} onBlur={(e) => patch(l.id, { category: e.target.value })} />
              <div className="md:col-span-2">
                <Select value={l.budget_group} onValueChange={(v) => patch(l.id, { budget_group: v })}>
                  <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>{GROUPS.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Input className="md:col-span-2 bg-white" type="number" step="0.01" defaultValue={l.month_actual} placeholder="Month" onBlur={(e) => patch(l.id, { month_actual: Number(e.target.value || 0) })} />
              <Input className="md:col-span-1 bg-white" type="number" step="0.01" defaultValue={l.ytd_actual} placeholder="YTD" onBlur={(e) => patch(l.id, { ytd_actual: Number(e.target.value || 0) })} />
              <Input className="md:col-span-1 bg-white" type="number" step="0.01" defaultValue={l.annual_budget} placeholder="Annual" onBlur={(e) => patch(l.id, { annual_budget: Number(e.target.value || 0) })} />
              <button onClick={() => remove(l.id)} className="justify-self-end p-2 text-stone-400 hover:text-rose-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2">
              <label className="mb-1 block text-[11px] uppercase tracking-[0.12em] text-stone-400">
                QuickBooks account names to roll up (comma or newline)
              </label>
              <textarea
                className="w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 focus:outline-none focus:ring-1 focus:ring-stone-400"
                rows={2}
                defaultValue={(l.qb_account_names || []).join('\n')}
                placeholder={l.category ? `e.g. ${l.category}` : 'Comma or newline separated QuickBooks account names'}
                onBlur={(e) => patch(l.id, { qb_account_names: parseNames(e.target.value) })}
              />
            </div>
          </div>
        ))}
        {!lines?.length && <p className="text-sm text-stone-500">No categories yet.</p>}
      </div>
      <p className="mt-4 text-xs text-stone-400">The live QuickBooks column pairs each line by its category name plus any extra QBO account names listed below it. QB code is reference only. Changes save when you leave a field.</p>
    </div>
  );
}