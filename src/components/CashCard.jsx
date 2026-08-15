import React, { useState } from 'react';
import { fmtCurrency } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

export default function CashCard({ total, accounts, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Total Cash</p>
          <p className="mt-2 font-display text-3xl tracking-tight">{fmtCurrency(total)}</p>
        </div>
        <Button variant="outline" className="rounded-full" onClick={() => setOpen(!open)}>
          {open ? 'Hide Accounts' : 'View Accounts'}
        </Button>
      </div>
      {open && (
        <div className="mt-6 divide-y divide-stone-100 border-t border-stone-100">
          {(accounts || []).map((a) => (
            <div key={a.id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-medium">{a.name}</p>
                <p className="text-xs text-stone-500">
                  {a.account_type === 'investment' ? 'Investment' : 'Bank'}
                  {a.as_of_date ? ` · as of ${format(new Date(a.as_of_date), 'MMM d, yyyy')}` : ''}
                </p>
              </div>
              <p className="text-sm tabular-nums">{fmtCurrency(a.balance)}</p>
            </div>
          ))}
          {!accounts?.length && <p className="py-4 text-sm text-stone-500">No accounts recorded.</p>}
        </div>
      )}
    </div>
  );
}