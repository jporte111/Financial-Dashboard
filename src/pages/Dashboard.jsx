import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBvaDashboard } from '@/lib/useBvaDashboard';
import { fmtCurrency, fmtPct, FLAG_TEXT } from '@/lib/finance';
import PaceComparison from '@/components/PaceComparison';
import WarningStatusPanel from '@/components/WarningStatusPanel';
import { SECTION_STATE, SECTION_STATE_TEXT } from '@/lib/bvaDashboard';
import SnapshotCards from '@/components/SnapshotCards';
import GroupOverview from '@/components/GroupOverview';
import SectionHeading from '@/components/SectionHeading';
import CategoryTable from '@/components/CategoryTable';
import CategoryDrilldown from '@/components/CategoryDrilldown';
import CashCard from '@/components/CashCard';
import RecurringTransfersCard from '@/components/RecurringTransfersCard';
import StatusPill from '@/components/StatusPill';
import { AlertTriangle } from 'lucide-react';

const DETAIL_FILTERS = [
  ['all', 'All'],
  ['fixed', 'Fixed'],
  ['variable', 'Variable'],
  ['discretionary', 'Discretionary'],
  ['savings', 'Savings'],
  ['unassigned', 'Unassigned'],
  ['attention', 'Needs Attention'],
];

function StateNote({ state, className = '' }) {
  if (!state || state === SECTION_STATE.OK) return null;
  const isDiscrepancy = state === SECTION_STATE.DISCREPANCY;
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${
        isDiscrepancy ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-800'
      } ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{SECTION_STATE_TEXT[state]}</p>
    </div>
  );
}

export default function Dashboard() {
  const { vm, loading, periodId, period } = useBvaDashboard();
  const [selected, setSelected] = useState(null);
  const [detailFilter, setDetailFilter] = useState('all');

  const detailRows = useMemo(() => {
    if (!vm) return [];
    if (detailFilter === 'attention') return vm.attention;
    if (detailFilter === 'all') return vm.detail;
    // Fixed/Variable/Discretionary filters exclude unassigned rows; the
    // Unassigned filter shows only rows with no confirmed group.
    return vm.detail.filter((d) => d.group === detailFilter);
  }, [vm, detailFilter]);

  if (loading) return <div className="py-24 text-center text-sm text-stone-400">Loading…</div>;

  const monthMode = vm.monthMode;

  return (
    <div className="space-y-14">
      {vm.provenance.label && (
        <div
          className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${
            vm.provenance.isLegacy ? 'border-stone-300 bg-stone-100 text-stone-700' : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {vm.provenance.label}. Figures below are shown from this period's stored values and have not passed the BVA
            import validation.
          </p>
        </div>
      )}

      {vm.warnings.list.length > 0 && <WarningStatusPanel warnings={vm.warnings} period={period} />}

      <section>
        <SectionHeading
          title="Financial Snapshot"
          subtitle={`${vm.labels.reportHeading}${vm.labels.dataThrough ? ` · ${vm.labels.dataThrough}` : ''} · ${
            vm.provenance.isBvaValidated ? 'BVA-validated' : vm.provenance.isLegacy ? 'Legacy — not BVA-validated' : 'Draft BVA import'
          }`}
        />
        <SnapshotCards vm={vm} />
      </section>

      <section>
        <SectionHeading
          title="Budget Overview"
          subtitle={monthMode ? 'Current month against expected monthly allocation' : 'Year-to-date performance against expected pace'}
        />
        <StateNote state={vm.states.groups} className="mb-4" />
        {vm.states.groups !== SECTION_STATE.NOT_IMPORTED && (
          <GroupOverview groups={vm.groups} monthMode={monthMode} expectedPacePct={vm.pacePct} />
        )}
      </section>

      {!monthMode && vm.attention.length > 0 && (
        <section>
          <SectionHeading title="Categories Needing Attention" subtitle="Flagged from validated BVA detail · largest Over Budget variance first" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {vm.attention.map((d) => (
              <button
                key={d.id || d.code}
                onClick={() => setSelected(d)}
                className="rounded-2xl border border-stone-200 bg-white p-5 text-left transition hover:shadow-[0_2px_24px_rgba(0,0,0,0.05)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{d.category}</p>
                    {d.code && <p className="text-xs uppercase tracking-[0.12em] text-stone-400">{d.code}</p>}
                  </div>
                  <StatusPill status={d.ytd.status} />
                </div>
                <div className="mt-4">
                  <PaceComparison view={d.ytd} savings={d.group === 'savings'} emphasized />
                </div>
                <div className="mt-4 space-y-1 text-sm text-stone-500">
                  <p>{fmtCurrency(d.ytd.actual)} of {fmtCurrency(d.ytd.annual)}</p>
                  <p>{fmtPct(d.ytd.percentUsed * 100)} of annual budget used</p>
                </div>
                <p className="mt-4 text-xs text-stone-400">
                  {d.reasons.map((r) => FLAG_TEXT[r]).filter(Boolean).join(' · ')}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeading
          title="Spending Detail"
          subtitle="Monitored categories from the validated BVA report"
          right={<Link to="/budget" className="text-sm text-stone-500 underline-offset-4 hover:underline">View all</Link>}
        />
        <div className="mb-4 flex flex-wrap gap-1">
          {DETAIL_FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setDetailFilter(k)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                detailFilter === k ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <StateNote state={vm.states.detail} className="mb-4" />
        <CategoryTable rows={detailRows} monthMode={monthMode} onSelect={setSelected} />
      </section>

      <section>
        <SectionHeading title="Savings & Distributions" />
        {vm.distributions.reconciles === false && (
          <StateNote state={SECTION_STATE.DISCREPANCY} className="mb-4" />
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Distributions YTD', vm.savingsDistributions.distributionsYtd, 'Calculated from quarterly distributions', SECTION_STATE.MISSING],
            ['Savings / Distributions In', vm.savingsDistributions.savingsIn, 'Not in the BVA workbook — enter and confirm in Admin', SECTION_STATE.NEEDS_REVIEW],
            ['Expenses Paid From Savings', vm.savingsDistributions.savingsSpend, 'Not in the BVA workbook — enter and confirm in Admin', SECTION_STATE.NEEDS_REVIEW],
            ['Net Savings', vm.savingsDistributions.netSavings, 'Savings In − Expenses From Savings', SECTION_STATE.MISSING],
          ].map(([label, value, note, missingState]) => (
            <div key={label} className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</p>
              <p className={`mt-3 font-display tracking-tight tabular-nums ${value == null ? 'text-lg text-stone-400' : 'text-2xl'}`}>
                {value == null ? 'Not provided' : fmtCurrency(value)}
              </p>
              {note && <p className="mt-2 text-xs text-stone-400">{note}</p>}
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Link to="/savings" className="text-sm text-stone-500 underline-offset-4 hover:underline">View savings activity</Link>
        </div>
      </section>

      <section>
        <SectionHeading title="Cash" subtitle={vm.labels.cashAsOf} />
        <StateNote state={vm.states.cash} className="mb-4" />
        <CashCard
          total={vm.cash.total}
          rows={vm.cash.accounts}
          reconciles={vm.cash.reconciles}
          reportedTotal={vm.cash.reportedTotal}
        />
      </section>

      <section>
        <RecurringTransfersCard transfers={vm.transfers.items} />
      </section>

      <CategoryDrilldown line={selected} periodId={periodId} monthsElapsed={vm.elapsedMonths} onClose={() => setSelected(null)} />
    </div>
  );
}