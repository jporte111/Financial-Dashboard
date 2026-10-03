import React, { useState } from 'react';
import { numericInput, BLANK_INPUT_HINT } from '@/lib/finance';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus } from 'lucide-react';

const GROUPS = ['fixed', 'variable', 'discretionary', 'income', 'savings', 'unassigned'];

export default function BudgetLinesEditor({ periodId, lines, reload }) {
  const [busy, setBusy] = useState(false);

  const patch = async (id, data) => { await base44.entities.BudgetLine.update(id, data); reload(); };

  // Picking a real Fixed/Variable/Discretionary group for a monitored BVA
  // DETAIL row also confirms the mapping, so the dashboard stops treating it
  // as Unassigned. Choosing 'unassigned' clears the confirmation.
  const setGroup = (l, v) => {
    const data = { budget_group: v };
    if (l.bva_detail) data.group_confirmed = ['fixed', 'variable', 'discretionary'].includes(v);
    patch(l.id, data);
  };
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
              <Input className="md:col-span-2 bg-white" defaultValue={l.qb_code || ''} placeholder="Account code (ref)" onBlur={(e) => patch(l.id, { qb_code: e.target.value })} />
              <Input className="md:col-span-3 bg-white" defaultValue={l.category} onBlur={(e) => patch(l.id, { category: e.target.value })} />
              <div className="md:col-span-2">
                <Select value={l.budget_group} onValueChange={(v) => setGroup(l, v)}>
                  <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>{GROUPS.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
                </Select>
                {l.bva_detail && !l.group_confirmed && (
                  <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-amber-600">Group mapping required</p>
                )}
              </div>
              <Input className="md:col-span-2 bg-white" type="number" step="0.01" defaultValue={l.month_actual} placeholder="Month" title={BLANK_INPUT_HINT} onBlur={(e) => { const v = numericInput(e.target.value); if (v != null && v !== l.month_actual) patch(l.id, { month_actual: v }); }} />
              <Input className="md:col-span-1 bg-white" type="number" step="0.01" defaultValue={l.ytd_actual} placeholder="YTD" title={BLANK_INPUT_HINT} onBlur={(e) => { const v = numericInput(e.target.value); if (v != null && v !== l.ytd_actual) patch(l.id, { ytd_actual: v }); }} />
              <Input className="md:col-span-1 bg-white" type="number" step="0.01" defaultValue={l.annual_budget} placeholder="Annual" title={BLANK_INPUT_HINT} onBlur={(e) => { const v = numericInput(e.target.value); if (v != null && v !== l.annual_budget) patch(l.id, { annual_budget: v }); }} />
              <button onClick={() => remove(l.id)} className="justify-self-end p-2 text-stone-400 hover:text-rose-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        {!lines?.length && <p className="text-sm text-stone-500">No categories yet.</p>}
      </div>
      <p className="mt-4 text-xs text-stone-400">Figures come from the BVA workbook import. Account code is reference only. Changes save when you leave a field.</p>
    </div>
  );
}