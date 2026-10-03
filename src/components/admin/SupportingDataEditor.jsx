import React from 'react';
import { numericInput, BLANK_INPUT_HINT } from '@/lib/finance';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Trash2, Plus } from 'lucide-react';

// Generic simple editor: fields = [{key, label, type, span}]
export default function SupportingDataEditor({ title, entityName, periodId, items, reload, fields, defaults }) {
  const patch = async (id, data) => { await base44.entities[entityName].update(id, data); reload(); };
  const add = async () => { await base44.entities[entityName].create({ period_id: periodId, ...defaults }); reload(); };
  const remove = async (id) => { await base44.entities[entityName].delete(id); reload(); };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg">{title}</p>
        <Button variant="outline" className="rounded-full" onClick={add}><Plus className="mr-1 h-4 w-4" /> Add</Button>
      </div>
      <div className="mt-5 space-y-3">
        {(items || []).map((it) => (
          <div key={it.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/50 p-3">
            {fields.map((f) => (
              <Input
                key={f.key}
                className={`bg-white ${f.wide ? 'flex-[2] min-w-[180px]' : 'flex-1 min-w-[110px]'}`}
                type={f.type || 'text'}
                step={f.type === 'number' ? '0.01' : undefined}
                placeholder={f.label}
                defaultValue={it[f.key] ?? ''}
                title={f.type === 'number' ? BLANK_INPUT_HINT : undefined}
                onBlur={(e) => {
                  if (f.type !== 'number') return patch(it.id, { [f.key]: e.target.value });
                  const v = numericInput(e.target.value);
                  if (v != null && v !== it[f.key]) patch(it.id, { [f.key]: v });
                }}
              />
            ))}
            <button onClick={() => remove(it.id)} className="p-2 text-stone-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {!items?.length && <p className="text-sm text-stone-500">No entries yet.</p>}
      </div>
      <p className="mt-4 text-xs text-stone-400">Fields: {fields.map((f) => f.label).join(' · ')}. Changes save when you leave a field.</p>
    </div>
  );
}