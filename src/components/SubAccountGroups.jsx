import React from 'react';
import { format } from 'date-fns';
import { fmtCurrency } from '@/lib/finance';
import AccountTreeGroups from '@/components/AccountTreeGroups';

// Admin drill-down transaction list: the account hierarchy as collapsible
// groups with subtotals (Travel → Lodging, Airfare). Sub-accounts are only
// visible inside the drill-down, never on the dashboard list itself.
export default function SubAccountGroups({ txns }) {
  const renderTxn = (t, i) => (
    <div key={t.id || i} className={`flex items-start justify-between gap-4 border-t border-stone-100 px-4 py-3 ${i ? '' : ''}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium">{t.vendor || t.description || '—'}</p>
        <p className="text-xs text-stone-500 truncate">
          {t.date ? format(new Date(t.date), 'MMM d, yyyy') : ''}
          {t.description && t.vendor ? ` · ${t.description}` : ''}
        </p>
        {t.source === 'detail_report' && (
          <p className="truncate text-[11px] text-stone-400" data-testid="internal-row">
            {t.full_account_path}{t.payment_account ? ` · ${t.payment_account}` : ''}{t.qb_type ? ` · ${t.qb_type}` : ''}{t.qb_num ? ` #${t.qb_num}` : ''}
            {t.client_visible ? '' : ' · not shown to the client (account not confirmed or outside the cost groups)'}
          </p>
        )}
      </div>
      <p className={`shrink-0 text-sm tabular-nums ${t.amount < 0 ? 'text-emerald-700' : ''}`}>{fmtCurrency(t.amount)}</p>
    </div>
  );

  return <AccountTreeGroups rows={txns} renderTxn={renderTxn} />;
}