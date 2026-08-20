import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import SectionHeading from '@/components/SectionHeading';
import { fmtCurrency, GROUP_LABELS } from '@/lib/finance';

// The Excel-import Account records — kept separate from the synced QBO
// accounts. These hold the imported chart-of-accounts hierarchy and budget
// metadata but are no longer used by the live roll-up or the comparison view.
export default function ImportAccounts() {
  const [accounts, setAccounts] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.entities.Account
      .filter({ source: 'import' }, 'account_code', 5000)
      .then((items) => alive && setAccounts(items || []))
      .catch(() => alive && setAccounts([]));
    return () => { alive = false; };
  }, []);

  return (
    <div>
      <SectionHeading
        title="Import Accounts"
        subtitle="Excel-imported chart of accounts — archived separately from the live QuickBooks layer"
      />
      {accounts === null ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center text-sm text-stone-400">Loading…</div>
      ) : !accounts.length ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center">
          <p className="font-display text-xl">No import accounts</p>
          <p className="mt-2 text-sm text-stone-500">Excel-imported accounts will appear here.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
          <div className="hidden grid-cols-12 gap-4 border-b border-stone-100 bg-stone-50/60 px-6 py-3 md:grid">
            <div className="col-span-3 text-[11px] uppercase tracking-[0.12em] text-stone-400">Code</div>
            <div className="col-span-4 text-[11px] uppercase tracking-[0.12em] text-stone-400">Account</div>
            <div className="col-span-3 text-[11px] uppercase tracking-[0.12em] text-stone-400">Group</div>
            <div className="col-span-2 text-right text-[11px] uppercase tracking-[0.12em] text-stone-400">Annual Budget</div>
          </div>
          {accounts.map((a, i) => (
            <div
              key={a.id}
              className={`grid grid-cols-1 gap-4 px-6 py-4 md:grid-cols-12 md:items-center ${i ? 'border-t border-stone-100' : ''}`}
            >
              <div className="text-sm tabular-nums text-stone-500 md:col-span-3">{a.account_code || '—'}</div>
              <div className="md:col-span-4">
                <p className="font-medium">{a.account_name}</p>
                {a.full_account_path && (
                  <p className="mt-0.5 text-xs text-stone-400 truncate">{a.full_account_path}</p>
                )}
              </div>
              <div className="text-sm text-stone-500 md:col-span-3">{GROUP_LABELS[a.top_level_group] || '—'}</div>
              <div className="text-right tabular-nums md:col-span-2">{fmtCurrency(a.annual_budget || 0, { cents: false })}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}