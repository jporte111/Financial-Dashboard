// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Review & Publish shows the server's cross-period comparison. Fictional data.
const state = vi.hoisted(() => ({ check: null }));
vi.mock('@/lib/periodTransition', () => ({ periodTransition: async () => state.check }));
vi.mock('@/api/base44Client', () => ({ base44: { entities: { ReportingPeriod: { update: async () => {} } } } }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import PublishPanel from './admin/PublishPanel';

const PERIOD = { id: 'p8', label: 'Month 8 2030', month: 8, year: 2030, status: 'final', bva_import_status: 'final', finalized_at: 'x', published: false, checklist: {} };
afterEach(cleanup);

describe('Review & Publish: cross-period review', () => {
  it('lists warnings and notes, and the compared period; blockers appear with the others', async () => {
    state.check = {
      ok: true,
      finalize: { ok: true, blockers: [] },
      publish: { ok: false, blockers: [{ code: 'cross_period:ytd_income_decreased', message: 'Total income year-to-date is lower than in Month 7 2030 (by 5.0%).', overridable: true }] },
      cross_period: {
        previous: { id: 'p7', label: 'Month 7 2030' },
        findings: [
          { code: 'ytd_income_decreased', severity: 'override', message: 'Total income year-to-date is lower than in Month 7 2030 (by 5.0%).' },
          { code: 'transfers_ended', severity: 'warn', message: '1 recurring transfer(s) in Month 7 2030 are not in this period.' },
          { code: 'not_comparable:month_income', severity: 'info', message: 'This month\'s income is missing.' },
        ],
      },
    };
    render(<PublishPanel period={PERIOD} reload={() => {}} />);
    const panel = await screen.findByTestId('cross-period-review');
    expect(panel.textContent).toMatch(/compared with Month 7 2030/);
    expect(panel.textContent).toMatch(/recurring transfer/);
    expect(panel.textContent).toMatch(/1 note/);
    expect(screen.getByText(/Publication blocked until resolved/)).toBeTruthy();
    expect(screen.getAllByText(/Total income year-to-date is lower/).length).toBe(1); // a blocker, not repeated as a warning
  });

  it('is not shown for a published period (never re-judged)', async () => {
    state.check = { ok: true, finalize: { blockers: [] }, publish: { blockers: [] }, cross_period: null };
    render(<PublishPanel period={{ ...PERIOD, published: true }} reload={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('cross-period-review')).toBeNull();
  });
});
