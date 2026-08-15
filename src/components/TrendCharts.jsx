import React from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { fmtCurrency } from '@/lib/finance';

export default function TrendCharts() {
  const { periods } = usePeriodContext();
  const data = [...periods]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map((p) => ({
      name: p.label.split(' ')[0].slice(0, 3),
      Income: Number(p.month_income || 0),
      Expenses: Number(p.month_expenses || 0),
      Cash: Number(p.total_cash || 0),
    }));

  if (data.length < 2)
    return <p className="rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">Trends appear once several months are finalized.</p>;

  const tip = { formatter: (v) => fmtCurrency(v, { cents: false }) };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Income vs. Expenses</p>
        <div className="mt-5 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip {...tip} />
              <Legend />
              <Bar dataKey="Income" fill="#0f766e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expenses" fill="#a8a29e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="rounded-2xl border border-stone-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Total Cash</p>
        <div className="mt-5 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000000)}M`} tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip {...tip} />
              <Line type="monotone" dataKey="Cash" stroke="#1c1917" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}