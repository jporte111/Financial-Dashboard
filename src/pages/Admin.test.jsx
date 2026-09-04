// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: { me: () => Promise.resolve({ role: 'admin', email: 'admin@example.com' }) },
    entities: {
      ReportingPeriod: { list: () => Promise.resolve([]), filter: () => Promise.resolve([]) },
      BudgetLine: { filter: () => Promise.resolve([]) },
      CashAccount: { filter: () => Promise.resolve([]) },
      Distribution: { filter: () => Promise.resolve([]) },
      RecurringTransfer: { filter: () => Promise.resolve([]) },
      SavingsSpend: { filter: () => Promise.resolve([]) },
      Transaction: { filter: () => Promise.resolve([]) },
      Account: { list: () => Promise.resolve([]) },
    },
    functions: { invoke: () => Promise.resolve({ data: {} }) },
  },
}));

import Admin from './Admin';
import { PeriodProvider } from '@/lib/usePeriod';

afterEach(cleanup);

function renderAdmin(ctxOverrides = {}) {
  const ctx = {
    user: { role: 'admin', email: 'admin@example.com' },
    isAdmin: true,
    period: null,
    periodId: null,
    periods: [],
    setPeriodId: vi.fn(),
    reload: vi.fn(),
    ytdMode: true,
    setYtdMode: vi.fn(),
    loading: false,
    ...ctxOverrides,
  };
  return render(
    <MemoryRouter>
      <PeriodProvider value={ctx}>
        <Admin />
      </PeriodProvider>
    </MemoryRouter>
  );
}

describe('Admin bootstrap with no reporting period (bootstrap bug fix)', () => {
  it('shows the "no period" banner and defaults to the Import tab, not Monthly Data', () => {
    const { container } = renderAdmin();
    expect(screen.getByText(/No reporting period exists yet/i)).toBeTruthy();

    // Import tab (BVA Import subtab, its default) is showing, not Monthly Totals.
    // (Admin's own tabpanel nests ImportHub's tabpanel, so scope by container instead.)
    expect(within(container).getByText(/Monthly BVA Workbook/i)).toBeTruthy();
    expect(within(container).queryByText(/Monthly Totals/i)).toBeNull();
  });

  it('renders the BVA workbook upload control with no reporting period selected', () => {
    const { container } = renderAdmin();
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput.getAttribute('accept')).toMatch(/\.xlsx/);
  });

  it('clicking into Monthly Data shows a safe fallback instead of crashing', async () => {
    renderAdmin();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Monthly Data/i }));
    await waitFor(() => {
      expect(screen.getByText(/No reporting period selected/i)).toBeTruthy();
    });
  });

  it('clicking into Review & Publish shows a safe fallback instead of crashing', async () => {
    renderAdmin();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Review & Publish/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/No reporting period selected/i).length).toBeGreaterThan(0);
    });
  });

  it('there is no Reconciliation tab and no QuickBooks tab (removed with the QuickBooks disconnect)', () => {
    renderAdmin();
    expect(screen.queryByRole('tab', { name: /Reconciliation/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /quickbooks/i })).toBeNull();
  });
});

describe('Admin with an existing reporting period (regression guard)', () => {
  it('defaults to Monthly Data and shows no "missing period" banner', () => {
    renderAdmin({
      period: { id: 'p1', label: 'July 2026', month: 7, year: 2026, checklist: {}, status: 'draft' },
      periodId: 'p1',
      periods: [{ id: 'p1', label: 'July 2026' }],
    });
    expect(screen.queryByText(/No reporting period exists yet/i)).toBeNull();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/Monthly Totals — July 2026/i)).toBeTruthy();
  });
});
