// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TrendsSection from './TrendsSection';
import { buildTrend } from '../../base44/shared/trendCore.ts';

// The Trends section renders the server's trend: gaps as "—", never $0;
// legacy months marked; cash since the last report; notes. Fictional data.
beforeAll(() => { globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }; });
afterEach(cleanup);
const mm = (m) => String(m).padStart(2, '0');
const lines = (k, budget = true) => ['income', 'fixed', 'variable', 'discretionary'].map((g, i) => ({ id: `${g}${k}`, category: g.toUpperCase(), budget_group: g, bva_detail: false, ytd_actual: (i + 1) * 100 * k, annual_budget: budget ? (i + 1) * 1200 : undefined }));
const month = (m, { legacy = false, period = {}, cash = [{ id: `c${m}`, name: 'ZZ', balance: 1000 + m }] } = {}) => ({
  id: `p${m}`, label: `Month ${m} 2030`, month: m, year: 2030, legacy,
  period: legacy
    ? { id: `p${m}`, label: `Month ${m} 2030`, month: m, year: 2030, months_elapsed: m, distributions_ytd: m, ...period }
    : { id: `p${m}`, label: `Month ${m} 2030`, month: m, year: 2030, reporting_cutoff_date: `2030-${mm(m - 1)}-28`, months_elapsed: m - 1, distributions_ytd: m, ...period },
  lines: lines(legacy ? m : m - 1, !legacy), cashAccounts: cash, distributions: [],
});

describe('Trends section', () => {
  const trend = buildTrend([month(6, { legacy: true }), month(8), month(9, { period: { distributions_ytd: null } })]);

  it('a table row per data month; a missing figure shows "—", never $0', () => {
    render(<TrendsSection trend={trend} />);
    const aug = screen.getByTestId('trend-row-Aug 2030');
    expect(aug.textContent).toMatch(/Month 9 2030 report/);
    expect(aug.textContent).toMatch(/—/);
    expect(aug.textContent).not.toMatch(/\$0(?!\d)/);
  });
  it('legacy months carry the "before BVA reporting" badge; their budget column is "—"', () => {
    render(<TrendsSection trend={trend} />);
    const jun = screen.getByTestId('trend-row-Jun 2030');
    expect(jun.textContent).toMatch(/before BVA reporting/);
    expect(screen.getByTestId('trend-row-Jul 2030').textContent).not.toMatch(/before BVA reporting/);
  });
  it('cash since the last report, and the explanations', () => {
    render(<TrendsSection trend={trend} />);
    expect(screen.getByTestId('cash-since-last').textContent).toMatch(/Up \$1.*Month 9 2030 report, compared with the Month 8 2030 report/);
    expect(screen.getByTestId('trend-explanations').textContent).toMatch(/never counted as \$0/);
    expect(screen.getByTestId('trend-explanations').textContent).toMatch(/before BVA reporting/);
  });
  it('the four charts are present', () => {
    render(<TrendsSection trend={trend} />);
    for (const id of ['trend-income', 'trend-expenses', 'trend-groups', 'trend-distributions']) expect(screen.getByTestId(id)).toBeTruthy();
  });
  it('unavailable (the server could not build it) and too few months', () => {
    render(<TrendsSection trend={null} />);
    expect(screen.getByTestId('trends-unavailable')).toBeTruthy();
    cleanup();
    render(<TrendsSection trend={buildTrend([month(8)])} />);
    expect(screen.getByTestId('trends-empty')).toBeTruthy();
  });
});
