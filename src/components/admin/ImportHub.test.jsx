// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import * as XLSX from 'xlsx';

// No network: the import components pull in the Base44 client at module load.
vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: { me: () => Promise.resolve({ role: 'admin', email: 'admin@example.com' }) },
    entities: {
      ReportingPeriod: { list: () => Promise.resolve([]), filter: () => Promise.resolve([]) },
      BudgetLine: { filter: () => Promise.resolve([]) },
      CashAccount: { filter: () => Promise.resolve([]) },
      Distribution: { filter: () => Promise.resolve([]) },
      RecurringTransfer: { filter: () => Promise.resolve([]) },
    },
    functions: { invoke: () => Promise.resolve({ data: {} }) },
  },
}));

import ImportHub from './ImportHub';

afterEach(cleanup);

function LocationProbe({ onChange }) {
  const loc = useLocation();
  React.useEffect(() => {
    onChange(loc.search);
  }, [loc.search, onChange]);
  return null;
}

function renderHub(probe) {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <ImportHub />
      {probe}
    </MemoryRouter>
  );
}

// A minimal but real .xlsx the BVA parser can read, so the confirm fields render.
// jsdom's File has no arrayBuffer(), so we attach the bytes directly.
function makeBvaFile() {
  const rows = [
    ['BVA Sample August 2026'],
    ['CASH'],
    ['Current Bank Balances'],
    ['2026-07-31'],
    ['First Checking', 100],
    ['Total Cash:', 100],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'June');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const file = new File([bytes], 'SS-Budget-August-2026.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  file.arrayBuffer = () => Promise.resolve(bytes);
  return file;
}

describe('Admin Import hub — BVA is the only financial-data source; QuickBooks is fully removed', () => {
  it('has three subtabs: BVA Import, BVA Review and Transaction Detail (drill-down only) — no QuickBooks Import', () => {
    renderHub();
    expect(screen.getByRole('tab', { name: /^BVA Import$/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^BVA Review$/i })).toBeTruthy();
    // Phase 5b: the Transaction Report export supplies drill-down detail only; it never feeds a figure
    expect(screen.getByRole('tab', { name: /^Transaction Detail$/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /quickbooks/i })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('defaults to the BVA Import subtab and shows the BVA workbook control', () => {
    const { container } = renderHub();
    expect(within(container).getByText(/Monthly BVA Workbook/i)).toBeTruthy();
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput.getAttribute('accept')).toMatch(/\.xlsx/);
    // no QuickBooks controls, buttons, or instructional text anywhere in the hub
    expect(within(container).queryByText(/Budget Overview CSV/i)).toBeNull();
    expect(within(container).queryByText(/Transaction Report XLSX/i)).toBeNull();
    expect(within(container).queryByText(/quickbooks/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /commit to database/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sync from quickbooks/i })).toBeNull();
  });

  it('uploading a workbook on the BVA Import subtab reveals the reporting-period confirmation fields', async () => {
    const { container } = renderHub();
    const fileInput = container.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [makeBvaFile()] } });

    await waitFor(() => {
      expect(within(container).getByText('Reporting month')).toBeTruthy();
      expect(within(container).getByText('Reporting year')).toBeTruthy();
      expect(within(container).getByText('Reporting cutoff date')).toBeTruthy();
      expect(within(container).getByRole('button', { name: /Import \(draft\)/i })).toBeTruthy();
    });
    // cutoff pre-fills from the workbook cell, not the filename
    const dateInput = container.querySelector('input[type="date"]');
    expect(dateInput.value).toBe('2026-07-31');
    // still no QuickBooks anywhere after interacting with the form
    expect(within(container).queryByText(/quickbooks/i)).toBeNull();
  });

  it('selecting BVA Review shows no QuickBooks content either', async () => {
    const { container } = renderHub();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^BVA Review$/i }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /^BVA Review$/i }).getAttribute('data-state')).toBe('active'));
    expect(within(container).queryByText(/quickbooks/i)).toBeNull();
  });

  it('switching subtabs is reflected in the URL query as bva / bva-review only', async () => {
    let search = '';
    renderHub(<LocationProbe onChange={(s) => { search = s; }} />);

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^BVA Review$/i }));
    await waitFor(() => expect(search).toMatch(/import=bva-review/));

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^BVA Import$/i }));
    await waitFor(() => expect(search).toMatch(/import=bva(?!-review)/));
  });
});
