import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { PeriodProvider, usePeriodData } from '@/lib/usePeriod';
import PeriodSelector from '@/components/PeriodSelector';
import { Eye, LogOut } from 'lucide-react';
import { formatDateOnly } from '@/lib/finance';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/budget', label: 'Budget' },
  { to: '/savings', label: 'Savings & Distributions' },
  { to: '/cash', label: 'Cash' },
  { to: '/reports', label: 'Reports' },
];

export default function Layout() {
  const ctx = usePeriodData();
  const { pathname } = useLocation();
  const nav = ctx.isAdmin
    ? [...NAV, { to: '/admin', label: 'Admin' }, { to: '/admin?tab=warnings', label: 'Validation Warnings' }]
    : NAV;
  // Admin (and the BVA Import workflow inside it) must stay reachable even
  // before any reporting period exists — that is where the first period gets
  // created. Every other page still needs a period to show anything useful.
  const bypassNoPeriod = ctx.isAdmin && pathname.startsWith('/admin');

  return (
    <PeriodProvider value={ctx}>
      <div className="min-h-screen bg-[#faf9f7] text-stone-900">
        <header className="border-b border-stone-200/80 bg-white/80 backdrop-blur">
          <div className="mx-auto max-w-6xl px-6 pt-8 pb-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl md:text-3xl tracking-tight">Sonia Financial Dashboard</h1>
                {ctx.period && (
                  <p className="mt-2 text-xs uppercase tracking-[0.14em] text-stone-500">
                    Last Updated {ctx.period.last_updated ? formatDateOnly(ctx.period.last_updated) : '—'}
                    <span className="mx-2 text-stone-300">|</span>
                    Reporting Status: {ctx.period.status === 'final' ? 'Final' : 'Preliminary'}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {ctx.period && (
                  <button
                    onClick={() => ctx.setYtdMode(!ctx.ytdMode)}
                    className={`hidden sm:inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium uppercase tracking-[0.14em] transition ${
                      ctx.ytdMode
                        ? 'border-stone-900 bg-stone-900 text-white'
                        : 'border-stone-200 bg-white text-stone-500 hover:bg-stone-100'
                    }`}
                    title={ctx.ytdMode ? 'Showing year-to-date (Jan 1 through selected month)' : 'Showing selected month only — click for year-to-date'}
                  >
                    {ctx.ytdMode ? 'Year to Date' : 'This Month'}
                  </button>
                )}
                <PeriodSelector periods={ctx.periods} periodId={ctx.periodId} onChange={ctx.setPeriodId} />
                <Link
                  to="/client"
                  className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-500 transition hover:bg-stone-100 hover:text-stone-700"
                  title="Open Sonia's client view (no login)"
                >
                  <Eye className="h-4 w-4" />
                  <span className="hidden md:inline">Client View</span>
                </Link>
                <button
                  onClick={() => base44.auth.logout('/login')}
                  className="rounded-full p-2.5 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                  title="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
            <nav className="mt-6 flex gap-1 overflow-x-auto">
              {nav.map((n) => {
                const [nPath, nQuery] = n.to.split('?');
                const active =
                  n.to === '/'
                    ? pathname === '/'
                    : pathname.startsWith(nPath) && (nQuery ? window.location.search.includes(nQuery) : !window.location.search.includes('tab=warnings'));
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={`whitespace-nowrap rounded-full px-4 py-2 text-sm transition ${
                      active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">
          {ctx.loading ? (
            <div className="py-32 text-center text-sm text-stone-400">Loading…</div>
          ) : !ctx.period && !bypassNoPeriod ? (
            <div className="rounded-2xl border border-stone-200 bg-white p-16 text-center">
              <p className="font-display text-xl">No published reporting period yet</p>
              <p className="mt-2 text-sm text-stone-500">Your monthly report will appear here once it has been finalized.</p>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </PeriodProvider>
  );
}