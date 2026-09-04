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

describe('Admin Import hub — both importers reachable, neither replaced', () => {
  it('defaults to the BVA Import subtab and shows the BVA workbook control', () => {
    renderHub();
    expect(screen.getByRole('tab', { name: /^BVA Import$/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /QuickBooks Import/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /BVA Review/i })).toBeTruthy();

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/Monthly BVA Workbook/i)).toBeTruthy();
    const fileInput = panel.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput.getAttribute('accept')).toMatch(/\.xlsx/);
    // legacy QuickBooks controls are NOT in the BVA panel
    expect(within(panel).queryByText(/Budget Overview CSV/i)).toBeNull();
  });

  it('uploading a workbook on the BVA Import subtab reveals the reporting-period confirmation fields', async () => {
    renderHub();
    const fileInput = screen.getByRole('tabpanel').querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [makeBvaFile()] } });

    await waitFor(() => {
      const p = screen.getByRole('tabpanel');
      // exact-text labels (avoids matching the instruction sentence)
      expect(within(p).getByText('Reporting month')).toBeTruthy();
      expect(within(p).getByText('Reporting year')).toBeTruthy();
      expect(within(p).getByText('Reporting cutoff date')).toBeTruthy();
      expect(within(p).getByRole('button', { name: /Apply import \(Draft\)/i })).toBeTruthy();
    });
    // cutoff pre-fills from the workbook cell, not the filename
    const dateInput = screen.getByRole('tabpanel').querySelector('input[type="date"]');
    expect(dateInput.value).toBe('2026-07-31');
  });

  it('selecting QuickBooks Import renders the two legacy QuickBooks upload controls', async () => {
    renderHub();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /QuickBooks Import/i }));

    await waitFor(() => {
      const panel = screen.getByRole('tabpanel');
      expect(within(panel).getByText('Budget Overview CSV')).toBeTruthy();
      expect(within(panel).getByText('Transaction Report XLSX')).toBeTruthy();
      expect(within(panel).getByRole('button', { name: /Commit to database/i })).toBeTruthy();
    });
    expect(within(screen.getByRole('tabpanel')).queryByText(/Monthly BVA Workbook/i)).toBeNull();
  });

  it('switching subtabs is reflected in the URL query (?import=...)', async () => {
    let search = '';
    renderHub(<LocationProbe onChange={(s) => { search = s; }} />);

    fireEvent.mouseDown(screen.getByRole('tab', { name: /QuickBooks Import/i }));
    await waitFor(() => expect(search).toMatch(/import=quickbooks/));

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^BVA Import$/i }));
    await waitFor(() => expect(search).toMatch(/import=bva/));
  });
});
