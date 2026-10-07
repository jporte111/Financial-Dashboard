// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Drill-down states: a failed request is an error with a retry, never
// "no transactions". Fictional data.
const state = vi.hoisted(() => ({ replies: [], calls: [] }));
vi.mock('@/api/base44Client', () => ({
  base44: {
    functions: {
      invoke: async (name, body) => {
        state.calls.push([name, body]);
        const r = state.replies.shift();
        if (r instanceof Error) throw r;
        return { data: r };
      },
    },
  },
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import ClientDrilldown from './client/ClientDrilldown';
import CategoryDrilldown from './CategoryDrilldown';
import { drilldownOptions } from '@/lib/useDrilldownTransactions';

const LINE = { id: 'l1', category: 'Test Groceries', group: 'variable', ytd_actual: 100, annual_budget: 1200, month_actual: 10, qb_account_names: [] };
const httpError = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

beforeEach(() => { state.replies = []; state.calls = []; drilldownOptions.retryDelayMs = 1; });
afterEach(cleanup);

describe('client drill-down', () => {
  it('a failed request shows an error and a retry -- not "no transactions"', async () => {
    state.replies = [httpError(500), httpError(500), { period_id: 'p', category: 'Test Groceries', detail_available: false, transactions: [] }];
    render(<ClientDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    expect(await screen.findByTestId('drilldown-error')).toBeTruthy();
    expect(screen.queryByText(/No underlying transactions/i)).toBeNull();
    expect(state.calls).toHaveLength(2); // one automatic retry for a server error
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('drilldown-unavailable')).toBeTruthy();
  });

  it('a transient failure is retried once automatically and then succeeds', async () => {
    state.replies = [httpError(429), { period_id: 'p', category: 'Test Groceries', detail_available: false, transactions: [] }];
    render(<ClientDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    expect(await screen.findByTestId('drilldown-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('drilldown-error')).toBeNull();
  });

  it('a refusal (e.g. 403) is not retried and shows the error', async () => {
    state.replies = [httpError(403, { error: 'Period not published' })];
    render(<ClientDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    expect(await screen.findByTestId('drilldown-error')).toBeTruthy();
    expect(state.calls).toHaveLength(1);
  });

  it('asks the public endpoint by budget line and shows that detail is not offered', async () => {
    state.replies = [{ period_id: 'p', category: 'Test Groceries', detail_available: false, transactions: [] }];
    render(<ClientDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    expect(await screen.findByTestId('drilldown-unavailable')).toBeTruthy();
    expect(state.calls[0]).toEqual(['publicCategoryTransactions', { period_id: 'p', budget_line_id: 'l1', category: 'Test Groceries' }]);
  });
});

describe('admin drill-down', () => {
  it('shows the server\'s refusal for a replaced version, with a retry', async () => {
    state.replies = [httpError(409, { error: 'This version was replaced by a newer one; open the current version.', code: 'superseded_version' })];
    render(<CategoryDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    const err = await screen.findByTestId('drilldown-error');
    expect(err.textContent).toMatch(/replaced by a newer one/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('distinguishes "no matching transactions" (a real answer) from an error', async () => {
    state.replies = [{ period_id: 'p', category: 'Test Groceries', transactions: [] }];
    render(<CategoryDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    expect(await screen.findByTestId('drilldown-empty')).toBeTruthy();
  });

  it('shows rows for an admin', async () => {
    state.replies = [{ period_id: 'p', category: 'Test Groceries', transactions: [{ id: 't1', date: '2026-08-10', vendor: 'Test Market', amount: 12 }] }];
    render(<CategoryDrilldown line={LINE} periodId="p" monthsElapsed={8} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Test Market')).toBeTruthy());
  });
});
