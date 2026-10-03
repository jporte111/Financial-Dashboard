// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

// Rendered output for Phase 3 (missing values on screen). Fictional figures.
const state = vi.hoisted(() => ({ dists: [], period: null }));
vi.mock('@/api/base44Client', () => ({ base44: { entities: { Transaction: { filter: async () => [] } } } }));
vi.mock('@/lib/usePeriod', () => ({ usePeriodContext: () => ({ period: state.period, periodId: 'p' }) }));
vi.mock('@/lib/usePeriodEntities', () => ({
  useEntityByPeriod: (name) => ({ items: name === 'Distribution' ? state.dists : [], loading: false, reload: () => {} }),
}));

import PaceComparison from './PaceComparison';
import SnapshotCards from './SnapshotCards';
import BudgetBar from './BudgetBar';
import Variance from './Variance';
import CashCard from './CashCard';
import RecurringTransfersCard from './RecurringTransfersCard';
import SavingsDistributions from '../pages/SavingsDistributions';
import { buildBvaDashboard } from '@/lib/bvaDashboard';

afterEach(cleanup);

const PERIOD = { id: 'p', label: 'September 2026', month: 9, year: 2026, months_elapsed: 8, reporting_cutoff_date: '2026-08-31', status: 'final', published: true, bva_import_status: 'final' };
const line = (id, group, month) => ({ id, category: id, budget_group: group, bva_detail: false, group_confirmed: true, ytd_actual: 100, annual_budget: 1200, month_actual: month });

describe('no fabricated zeros, no implied "on pace"', () => {
  it('a missing pace comparison says so', () => {
    render(<PaceComparison view={{ mode: 'ytd', actual: null, annual: 1200, varianceToPace: null }} />);
    expect(screen.getByText(/Comparison unavailable — source value missing/)).toBeTruthy();
    expect(screen.queryByText(/On expected YTD pace/)).toBeNull();
  });

  it('a missing variance shows "—", not "On pace"', () => {
    render(<Variance amount={null} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/On pace/)).toBeNull();
  });

  it('a missing percentage renders an empty, labelled bar', () => {
    render(<BudgetBar pct={null} status="under_pace" />);
    expect(screen.getByRole('img', { name: /No figure in the source/ })).toBeTruthy();
  });
});

describe('current-month cards', () => {
  it('no month figures: "Source value missing" (the live September case)', () => {
    const vm = buildBvaDashboard({ period: PERIOD, budgetLines: [line('inc', 'income', null), line('fix', 'fixed', null), line('var', 'variable', null), line('dis', 'discretionary', null)] }, { month: true });
    render(<SnapshotCards vm={vm} />);
    expect(screen.getAllByText('Source value missing')).toHaveLength(2);
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('a partial month total is labelled partial', () => {
    const vm = buildBvaDashboard({ period: PERIOD, budgetLines: [line('inc', 'income', 50), line('fix', 'fixed', 10), line('var', 'variable', null), line('dis', 'discretionary', 5)] }, { month: true });
    render(<SnapshotCards vm={vm} />);
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getByText(/Partial — excludes lines with no current-month figure/)).toBeTruthy();
  });

  it('explicit zeros show $0.00 with "No current-month activity imported."', () => {
    const vm = buildBvaDashboard({ period: PERIOD, budgetLines: [line('inc', 'income', 0), line('fix', 'fixed', 0), line('var', 'variable', 0), line('dis', 'discretionary', 0)] }, { month: true });
    render(<SnapshotCards vm={vm} />);
    expect(screen.getAllByText('$0.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('No current-month activity imported.')).toHaveLength(2);
  });
});

describe('partial totals are labelled', () => {
  it('cash: a missing balance shows "—" and the total is labelled partial', () => {
    render(<CashCard total={100} accounts={[{ id: 'a', name: 'Acct A', balance: 100 }, { id: 'b', name: 'Acct B' }]} defaultOpen />);
    expect(screen.getByTestId('cash-partial').textContent).toMatch(/Partial total — 1 account has no balance/);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('transfers: the total says partial when an amount is missing', () => {
    render(<RecurringTransfersCard transfers={[{ id: 't1', amount: 500, purpose: 'Reserve', source: 'Acct A' }, { id: 't2', purpose: 'Lease', source: 'Acct B' }]} />);
    expect(screen.getByText(/\$500\.00 monthly/).textContent).toMatch(/partial — 1 without an amount/);
  });
});

describe('distributions table (Savings & Distributions page)', () => {
  it('cutoff Aug 31: Q4 is "—" not yet applicable; a blank begun quarter is "—" missing; a confirmed 0 is $0.00; totals say partial', () => {
    state.period = { ...PERIOD, distributions_ytd: 35 };
    state.dists = [
      { id: 'a', entity_name: 'Alpha', q1: 10, q2: 0, q3: 20, q4: null },
      { id: 'b', entity_name: 'Beta', q1: 5, q2: null, q3: 0, q4: null },
    ];
    render(<SavingsDistributions />);
    const alpha = screen.getByText('Alpha').closest('tr');
    const cells = within(alpha).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['Alpha', '$10.00', '$0.00', '$20.00', '—', '$30.00']);
    expect(cells[4].getAttribute('title')).toMatch(/Not yet applicable/);
    const beta = screen.getByText('Beta').closest('tr');
    const bcells = within(beta).getAllByRole('cell');
    expect(bcells[2].textContent).toBe('—');
    expect(bcells[2].getAttribute('title')).toBe('Source value missing');
    expect(bcells[5].textContent).toMatch(/\$5\.00\s*partial/);
    expect(screen.getByTestId('distribution-legend').textContent).toMatch(/Q4: not yet applicable/);
    expect(screen.getByTestId('distribution-legend').textContent).toMatch(/source value missing/);
  });
});
