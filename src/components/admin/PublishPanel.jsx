import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';

const ITEMS = [
  ['categories_reviewed', 'Categories reviewed'],
  ['classes_reviewed', 'Classes reviewed'],
  ['refunds_reviewed', 'Refunds reviewed'],
  ['income_reviewed', 'Income reviewed'],
  ['cash_confirmed', 'Cash balances confirmed'],
  ['distributions_confirmed', 'Distribution totals confirmed'],
  ['budget_report_reviewed', 'Budget report reviewed'],
];

const STAGES = [
  ['draft', 'Draft'],
  ['transactions_posted', 'Transactions Posted'],
  ['categories_reviewed', 'Categories Reviewed'],
  ['classes_reviewed', 'Classes Reviewed'],
  ['reports_reviewed', 'Reports Reviewed'],
  ['final', 'Final'],
];

export default function PublishPanel({ period, user, reload }) {
  const [checklist, setChecklist] = useState(period.checklist || {});
  const { toast } = useToast();
  const complete = ITEMS.every(([k]) => checklist[k]);

  const toggle = async (k, v) => {
    const next = { ...checklist, [k]: v };
    setChecklist(next);
    await base44.entities.ReportingPeriod.update(period.id, { checklist: next });
    reload();
  };

  const setStage = async (status) => {
    await base44.entities.ReportingPeriod.update(period.id, { status });
    toast({ title: `Stage set to ${status.replace(/_/g, ' ')}` });
    reload();
  };

  const publish = async () => {
    await base44.entities.ReportingPeriod.update(period.id, {
      status: 'final',
      published: true,
      publication_date: new Date().toISOString().slice(0, 10),
      reviewed_by: user?.full_name || user?.email || '',
    });
    toast({ title: 'Published to Sonia' });
    reload();
  };

  const unpublish = async () => {
    await base44.entities.ReportingPeriod.update(period.id, { published: false, status: 'draft' });
    toast({ title: 'Reporting period reopened' });
    reload();
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <p className="font-display text-lg">Review & Publication — {period.label}</p>

      <div className="mt-5">
        <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Workflow Stage</p>
        <Select value={period.status} onValueChange={setStage}>
          <SelectTrigger className="mt-2 w-[260px]"><SelectValue /></SelectTrigger>
          <SelectContent>{STAGES.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="mt-6 space-y-3">
        <p className="text-xs uppercase tracking-[0.12em] text-stone-500">Pre-Publication Checklist</p>
        {ITEMS.map(([k, label]) => (
          <label key={k} className="flex items-center gap-3 text-sm">
            <Checkbox checked={!!checklist[k]} onCheckedChange={(v) => toggle(k, !!v)} />
            {label}
          </label>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={publish} disabled={!complete} className="rounded-full">
          {period.published ? 'Re-publish' : 'Mark Final & Publish to Sonia'}
        </Button>
        {period.published && (
          <Button variant="outline" className="rounded-full" onClick={unpublish}>Reopen Period</Button>
        )}
      </div>
      {!complete && <p className="mt-3 text-xs text-stone-500">Complete every checklist item to publish.</p>}
      {period.published && (
        <p className="mt-3 text-xs text-emerald-700">
          Published{period.publication_date ? ` on ${period.publication_date}` : ''}{period.reviewed_by ? ` · reviewed by ${period.reviewed_by}` : ''}
        </p>
      )}
    </div>
  );
}