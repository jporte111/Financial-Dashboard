// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Controls what usePeriodData() sees, per test.
let mockRole = 'admin';
let mockPeriods = []; // no reporting periods exist at all

vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: {
      me: () => Promise.resolve({ role: mockRole, email: 'admin@example.com' }),
      logout: () => {},
    },
    entities: {
      ReportingPeriod: { list: () => Promise.resolve(mockPeriods) },
    },
  },
}));

import Layout from './Layout';

afterEach(cleanup);

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>DASHBOARD PAGE</div>} />
          <Route path="/admin" element={<div>ADMIN PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Admin stays reachable with no reporting period (bootstrap bug fix)', () => {
  it('an admin visiting /admin with zero periods sees the Admin page, not the "no period" placeholder', async () => {
    mockRole = 'admin';
    mockPeriods = [];
    renderAt('/admin');
    await waitFor(() => expect(screen.getByText('ADMIN PAGE')).toBeTruthy());
    expect(screen.queryByText(/No published reporting period yet/i)).toBeNull();
  });

  it('an admin visiting the Dashboard with zero periods still sees the "no period" placeholder (unchanged)', async () => {
    mockRole = 'admin';
    mockPeriods = [];
    renderAt('/');
    await waitFor(() => expect(screen.getByText(/No published reporting period yet/i)).toBeTruthy());
    expect(screen.queryByText('DASHBOARD PAGE')).toBeNull();
  });

  it('a non-admin visiting /admin with zero periods still sees the placeholder (bypass is admin-only)', async () => {
    mockRole = 'user';
    mockPeriods = [];
    renderAt('/admin');
    await waitFor(() => expect(screen.getByText(/No published reporting period yet/i)).toBeTruthy());
    expect(screen.queryByText('ADMIN PAGE')).toBeNull();
  });

  it('an admin visiting /admin when a period DOES exist still sees the Admin page (regression guard)', async () => {
    mockRole = 'admin';
    mockPeriods = [{ id: 'p1', label: 'July 2026', month: 7, year: 2026, published: true, status: 'final' }];
    renderAt('/admin');
    await waitFor(() => expect(screen.getByText('ADMIN PAGE')).toBeTruthy());
  });
});
