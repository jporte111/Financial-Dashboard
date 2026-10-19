import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePublicDashboard } from '@/lib/usePublicDashboard';
import CategoryTable from '@/components/CategoryTable';
import ClientHeader from '@/components/client/ClientHeader';
import HeroMetrics from '@/components/client/HeroMetrics';
import GroupCards from '@/components/client/GroupCards';
import ClientSidePanel from '@/components/client/ClientSidePanel';
import ClientDrilldown from '@/components/client/ClientDrilldown';
import TrendsSection from '@/components/TrendsSection';

// Public client view — no login required. Renders only published periods and
// client-visible fields (enforced server-side by the publicDashboard function).
// Anonymous visitors who hit any internal route are redirected here.
export default function ClientView() {
  const { loading, error, vm, periods, period, setSelectedId, trend } = usePublicDashboard();
  const [selectedLine, setSelectedLine] = useState(null);
  const [signedIn, setSignedIn] = useState(false);

  // A firm admin browsing from the admin side stays logged in — offer a
  // one-click return instead of the sign-in link. Only admins can use the
  // admin side, so only admins get the shortcut.
  useEffect(() => {
    base44.auth
      .me()
      .then((me) => setSignedIn(me?.role === 'admin'))
      .catch(() => setSignedIn(false));
  }, []);

  // Monitored watchlist categories, shown exactly as she sees them today —
  // minus the internal "mapping requires review" wording, which stays
  // behind login.
  const detailRows = useMemo(
    () => (vm?.detail || []).map((d) => ({ ...d, group: d.group === 'unassigned' ? null : d.group })),
    [vm]
  );

  return (
    <div className="min-h-screen bg-stone-50 font-body text-stone-900">
      <ClientHeader periods={periods} activePeriodId={period?.id} onSelectPeriod={setSelectedId} signedIn={signedIn} />

      <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {loading ? (
          <div className="py-32 text-center text-sm text-stone-400">Preparing your statement…</div>
        ) : error ? (
          <div className="py-32 text-center">
            <p className="font-display text-2xl tracking-tight">We couldn&apos;t load your statement</p>
            <p className="mt-2 text-sm text-stone-500">Please refresh the page, or contact Namaste Financial Management if it persists.</p>
          </div>
        ) : !vm ? (
          <div className="py-32 text-center">
            <p className="font-display text-3xl tracking-tight">Your report is being prepared</p>
            <p className="mt-2 text-sm text-stone-500">
              Your financial statement will appear here as soon as this month&apos;s report is published.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-6 text-sm text-stone-500 sm:mt-8" data-testid="report-line">{vm.labels.reportLine}</p>
            <HeroMetrics vm={vm} />

            <div className="mt-12 grid gap-8 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-8">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h2 className="font-display text-xl tracking-tight">Budget vs Actuals</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      Year to date against budget · open a group or category for its transactions
                    </p>
                  </div>
                </div>
                <GroupCards groups={vm.groups} pacePct={vm.pacePct} onSelect={setSelectedLine} />

                {detailRows.length > 0 && (
                  <section>
                    <h2 className="font-display text-xl tracking-tight">Monitored Categories</h2>
                    <p className="mt-1 mb-5 text-sm text-stone-500">Watchlist categories from the monthly report · click for transactions</p>
                    <CategoryTable rows={detailRows} monthMode={false} onSelect={setSelectedLine} />
                  </section>
                )}
              </div>
              <div className="lg:col-span-4">
                <ClientSidePanel vm={vm} />
              </div>
            </div>

            <section className="mt-14">
              <h2 className="font-display text-xl tracking-tight">Trends</h2>
              <p className="mt-1 mb-5 text-sm text-stone-500">Year to date, month by month, from your published reports. Each report is shown at the month its data runs through.</p>
              <TrendsSection trend={trend} />
            </section>

            <footer className="mt-16 border-t border-stone-200 py-8 text-xs text-stone-400">
              Prepared by Namaste Financial Management · {vm.labels.reportLine}
            </footer>
          </>
        )}
      </main>

      <ClientDrilldown
        line={selectedLine}
        periodId={period?.id}
        monthsElapsed={vm?.elapsedMonths}
        onClose={() => setSelectedLine(null)}
      />
    </div>
  );
}