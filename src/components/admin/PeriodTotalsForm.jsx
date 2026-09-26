import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { TOTALS_FIELDS as FIELDS, totalsWrite } from '@/lib/periodTotals';
import { effectiveRecord } from '../../../base44/shared/sourceMissing.ts';

// A blank input means "missing" -- shown as missing everywhere, never saved as
// a fabricated 0 (see src/lib/periodTotals.js).
export default function PeriodTotalsForm({ period, reload }) {
  const [form, setForm] = useState(effectiveRecord(period || {}));
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
    const write = totalsWrite(period, form);
    if (write.error) {
      toast({ title: 'Not saved', description: write.error });
      return;
    }
    setSaving(true);
    try {
      await base44.entities.ReportingPeriod.update(period.id, write.data);
      toast({ title: 'Monthly totals saved' });
      reload();
    } catch (e) {
      toast({ title: 'Not saved', description: e?.data?.message || e?.message || 'The update was refused.' });
    } finally {
      setSaving(false);
    }
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