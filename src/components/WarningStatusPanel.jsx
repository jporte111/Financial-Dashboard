import React from 'react';
import { AlertTriangle, CheckCircle2, Info, Scale } from 'lucide-react';
import WarningDecision from '@/components/WarningDecision';

// Classified validation warnings. Every warning stays listed — its resolution
// status and the recorded reason / audit note are shown alongside it rather
// than the warning being hidden or deleted.
const GROUPS = [
  { key: 'unresolved', label: 'Needs a decision', icon: AlertTriangle, badge: 'border-amber-300 bg-amber-50 text-amber-900' },
  { key: 'accepted', label: 'Accepted exception', icon: Scale, badge: 'border-stone-300 bg-stone-100 text-stone-700' },
  { key: 'resolved', label: 'Resolved', icon: CheckCircle2, badge: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  { key: 'informational', label: 'Informational', icon: Info, badge: 'border-stone-200 bg-stone-100 text-stone-600' },
];

export default function WarningStatusPanel({ warnings, period = null }) {
  if (!warnings || !Array.isArray(warnings.list) || warnings.list.length === 0) return null;
  const { resolution, list, unresolved } = warnings;
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-lg tracking-tight">Validation Warnings</h3>
        <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
          {unresolved.length === 0
            ? 'None need a decision'
            : `${unresolved.length} of ${list.length} need${unresolved.length === 1 ? 's' : ''} a decision`}
        </p>
      </div>
      <div className="mt-4 space-y-5">
        {GROUPS.map(({ key, label, icon: Icon, badge }) =>
          (resolution[key] || []).length ? (
            <div key={key}>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-stone-400">{label}</p>
              <div className="mt-2 space-y-2">
                {resolution[key].map((w) => (
                  <div
                    key={w.code}
                    className="flex items-start gap-3 rounded-xl border border-stone-100 bg-stone-50/60 p-3 text-sm"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-stone-400" />
                    <div className="min-w-0 flex-1">
                      <p className="text-stone-800">{w.message}</p>
                      {w.note && <p className="mt-1 text-xs text-stone-500">{w.note}</p>}
                      {key === 'unresolved' && <WarningDecision warning={w} period={period} />}
                    </div>
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge}`}
                    >
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null
        )}
      </div>
    </section>
  );
}