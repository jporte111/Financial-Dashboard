import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { fmtCurrency, fmtPct, pct100 } from '@/lib/finance';

// Month-over-month trends (Phase 7). Everything comes from the server's
// `trend` (base44/shared/trendCore.ts): one point per data month, from the
// current published reports only, each exactly what that month's page shows.
// Year to date only. A missing figure is a gap -- the line breaks there and
// the table shows "—" -- never a plotted or counted $0.

const money = (v) => (v == null ? '—' : fmtCurrency(v, { cents: false }));
const pct = (v) => (v == null ? '—' : fmtPct(pct100(v)));
// Compact axis labels that stay distinct at any scale ("307", "1.5K", "2.1M").
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const axisMoney = (v) => compact.format(v);
const tip = { formatter: (v) => (v == null ? '—' : fmtCurrency(v, { cents: false })) };

// A point from a month "before BVA reporting" is drawn as a grey hollow dot;
// every other point is a small solid dot in the line's colour.
const pointDot = (color) => (props) => {
  const { cx, cy, payload, index } = props;
  if (cx == null || cy == null) return null;
  return payload?.beforeBva
    ? <circle key={`d${index}`} cx={cx} cy={cy} r={4} fill="#fff" stroke="#a8a29e" strokeWidth={1.5} />
    : <circle key={`d${index}`} cx={cx} cy={cy} r={2.5} fill={color} stroke={color} />;
};

function TrendChart({ title, data, series, legacy, testId }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5" data-testid={testId}>
      <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{title}</p>
      {legacy && <p className="mt-1 text-[11px] text-stone-400"><span className="mr-1 inline-block h-2 w-2 rounded-full border border-stone-400 align-middle" />Hollow grey points: before BVA reporting</p>}
      <div className="mt-3 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
            <XAxis dataKey="dataMonth" tickFormatter={(v) => String(v).split(' ')[0]} tickLine={false} axisLine={false} fontSize={11} />
            <YAxis tickFormatter={axisMoney} tickLine={false} axisLine={false} fontSize={11} width={44} />
            <Tooltip {...tip} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {series.map((s) => (
              <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={pointDot(s.color)} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function TrendsSection({ trend }) {
  if (trend === null) {
    return <p className="rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-500" data-testid="trends-unavailable">Trends are unavailable right now. Please refresh in a moment.</p>;
  }
  const points = trend?.points || [];
  if (points.length < 2) {
    return <p className="rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-500" data-testid="trends-empty">Trends appear once two or more months are published.</p>;
  }
  const legacy = points.some((p) => p.beforeBva);
  // Expected spending by now = that month's annual budget × its elapsed share
  // of the year, only where the month has an annual budget.
  const data = points.map((p) => ({
    dataMonth: p.dataMonth,
    beforeBva: p.beforeBva,
    incomeYtd: p.income.ytd,
    incomeBudget: p.income.budget,
    expensesYtd: p.expenses.ytd,
    expectedByNow: p.expenses.budget != null && p.expectedPacePct != null ? Math.round(p.expenses.budget * p.expectedPacePct) : null,
    fixed: p.groups.fixed.ytd,
    variable: p.groups.variable.ytd,
    discretionary: p.groups.discretionary.ytd,
    distributions: p.distributionsYtd,
  }));
  const c = trend.cashSinceLast;
  return (
    <div className="space-y-5" data-testid="trends">
      {c && (
        <div className="rounded-2xl border border-stone-200 bg-white p-5" data-testid="cash-since-last">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Cash since the last report</p>
          <p className="mt-2 font-display text-2xl tabular-nums">
            {c.amount === 0 ? 'Unchanged' : `${c.amount > 0 ? 'Up' : 'Down'} ${fmtCurrency(Math.abs(c.amount), { cents: false })}`}
          </p>
          <p className="mt-1 text-sm text-stone-500">Total Cash {fmtCurrency(c.current, { cents: false })} in the {c.toReport} report, compared with the {c.sinceReport} report.</p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <TrendChart title={`Income · year to date ${trend.year}`} data={data} legacy={legacy} testId="trend-income" series={[{ key: 'incomeYtd', name: 'Received', color: '#0f766e' }, { key: 'incomeBudget', name: 'Annual budget', color: '#a8a29e', dashed: true }]} />
        <TrendChart title={`Expenses · year to date ${trend.year}`} data={data} legacy={legacy} testId="trend-expenses" series={[{ key: 'expensesYtd', name: 'Spent', color: '#1c1917' }, { key: 'expectedByNow', name: 'Expected by now', color: '#a8a29e', dashed: true }]} />
        <TrendChart title="Fixed / Variable / Discretionary · year to date" data={data} legacy={legacy} testId="trend-groups" series={[{ key: 'fixed', name: 'Fixed', color: '#44403c' }, { key: 'variable', name: 'Variable', color: '#0f766e' }, { key: 'discretionary', name: 'Discretionary', color: '#b45309' }]} />
        <TrendChart title="Distributions · year to date" data={data} legacy={legacy} testId="trend-distributions" series={[{ key: 'distributions', name: 'Received', color: '#0f766e' }]} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white" data-testid="trend-table">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-[0.1em] text-stone-500">
              <th className="whitespace-nowrap px-4 py-3 font-normal">Data through</th>
              <th className="px-4 py-3 text-right font-normal">Income</th>
              <th className="px-4 py-3 text-right font-normal">Expenses</th>
              <th className="px-4 py-3 text-right font-normal">Budget used · expected</th>
              <th className="px-4 py-3 text-right font-normal">Fixed</th>
              <th className="px-4 py-3 text-right font-normal">Variable</th>
              <th className="px-4 py-3 text-right font-normal">Discretionary</th>
              <th className="px-4 py-3 text-right font-normal">Distributions</th>
              <th className="px-4 py-3 text-right font-normal">Cash</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.dataMonth} className="border-b border-stone-100 last:border-0 tabular-nums" data-testid={`trend-row-${p.dataMonth}`}>
                <td className="min-w-[170px] px-4 py-2.5">
                  <span className="block whitespace-nowrap font-medium">{p.dataMonth}</span>
                  <span className="block text-xs text-stone-400">{p.reportLabel} report</span>
                  {p.beforeBva && <span className="mt-1 inline-block whitespace-nowrap rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">before BVA reporting</span>}
                </td>
                <td className="px-4 py-2.5 text-right">{money(p.income.ytd)}</td>
                <td className="px-4 py-2.5 text-right">{money(p.expenses.ytd)}</td>
                <td className="px-4 py-2.5 text-right">{p.expenses.pctUsed == null ? '—' : `${pct(p.expenses.pctUsed)} · ${pct(p.expectedPacePct)}`}</td>
                <td className="px-4 py-2.5 text-right">{money(p.groups.fixed.ytd)}</td>
                <td className="px-4 py-2.5 text-right">{money(p.groups.variable.ytd)}</td>
                <td className="px-4 py-2.5 text-right">{money(p.groups.discretionary.ytd)}</td>
                <td className="px-4 py-2.5 text-right">{money(p.distributionsYtd)}</td>
                <td className="px-4 py-2.5 text-right">{money(p.cash)}{p.cashPartial && p.cash != null ? <span className="ml-1 text-xs text-amber-700">partial</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {trend.explanations?.length > 0 && (
        <ul className="space-y-1 text-xs text-stone-500" data-testid="trend-explanations">
          {trend.explanations.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
