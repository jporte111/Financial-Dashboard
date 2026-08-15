import React, { useState } from 'react';
import { fmtCurrency } from '@/lib/finance';
import { ChevronDown } from 'lucide-react';

export default function RecurringTransfersCard({ transfers }) {
  const [open, setOpen] = useState(false);
  const list = transfers || [];
  return (
    <div className="rounded-2xl border border-stone-200 bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-6 py-5 text-left">
        <div>
          <p className="font-display text-lg">Recurring Transfers</p>
          <p className="text-sm text-stone-500">
            {list.length} items · {fmtCurrency(list.reduce((s, t) => s + Number(t.amount || 0), 0))} monthly
          </p>
        </div>
        <ChevronDown className={`h-4 w-4 text-stone-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="divide-y divide-stone-100 border-t border-stone-100">
          {list.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4 px-6 py-3">
              <div>
                <p className="text-sm font-medium">{t.purpose}</p>
                <p className="text-xs text-stone-500">{t.source}</p>
              </div>
              <p className="text-sm tabular-nums">{fmtCurrency(t.amount)}</p>
            </div>
          ))}
          {!list.length && <p className="px-6 py-4 text-sm text-stone-500">No recurring transfers recorded.</p>}
        </div>
      )}
    </div>
  );
}