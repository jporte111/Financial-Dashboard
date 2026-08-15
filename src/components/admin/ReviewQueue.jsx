import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { fmtCurrency } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

export function flagsFor(t) {
  const flags = [];
  if (!t.category) flags.push('Category blank');
  if (!t.treatment || t.treatment === 'unclassified') flags.push('Class blank / uncertain');
  if (Math.abs(Number(t.amount || 0)) >= 25000) flags.push('Unusual amount');
  if (t.is_refund && !t.category) flags.push('Refund category unmatched');
  if (t.source === 'manual') flags.push('Manually entered');
  return flags;
}

export default function ReviewQueue({ periodId }) {
  const [txns, setTxns] = useState(null);

  const load = () => {
    if (!periodId) return;
    base44.entities.Transaction.filter({ period_id: periodId }, '-date').then(setTxns);
  };
  useEffect(load, [periodId]);

  const flagged = (txns || [])
    .map((t) => ({ t, flags: flagsFor(t) }))
    .filter((x) => x.flags.length && x.t.review_status !== 'reviewed');

  const approve = async (id) => {
    await base44.entities.Transaction.update(id, { review_status: 'reviewed' });
    load();
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Needs Review</p>
      <p className="mt-1 text-sm text-stone-500">Transactions flagged before publication — internal only.</p>
      {txns === null ? (
        <p className="py-8 text-sm text-stone-400">Loading…</p>
      ) : flagged.length === 0 ? (
        <p className="py-8 text-sm text-stone-500">Nothing needs review for this period.</p>
      ) : (
        <div className="mt-5 divide-y divide-stone-100">
          {flagged.map(({ t, flags }) => (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
              <div>
                <p className="text-sm font-medium">
                  {t.vendor || '—'} · {fmtCurrency(t.amount)}
                </p>
                <p className="text-xs text-stone-500">
                  {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}{t.category ? ` · ${t.category}` : ''}{t.description ? ` · ${t.description}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {flags.map((f) => (
                    <span key={f} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{f}</span>
                  ))}
                </div>
              </div>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => approve(t.id)}>Mark Reviewed</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}