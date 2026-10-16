import React from 'react';
import { fmtCurrency } from '@/lib/finance';

// "What changed in the updated workbook" (src/lib/bvaChangeSummary.js): the
// headline figures before -> after (as the month page shows them), then each
// line, cash account, distribution and transfer that changed, was added or
// removed. A missing figure shows as "—", never $0.00.
const money = (v) => (v == null ? '—' : fmtCurrency(v));
const val = (c) => (c.kind === 'text' ? c[c.which] || '—' : money(c[c.which]));

function Section({ title, part, testId }) {
  if (!part || (!part.changed.length && !part.added.length && !part.removed.length)) return null;
  return (
    <div className="mt-3" data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-stone-500">{title}</p>
      <ul className="mt-1 space-y-0.5 text-sm text-stone-700">
        {part.changed.map((c, i) => (
          <li key={`c${i}`}>
            {c.name} · {c.field}: {val({ ...c, which: 'before' })} → <span className="font-medium">{val({ ...c, which: 'after' })}</span>
          </li>
        ))}
        {part.added.map((n) => <li key={`a${n}`}>Added: {n}</li>)}
        {part.removed.map((n) => <li key={`r${n}`}>Removed: {n}</li>)}
      </ul>
    </div>
  );
}

export default function ImportChangeSummary({ summary, comparedWith, published }) {
  if (!summary) return null;
  const headline = summary.headline.filter((h) => h.changed);
  return (
    <div className="mt-3 rounded-xl border border-stone-200 bg-white p-4" data-testid="change-summary">
      <p className="font-medium text-stone-800">What changed compared with the {published ? 'published ' : ''}{comparedWith} report</p>
      {summary.identical ? (
        <p className="mt-1 text-sm text-stone-600">No figures changed.</p>
      ) : (
        <>
          {headline.length > 0 && (
            <table className="mt-2 w-full text-sm" data-testid="change-headline">
              <tbody>
                {headline.map((h) => (
                  <tr key={h.label} className="border-b border-stone-100 last:border-0 tabular-nums">
                    <td className="py-1 pr-3 text-stone-600">{h.label}</td>
                    <td className="py-1 pr-3 text-right text-stone-500">{money(h.before)}</td>
                    <td className="py-1 pr-1 text-stone-400">→</td>
                    <td className="py-1 text-right font-medium">{money(h.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary.cutoff && <p className="mt-2 text-sm text-stone-700">Reporting cutoff: {summary.cutoff.before || '—'} → <span className="font-medium">{summary.cutoff.after || '—'}</span></p>}
          <Section title="Budget lines" part={summary.lines} testId="change-lines" />
          <Section title="Cash accounts" part={summary.cash} testId="change-cash" />
          <Section title="Distributions" part={summary.distributions} testId="change-distributions" />
          <Section title="Recurring transfers" part={summary.transfers} testId="change-transfers" />
        </>
      )}
      {summary.unchanged > 0 && <p className="mt-2 text-xs text-stone-400">Everything else unchanged ({summary.unchanged} item{summary.unchanged === 1 ? '' : 's'}).</p>}
    </div>
  );
}
