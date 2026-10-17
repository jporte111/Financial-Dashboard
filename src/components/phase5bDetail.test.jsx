// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

// Phase 5b screens: the client drill-down (rows from the published report's
// attached detail) and the Transaction Detail importer. FICTIONAL data only.
const h = vi.hoisted(() => ({ answer: null, invokes: [], period: null, lines: [], maps: [], created: [] }));
vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: { me: async () => ({ role: 'admin', email: 'admin@example.invalid' }) },
    functions: { invoke: async (fn, body) => { h.invokes.push([fn, body]); return { data: typeof h.answer === 'function' ? h.answer(fn, body) : h.answer }; } },
    entities: {
      BudgetLine: { filter: async () => h.lines },
      DetailAccountMap: { list: async () => h.maps, create: async (d) => { h.created.push(d); h.maps = [...h.maps, d]; return d; } },
    },
  },
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/usePeriod', () => ({ usePeriodContext: () => ({ period: h.period, reload: () => {} }) }));

import ClientDrilldown from './client/ClientDrilldown';
import TransactionDetailImport from './admin/TransactionDetailImport';
import { makeDetailModel, detailWorkbookBytes } from '@/lib/__fixtures__/detailWorkbook';

beforeEach(() => { h.invokes = []; h.created = []; h.maps = []; });
afterEach(cleanup);

const LINE = { id: 'l1', category: 'VARIABLE', group: 'variable', ytd_actual: 100, annual_budget: 1200, month_actual: 10 };
const open = () => render(<ClientDrilldown line={LINE} periodId="p1" monthsElapsed={6} onClose={() => {}} />);

describe('client drill-down with attached detail', () => {
  it('rows grouped by plain account, credits tagged, the neutral note, and a month toggle', async () => {
    h.answer = { period_id: 'p1', category: 'VARIABLE', detail_available: true, data_month: '9102-06', note: 'The listed transactions total $40.00; the report shows $52.00. The report figure is the one used on this dashboard.',
      transactions: [
        { date: '9102-06-03', payee: 'ZZ Florist', amount: 50, account: 'ZZ Flowers' },
        { date: '9102-02-10', payee: 'ZZ Shop', amount: -10, account: 'ZZ Supplies' },
      ] };
    open();
    await screen.findByTestId('drilldown-rows');
    expect(screen.getByTestId('drilldown-note').textContent).toMatch(/The report figure is the one used on this dashboard/);
    expect(screen.getAllByTestId('drilldown-account').map((g) => g.querySelector('summary').textContent)).toEqual([expect.stringMatching(/^ZZ Flowers/), expect.stringMatching(/^ZZ Supplies/)]);
    expect(screen.getByText('Refund/Credit')).toBeTruthy();
    expect(screen.getAllByText('-$10.00').length).toBe(2); // the credit row and its account subtotal
    fireEvent.click(screen.getByRole('button', { name: /June 9102/ }));
    expect(screen.queryByText('ZZ Shop')).toBeNull(); // February row hidden in "this month"
    expect(screen.getByText('ZZ Florist')).toBeTruthy();
  });
  it('a watch-list line that does not reconcile: no rows, only the note', async () => {
    h.answer = { period_id: 'p1', category: '6550 ZZ MEDICAL', detail_available: true, transactions: [], note: 'Transaction detail isn\'t shown for this category in this report: the transaction ledger and the report figure don\'t match. The report figure is the one used on this dashboard.' };
    open();
    expect((await screen.findByTestId('drilldown-note')).textContent).toMatch(/isn't shown for this category/);
    expect(screen.queryByTestId('drilldown-rows')).toBeNull();
  });
  it('no attached detail: the unchanged message', async () => {
    h.answer = { period_id: 'p1', category: 'VARIABLE', detail_available: false, transactions: [] };
    open();
    expect((await screen.findByTestId('drilldown-unavailable')).textContent).toMatch(/isn't shown on this dashboard/);
  });
});

describe('Transaction Detail importer', () => {
  const model = makeDetailModel({ year: 9102, scale: 2, cutoffMonth: 6 });
  const upload = async (bytes) => {
    const input = screen.getByTestId('detail-file');
    const file = new File([bytes], 'ZZ Transaction Report.xlsx');
    file.arrayBuffer = async () => bytes;
    fireEvent.change(input, { target: { files: [file] } });
  };
  beforeEach(() => {
    h.period = { id: 'p1', label: 'July 9102', month: 7, year: 9102, reporting_cutoff_date: model.cutoff, status: 'draft', bva_import_status: 'draft', published: false };
    h.lines = [{ id: 'gv', category: 'VARIABLE', budget_group: 'variable', ytd_actual: 100 }];
    h.answer = (fn, body) => (body.action === 'commit_detail' ? { ok: true, detail_import: { rows_stored: 1 } } : { ok: true });
  });
  it('previews checks, counts (later rows only counted), reconciliation and unconfirmed accounts -- nothing written', async () => {
    render(<TransactionDetailImport />);
    await upload(detailWorkbookBytes(model));
    await screen.findByTestId('detail-summary');
    for (const k of ['layout', 'sum', 'balances', 'subtotals', 'structure']) expect(screen.getByTestId(`detail-check-${k}`).dataset.ok).toBe('yes');
    expect(screen.getByTestId('detail-after-cutoff').textContent).toMatch(/dated later .* not stored/);
    expect(screen.getByTestId('detail-line-group:variable').dataset.status).toBe('difference');
    expect(within(screen.getByTestId('detail-unconfirmed')).getAllByRole('button', { name: 'Confirm' }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('detail-unmapped').textContent).toMatch(/7215 - ZZ Card Interest/);
    expect(h.invokes).toEqual([]);
  });
  it('a file that fails a check cannot be attached', async () => {
    const bad = structuredClone(model);
    bad.rows.find((x) => /^\d\d\//.test(String(x.B || ''))).I += 1;
    render(<TransactionDetailImport />);
    await upload(detailWorkbookBytes(bad));
    await screen.findByTestId('detail-checks');
    expect(screen.getByTestId('detail-check-sum').dataset.ok).toBe('no');
    expect(screen.queryByTestId('detail-attach')).toBeNull();
  });
  it('confirming an account records its path and plain name', async () => {
    render(<TransactionDetailImport />);
    await upload(detailWorkbookBytes(model));
    const box = await screen.findByTestId('detail-unconfirmed');
    fireEvent.click(within(box).getAllByRole('button', { name: 'Confirm' })[0]);
    await waitFor(() => expect(h.created).toHaveLength(1));
    expect(h.created[0]).toEqual(expect.objectContaining({ account_path: expect.any(String), plain_name: expect.any(String), confirmed_by: 'admin@example.invalid' }));
  });
  it('attach stages every chunk, then commits once with the package', async () => {
    render(<TransactionDetailImport />);
    await upload(detailWorkbookBytes(model));
    fireEvent.click(await screen.findByTestId('detail-attach'));
    await screen.findByTestId('detail-result');
    const actions = h.invokes.map(([, b]) => b.action);
    expect(actions.filter((a) => a === 'stage_detail').length).toBeGreaterThan(0);
    expect(actions[actions.length - 1]).toBe('commit_detail');
    const commit = h.invokes[h.invokes.length - 1][1];
    expect(commit.package.rows.length).toBeGreaterThan(0);
    expect(commit.file).toEqual({ name: 'ZZ Transaction Report.xlsx', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
  it('a published report: the importer explains it is frozen and offers no attach', async () => {
    h.period = { ...h.period, published: true, status: 'final' };
    render(<TransactionDetailImport />);
    expect(screen.getByTestId('detail-refusal').textContent).toMatch(/frozen/);
    await upload(detailWorkbookBytes(model));
    const btn = await screen.findByTestId('detail-attach');
    expect(btn.disabled).toBe(true);
  });
});
