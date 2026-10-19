import React from 'react';
import { buildAccountTree } from '@/lib/accountTree';
import { fmtCurrency } from '@/lib/finance';

// Nested account hierarchy inside a drill-down: each account renders as a
// collapsible section with its subtotal, its own transactions, and its
// sub-accounts (e.g. Travel → Lodging, Airfare). Sub-accounts are visible
// only here, never on the dashboard list itself. renderTxn(t, i) draws one
// transaction row (the admin and client views style them differently).
export default function AccountTreeGroups({ rows, renderTxn }) {
  const nodes = React.useMemo(() => buildAccountTree(rows), [rows]);
  const openDefault = rows.length <= 40;

  const renderNode = (node, depth) => (
    <details
      key={`${node.name}@${depth}`}
      open={openDefault}
      className={depth ? 'border-t border-stone-100' : ''}
      data-testid={depth === 0 ? 'drilldown-account' : undefined}
    >
      <summary
        className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm ${
          depth ? 'bg-stone-100/60 pl-8' : 'bg-stone-50'
        }`}
      >
        <span className="min-w-0 truncate font-medium">
          {node.name} <span className="font-normal text-stone-400">· {node.count}</span>
        </span>
        <span className="shrink-0 tabular-nums">{fmtCurrency(node.total)}</span>
      </summary>
      {node.txns.map(renderTxn)}
      {node.children.map((c) => renderNode(c, depth + 1))}
    </details>
  );

  return <div>{nodes.map((n) => renderNode(n, 0))}</div>;
}