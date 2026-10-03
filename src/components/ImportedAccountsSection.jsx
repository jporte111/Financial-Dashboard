import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { fmtCurrency, GROUP_LABELS } from '@/lib/finance';
import { ChevronDown } from 'lucide-react';

// Collapsed chart-of-accounts imported from the Excel workbook. Lives on the
// Budget (Excel) tab as a secondary reference; no QuickBooks data here.
export default function ImportedAccountsSection() {
  const [accounts, setAccounts] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    base44.entities.Account.filter({ source: 'import' }, 'sort_order', 500)
      .then((res) => alive && setAccounts(res || []))
      .catch(() => alive && setAccounts([]));
    return () => { alive = false; };
  }, []);

  if (!accounts) return null;
  if (!accounts.length) return null;

  return (
    <section>
      <SectionHeading title="Imported Chart of Accounts" subtitle="From the uploaded Excel workbook — reference only" />
      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between px-6 py-4 text-left"
        >
          <span className="font-medium">{accounts.length} imported accounts</span>
          <ChevronDown className={`h-4 w-4 text-stone-400 transition ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="border-t border-stone-100">
            <div className="hidden grid-cols-12 gap-4 bg-stone-50/60 px-6 py-2 text-[11px] uppercase tracking-[0.12em] text-stone-400 md:grid">
              <span className="col-span-2">Code</span>
              <span className="col-span-4">Account</span>
              <span className="col-span-3">Path</span>
              <span className="col-span-2">Group</span>
              <span className="col-span-1 text-right">Annual</span>
            </div>
            {accounts.map((a, i) => (
              <div key={a.id} className={`grid grid-cols-1 gap-2 px-6 py-3 text-sm md:grid-cols-12 md:items-center ${i ? 'border-t border-stone-100' : ''}`}>
                <span className="tabular-nums text-stone-500 md:col-span-2">{a.account_code || '—'}</span>
                <span className="font-medium md:col-span-4">{a.account_name}</span>
                <span className="truncate text-stone-500 md:col-span-3">{a.full_account_path || '—'}</span>
                <span className="text-stone-500 md:col-span-2">{GROUP_LABELS[a.top_level_group] || a.top_level_group || '—'}</span>
                <span className="tabular-nums md:col-span-1 md:text-right">{fmtCurrency(a.annual_budget, { cents: false })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SectionHeading({ title, subtitle }) {
  return (
    <div className="mb-5">
      <h2 className="font-display text-xl tracking-tight">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
    </div>
  );
}