import React from 'react';
import { format } from 'date-fns';
import { fmtCurrency } from '@/lib/finance';

// Account hierarchy inside a category drill-down: transactions grouped by
// sub-account (the last segment of the account path, e.g. Travel → Lodging,
// Airfare). Each group is collapsible with its own subtotal, largest first.
// Sub-accounts are only visible here, never on the dashboard list itself.
const leafOf = (path) => {
  const leaf = path ? String(path).split(':').pop() : '';
  return leaf.replace(/^\d+\s*[-:]?\s*/, '').trim() || 'Uncategorized';
};

export default function SubAccountGroups({ txns }) {
  const groups = React.useMemo(() => {
    const m = new Map();
    for (const t of txns) {
      const k = leafOf(t.full_account_path);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return [...m]
      .map(([sub, list]) => ({
        sub,
        list: [...list].sort((a, b) => String(b.date).localeCompare(String(a.date))),
        total: list.reduce((s, t) => s + Number(t.amount || 0), 0),
      }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [txns]);

  const many = txns.length > 40;

  return (
    <div className="overflow-hidden rounded-xl border border-stone-200">
      {groups.map((g, gi) => (
        <details key={g.sub} open={!many} className={gi ? 'border-t border-stone-200' : ''}>
          <summary className="flex cursor-pointer items-center justify-between gap-3 bg-stone-50 px-4 py-2.5 text-sm">
            <span className="min-w-0 truncate font-medium">
              {g.sub} <span className="font-normal text-stone-400">· {g.list.length}</span>
            </span>
            <span className="shrink-0 tabular-nums">{fmtCurrency(g.total)}</span>
          </summary>
          {g.list.map((t, i) => (
            <div key={t.id || i} className={`flex items-start justify-between gap-4 px-4 py-3 ${i ? 'border-t border-stone-100' : ''}`}>
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
          ))}
        </details>
      ))}
    </div>
  );
}