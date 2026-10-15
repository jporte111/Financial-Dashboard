import React, { useState } from 'react';
import { fmtCurrency, isMissingNumber } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

// Accepts either the raw CashAccount entity rows (`accounts`, used by the Cash
// page) or pre-computed BVA rows (`rows`, used by the dashboard).
function normalize({ accounts, rows }) {
  if (rows) return rows.map((r) => ({ id: r.id, name: r.name, balance: r.balance, type: r.accountType, asOf: r.asOf || null }));
  return (accounts || []).map((a) => ({
    id: a.id,
    name: a.name,
    // A missing balance stays missing (shown as a dash), never a fabricated $0.00.
    balance: isMissingNumber(a.balance) ? null : Number(a.balance),
    type: a.account_type === 'investment' ? 'investment' : 'bank',
    asOf: a.as_of_date ? format(new Date(a.as_of_date), 'MMM d, yyyy') : null,
  }));
}

export default function CashCard({ total, accounts = null, rows = null, reconciles = null, reportedTotal = null, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const list = normalize({ accounts, rows });
  const missingCount = list.filter((a) => a.balance == null).length;
  const knownSum = list.reduce((s, a) => s + (a.balance == null ? 0 : a.balance), 0);
  // The total shown is the workbook's printed Total Cash when one is stored.
  const printed = reportedTotal != null && total != null && Math.round(reportedTotal * 100) === Math.round(total * 100);
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Total Cash</p>
          <p className="mt-2 font-display text-3xl tracking-tight">{fmtCurrency(total)}</p>
          {missingCount > 0 && total != null && !printed && (
            <p className="mt-1 text-xs text-amber-700" data-testid="cash-partial">
              Partial total — {missingCount} account{missingCount > 1 ? 's have' : ' has'} no balance in the source; only known balances are included.
            </p>
          )}
          {missingCount > 0 && printed && (
            <p className="mt-1 text-xs text-amber-700" data-testid="cash-partial">
              {missingCount} account{missingCount > 1 ? 's have' : ' has'} no balance in the workbook (shown as —); the workbook&apos;s Total Cash is shown.
            </p>
          )}
          {(reconciles === false || (printed && missingCount === 0 && list.length > 0 && Math.round(knownSum * 100) !== Math.round(total * 100))) && (
            <p className="mt-1 text-xs text-rose-700" data-testid="cash-does-not-add-up">
              The workbook does not add up — its accounts total {fmtCurrency(knownSum)}
              {printed ? `; the workbook's Total Cash of ${fmtCurrency(total)} is shown.` : '. The calculated total is shown.'}
            </p>
          )}
        </div>
        <Button variant="outline" className="rounded-full" onClick={() => setOpen(!open)}>
          {open ? 'Hide Accounts' : 'View Accounts'}
        </Button>
      </div>
      {open && (
        <div className="mt-6 divide-y divide-stone-100 border-t border-stone-100">
          {list.map((a) => (
            <div key={a.id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-medium">{a.name}</p>
                <p className="text-xs text-stone-500">
                  {a.type === 'investment' ? 'Investment' : 'Bank'}
                  {a.asOf ? ` · as of ${a.asOf}` : ''}
                </p>
              </div>
              <p className="text-sm tabular-nums">{fmtCurrency(a.balance)}</p>
            </div>
          ))}
          {!list.length && <p className="py-4 text-sm text-stone-500">No accounts recorded.</p>}
        </div>
      )}
    </div>
  );
}
