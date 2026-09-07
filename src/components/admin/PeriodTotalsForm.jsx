import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';

const FIELDS = [
  ['total_cash', 'Total Cash'],
  ['ytd_income', 'YTD Income'],
  ['ytd_expenses', 'YTD Expenses'],
  ['month_income', 'Current Month Income'],
  ['month_expenses', 'Current Month Expenses'],
  ['distributions_ytd', 'Distributions YTD'],
  ['savings_in_ytd', 'Savings / Distributions In'],
  ['savings_spend_ytd', 'Expenses Paid From Savings'],
  ['months_elapsed', 'Months Elapsed (budget pace)'],
];

// These fields legitimately have no value until one is entered. A blank input
// must be saved as null ("Source value missing" / "Mapping requires review"),
// never coerced to a fabricated 0 that reads as a confirmed figure.
const NULLABLE = new Set(['month_income', 'month_expenses', 'savings_in_ytd', 'savings_spend_ytd']);

export default function PeriodTotalsForm({ period, reload }) {
  const [form, setForm] = useState(period || {});
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  if (!period) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 text-sm text-stone-500">
        No reporting period selected. Import a BVA workbook or create a period first.
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    const payload = Object.fromEntries(
      FIELDS.map(([k]) => {
        const raw = form[k];
        const blank = raw === '' || raw == null;
        if (blank && NULLABLE.has(k)) return [k, null];
        return [k, Number(raw || 0)];
      })
    );
    await base44.entities.ReportingPeriod.update(period.id, {
      ...payload,
      last_updated: new Date().toISOString().slice(0, 10),
    });
    setSaving(false);
    toast({ title: 'Monthly totals saved' });
    reload();
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Monthly Totals — {period.label}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <Label className="text-xs text-stone-500">{label}</Label>
            <Input
              type="number"
              step="0.01"
              value={form[k] ?? ''}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              className="mt-1"
            />
          </div>
        ))}
      </div>
      <Button onClick={save} disabled={saving} className="mt-5 rounded-full">
        {saving ? 'Saving…' : 'Save Totals'}
      </Button>
    </div>
  );
}