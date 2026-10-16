// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The updated-BVA workflow on the Import screen: a published month says
// "corrected report", shows what changed, lists previous corrections that are
// not applied, refuses an identical re-upload, and asks the server
// (prepare_import) for the target BEFORE any write. Fictional data.
const h = vi.hoisted(() => ({ periods: [], records: {}, invokes: [], writes: [], prepare: null, parsed: null }));
vi.mock('@/lib/bvaParser', () => ({ parseBvaWorkbook: () => h.parsed() }));
vi.mock('@/api/base44Client', () => {
  const ent = (name) => ({
    list: () => Promise.resolve(name === 'ReportingPeriod' ? h.periods : []),
    filter: (q) => Promise.resolve(name === 'ReportingPeriod' ? h.periods : (h.records[q.period_id]?.[name] || [])),
    create: (d) => { h.writes.push([name, 'create', d]); return Promise.resolve({ id: 'new', ...d }); },
    bulkCreate: (d) => { h.writes.push([name, 'bulkCreate', d]); return Promise.resolve(d); },
    update: (id, d) => { h.writes.push([name, 'update', id, d]); return Promise.resolve({ id, ...d }); },
    delete: (id) => { h.writes.push([name, 'delete', id]); return Promise.resolve({}); },
  });
  return {
    base44: {
      auth: { me: () => Promise.resolve({ role: 'admin', email: 'admin@example.invalid' }) },
      entities: Object.fromEntries(['ReportingPeriod', 'BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend'].map((n) => [n, ent(n)])),
      functions: { invoke: (fn, body) => { h.invokes.push([fn, body]); if (body?.action === 'prepare_import') return h.prepare(body); return Promise.resolve({ data: { ok: true } }); } },
    },
  };
});
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import BvaImportCenter from './BvaImportCenter';
import { cleanParsed, SAMPLE_CUTOFF } from '@/lib/__fixtures__/bvaSample';
import { validateBva } from '@/lib/bvaValidation';
import { planBvaImport } from '@/lib/bvaImport';

function publishedAugust() {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const plan = planBvaImport({ parsed, validation, confirm: { month: 8, year: 2026, cutoffDate: SAMPLE_CUTOFF } });
  const rows = (b, k) => b.toCreate.map((r, i) => ({ id: `${k}${i}`, period_id: 'jul', ...r }));
  h.periods = [{ id: 'jul', label: 'August 2026', ...plan.periodData, status: 'final', bva_import_status: 'final', finalized_at: 'x', published: true, bva_parsed_source: parsed,
    bva_corrections: [{ id: 's1', kind: 'source', target: 'Fictional cash fix', path: 'cash.reportedTotal', original_value: 1, value: 2, reason: 'earlier fix', by: 'a', at: 't' }] }];
  h.records.jul = { BudgetLine: rows(plan.budgetLines, 'l'), CashAccount: rows(plan.cashAccounts, 'c'), Distribution: rows(plan.distributions, 'd'), RecurringTransfer: rows(plan.transfers, 't') };
}
const upload = () => {
  const input = document.querySelector('input[type="file"]');
  const file = new File(['x'], 'BVA Test July.xlsx');
  file.arrayBuffer = () => Promise.resolve(new ArrayBuffer(1));
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => { h.invokes = []; h.writes = []; publishedAugust(); });
afterEach(cleanup);

describe('uploading an updated workbook for a published month', () => {
  it('says it becomes a corrected report, shows what changed, and lists previous corrections not applied', async () => {
    h.parsed = () => { const p = cleanParsed(); p.cash.accounts[0].balance += 100; p.cash.reportedTotal += 100; return p; };
    render(<BvaImportCenter />);
    upload();
    const banner = await screen.findByTestId('import-target');
    await waitFor(() => expect(banner.dataset.mode).toBe('correct'));
    expect(banner.textContent).toMatch(/August 2026 is published.*corrected August 2026 report.*Clients keep seeing the current report/);
    expect(screen.getByPlaceholderText(/Optional note about this correction/)).toBeTruthy();
    const summary = await screen.findByTestId('change-summary');
    expect(summary.textContent).toMatch(/compared with the published August 2026 report/);
    expect(summary.textContent).toMatch(/Total Cash/);
    expect((await screen.findByTestId('previous-corrections')).textContent).toMatch(/Previous corrections not applied \(1\).*Fictional cash fix/);
    expect(screen.getByRole('button', { name: /Import correction/ })).toBeTruthy();
    expect(h.writes).toEqual([]); // nothing written before Import
  });

  it('Import correction asks the server for the target first; a refusal writes nothing', async () => {
    h.parsed = () => { const p = cleanParsed(); p.cash.accounts[0].balance += 100; p.cash.reportedTotal += 100; return p; };
    h.prepare = () => Promise.reject({ response: { status: 409, data: { blockers: [{ code: 'copy_unverified', message: 'The copy of the published report is not finished yet.' }] } } });
    render(<BvaImportCenter />);
    upload();
    const btn = await screen.findByRole('button', { name: /Import correction/ });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(h.invokes.some(([, b]) => b?.action === 'prepare_import')).toBe(true));
    const call = h.invokes.find(([, b]) => b?.action === 'prepare_import')[1];
    expect(call).toMatchObject({ month: 8, year: 2026, filename: 'BVA Test July.xlsx' });
    expect(await screen.findByText(/not finished yet.*Nothing was imported/)).toBeTruthy();
    expect(h.writes).toEqual([]);
  });

  it('the same workbook as the published report: nothing to correct, Import is disabled', async () => {
    h.parsed = () => cleanParsed();
    render(<BvaImportCenter />);
    upload();
    expect((await screen.findByTestId('duplicate-upload')).textContent).toMatch(/same figures as the published August 2026 report; there is nothing to correct/);
    expect(screen.getByRole('button', { name: /Import correction/ }).disabled).toBe(true);
  });
});
