import React, { useState } from 'react';
import { fmtCurrency } from '@/lib/finance';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SAVINGS_FIELDS } from '@/lib/bvaCorrections';

const QUARTER_LABEL = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

export function Card({ title, subtitle, children }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-stone-500">{title}</p>
      {subtitle && <p className="mt-0.5 text-xs text-stone-400">{subtitle}</p>}
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

export const savingsFieldLabel = (f) =>
  f === 'savings_in_ytd' ? 'Savings / Distributions In (YTD)' : 'Expenses Paid From Savings (YTD)';

export function SavingsCard({ corrections = [], onSave, onRemove, by }) {
  const existingFor = (f) => corrections.find((c) => c.kind === 'savings' && c.target === f);
  const commit = (f, raw) => {
    const existing = existingFor(f);
    const num = String(raw).trim() === '' ? null : Number(raw);
    if (num == null || !Number.isFinite(num)) {
      if (existing) onRemove(existing);
      return;
    }
    onSave({ kind: 'savings', target: f, originalValue: null, value: num, reason: 'Entered in Import Center (not in the workbook)', by });
  };
  return (
    <Card title="Savings figures" subtitle="Not present in the BVA workbook — enter them here. An explicit 0 is a confirmed zero; leaving blank stays unverified.">
      {SAVINGS_FIELDS.map((f) => {
        const existing = existingFor(f);
        return (
          <div key={f} className="flex flex-wrap items-center gap-2">
            <span className="w-64 text-sm text-stone-600">{savingsFieldLabel(f)}</span>
            <Input
              type="number"
              className="h-8 w-36 text-xs tabular-nums"
              key={`${f}-${existing ? existing.at : 'blank'}`}
              defaultValue={existing ? existing.value : ''}
              placeholder="Not entered"
              onBlur={(e) => commit(f, e.target.value)}
            />
            {existing && (
              <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => onRemove(existing)}>
                Clear
              </Button>
            )}
          </div>
        );
      })}
    </Card>
  );
}

const normCode = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const GROUP_LABEL = { fixed: 'Fixed', variable: 'Variable', discretionary: 'Discretionary', savings: 'Savings', unassigned: 'Unassigned' };

export function GroupMappingCard({ validation, corrections = [], onSave, onRemove, by }) {
  const cats = validation?.reconciled?.detail?.categories || [];
  const correctionFor = (key) => corrections.find((c) => c.kind === 'group' && c.target === key);
  const unmapped = cats.filter((c) => (c.group || 'unassigned') === 'unassigned').length;
  return (
    <Card title="Category groups" subtitle={`Fixed / Variable / Discretionary mapping for every watch-list (DETAIL) category. ${unmapped ? `${unmapped} still unassigned.` : 'All mapped.'}`}>
      {cats.map((cat) => {
        const key = normCode(cat.code);
        const correction = correctionFor(key);
        const value = correction ? correction.value : cat.group || 'unassigned';
        return (
          <div key={cat.code || cat.name} className="flex flex-wrap items-center gap-2">
            <span className="w-56 truncate text-sm text-stone-700" title={cat.name}>{cat.name}</span>
            <span className="text-xs tabular-nums text-stone-400">{cat.code || 'no code'}</span>
            <select
              className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs"
              value={value}
              disabled={!cat.code}
              onChange={(e) => {
                if (!cat.code) return;
                if (e.target.value === 'unassigned') {
                  if (correction) onRemove(correction);
                  return;
                }
                onSave({ kind: 'group', target: key, originalValue: null, value: e.target.value, reason: `Mapped to ${GROUP_LABEL[e.target.value] || e.target.value} in Import Center`, by });
              }}
            >
              {Object.keys(GROUP_LABEL).map((g) => (
                <option key={g} value={g}>{GROUP_LABEL[g]}</option>
              ))}
            </select>
            <span className="text-xs text-stone-400">
              {correction ? 'adjusted here' : cat.groupConfirmed ? 'confirmed on the draft' : 'unassigned'}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

export function TransferLabelsCard({ validation, corrections = [], onSave, onRemove, by }) {
  const items = validation?.reconciled?.transfers?.items || [];
  return (
    <Card title="Transfer labels" subtitle="Source and purpose for each recurring transfer, as carried into the dashboard.">
      {items.map((t, i) => (
        <div key={i} className="rounded-lg border border-stone-100 p-2">
          <p className="text-xs text-stone-500 tabular-nums">{fmtCurrency(t.amount)}</p>
          {['source', 'purpose'].map((field) => {
            const path = `transfers.items.${i}.${field}`;
            const correction = corrections.find((c) => c.kind === 'transfer' && c.path === path);
            const original = correction ? correction.original_value : t[field];
            const current = correction ? correction.value : t[field];
            return (
              <div key={field} className="mt-1 flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs text-stone-400 capitalize">{field}</span>
                <Input
                  className="h-8 flex-1 text-xs"
                  key={`${path}-${correction ? correction.at : 'orig'}`}
                  defaultValue={current == null ? '' : String(current)}
                  placeholder="—"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v === String(original == null ? '' : original)) {
                      if (correction) onRemove(correction); // reverted to the workbook value
                      return;
                    }
                    if (!v) {
                      if (correction) onRemove(correction);
                      return;
                    }
                    onSave({ kind: 'transfer', target: `Transfer ${i + 1} ${field}`, path, originalValue: original == null ? null : original, value: v, reason: 'Corrected in Import Center', by });
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}

function ZeroConfirmRow({ label, correction, onConfirm, onRemove, by }) {
  const [reason, setReason] = useState('');
  if (correction) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/50 p-2">
        <div>
          <p className="text-sm text-stone-700">{label}</p>
          <p className="text-xs text-stone-500">
            Confirmed $0 received · {correction.reason}{correction.by ? ` · ${correction.by}` : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" className="rounded-full text-xs" onClick={() => onRemove(correction)}>
          Leave unverified
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-100 p-2">
      <span className="w-48 text-sm text-stone-700">{label}</span>
      <Input className="h-8 flex-1 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        variant="outline"
        size="sm"
        className="rounded-full text-xs"
        disabled={!reason.trim()}
        onClick={() => onConfirm(reason.trim())}
      >
        Confirm $0 received
      </Button>
    </div>
  );
}

export function DistributionZeroCard({ validation, corrections = [], onSave, onRemove, cutoffDate, by }) {
  const cutYm = /^(\d{4})-(\d{2})/.exec(cutoffDate || '');
  const cutMonth = cutYm ? Number(cutYm[2]) : null;
  const begunQ = cutMonth == null ? [] : ['q1', 'q2', 'q3', 'q4'].filter((q, i) => cutMonth >= i * 3 + 1);
  const rows = [];
  (validation?.reconciled?.distributions?.entities || []).forEach((e, i) => {
    begunQ.forEach((q) => {
      if (e[q] == null) rows.push({ e, i, q });
    });
  });
  return (
    <Card title="Blank distribution quarters" subtitle="Quarters that have begun with a blank cell. Confirm $0 received (recorded as an explicit zero), or leave unverified — a blank stays 'unknown', never $0.00.">
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">No blank cells among quarters that have begun.</p>
      ) : (
        rows.map(({ e, i, q }) => {
          const path = `distributions.entities.${i}.${q}`;
          return (
            <ZeroConfirmRow
              key={path}
              label={`${e.name} · ${QUARTER_LABEL[q]}`}
              correction={corrections.find((c) => c.kind === 'zero_confirm' && c.path === path)}
              onConfirm={(reason) =>
                onSave({ kind: 'zero_confirm', target: `${e.name} ${QUARTER_LABEL[q]}`, path, originalValue: null, value: 0, reason, by })
              }
              onRemove={onRemove}
              by={by}
            />
          );
        })
      )}
    </Card>
  );
}

// Warning-driven control: correct the workbook-extracted value inline (an
// adjustment recorded against the original), or leave the workbook value and
// record only an override reason.
export function SourceValueControl({ warning, correction, onSave, onRemove, by }) {
  const pct = warning.code === 'pace_proxy_divergence';
  const fmtV = (v) => (pct ? `${Number(v).toFixed(2)}%` : fmtCurrency(v));
  const [reason, setReason] = useState(correction ? correction.reason : '');
  const [value, setValue] = useState(correction ? String(correction.value) : '');
  if (correction) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-stone-600">
          Adjusted: {fmtV(warning.sourceValue)} → {fmtV(correction.value)}
        </span>
        <span className="text-xs text-stone-400">
          {correction.reason}{correction.by ? ` · ${correction.by}` : ''}
        </span>
        <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => onRemove(correction)}>
          Remove
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        type="number"
        className="h-8 w-36 text-xs tabular-nums"
        placeholder={warning.sourceValue == null ? 'Corrected value' : `Correct from ${fmtV(warning.sourceValue)}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Input className="h-8 w-56 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button
        variant="outline"
        size="sm"
        className="h-7 rounded-full text-xs"
        disabled={!reason.trim() || value === '' || Number.isNaN(Number(value))}
        onClick={() =>
          onSave({
            kind: 'source',
            target: warning.code,
            path: warning.sourcePath,
            originalValue: warning.sourceValue == null ? null : warning.sourceValue,
            value: Number(value),
            reason: reason.trim(),
            by,
          })
        }
      >
        Record adjustment
      </Button>
    </div>
  );
}