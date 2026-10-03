import React from 'react';
import { fmtCurrency } from '@/lib/finance';
import { getPath, isStaleCorrection } from '@/lib/bvaCorrections';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { Card, SavingsCard, GroupMappingCard, TransferLabelsCard, DistributionZeroCard } from '@/components/admin/BvaCorrectionCards';

const KIND_LABEL = {
  source: 'Source value',
  zero_confirm: 'Zero confirmed',
  transfer: 'Transfer label',
  group: 'Category group',
  savings: 'Savings figure',
  override: 'Override reason',
};

const showValue = (v) => (typeof v === 'number' ? fmtCurrency(v) : v == null || v === '' ? '—' : String(v));

function AuditTrail({ parsed, corrections = [], onRemove }) {
  if (!corrections.length) {
    return (
      <Card title="Adjustment audit trail">
        <p className="text-sm text-stone-500">No adjustments recorded. The workbook figures are used as parsed.</p>
      </Card>
    );
  }
  return (
    <Card title={`Adjustment audit trail (${corrections.length})`} subtitle="Original workbook value, corrected value, reason, user and time — carried through Apply and Finalize.">
      {corrections.map((c) => {
        const stale = isStaleCorrection(parsed, c);
        return (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 py-2 text-sm first:border-t-0">
            <div className="min-w-0">
              <p className="font-medium">
                {KIND_LABEL[c.kind] || c.kind}
                {c.target ? <span className="text-stone-400"> · {c.target}</span> : null}
              </p>
              <p className="text-xs text-stone-500">
                {c.kind === 'override'
                  ? 'Override reason recorded'
                  : (
                    <>
                      was {showValue(c.original_value)} → {showValue(c.value)}
                    </>
                  )}
                {c.reason ? ` · ${c.reason}` : ''}
                {stale && <span className="text-amber-700"> · stale — the workbook value changed</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-stone-400">
                {c.by || '—'}{c.at ? ` · ${new Date(c.at).toLocaleString()}` : ''}
              </p>
              <Button variant="ghost" size="sm" className="rounded-full" title="Remove this adjustment" onClick={() => onRemove(c)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

export default function BvaCorrectionsPanel({
  validation,
  parsed,
  corrections = [],
  onSave,
  onRemove,
  savedGroupMap = {},
  cutoffDate,
  saveState,
  by,
}) {
  const SAVE_LABEL = { saving: 'Saving…', saved: 'All adjustments saved to the draft', error: 'Could not save — try again' };
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6" data-testid="bva-corrections">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-lg">Adjustments &amp; corrections</p>
          <p className="text-sm text-stone-500">
            Applied over the original workbook — the workbook itself is preserved and every derived total is
            recalculated. Adjustments persist to the draft and carry through Apply and Finalize.
          </p>
        </div>
        {saveState && saveState !== 'idle' && (
          <span className={`text-xs ${saveState === 'error' ? 'text-rose-700' : saveState === 'saved' ? 'text-emerald-700' : 'text-stone-400'}`}>
            {SAVE_LABEL[saveState]}
          </span>
        )}
      </div>
      <div className="mt-5 space-y-4">
        <SavingsCard corrections={corrections} onSave={onSave} onRemove={onRemove} by={by} />
        <GroupMappingCard validation={validation} corrections={corrections} onSave={onSave} onRemove={onRemove} by={by} />
        <TransferLabelsCard validation={validation} corrections={corrections} onSave={onSave} onRemove={onRemove} by={by} />
        <DistributionZeroCard validation={validation} corrections={corrections} onSave={onSave} onRemove={onRemove} cutoffDate={cutoffDate} by={by} />
        <AuditTrail parsed={parsed} corrections={corrections} onRemove={onRemove} />
      </div>
    </div>
  );
}