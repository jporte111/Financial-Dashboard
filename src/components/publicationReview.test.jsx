// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Review & Publish (Phase 6c): the checklist with who/when and the four
// plain-language groups, all from the server's check. Fictional data.
const state = vi.hoisted(() => ({ check: null, calls: [] }));
vi.mock('@/lib/periodTransition', () => ({
  periodTransition: async (action, id, extra) => { state.calls.push([action, id, extra]); return action === 'check' ? state.check : { ok: true }; },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));

import PublishPanel from './admin/PublishPanel';

const PERIOD = { id: 'p8', label: 'Month 8 2030', month: 8, year: 2030, status: 'final', bva_import_status: 'final', finalized_at: 'x', published: false, checklist: {} };
const item = (key, label, st, extra = {}) => ({ key, label, state: st, blockedBy: [], changedParts: [], newWarnings: [], by: null, at: null, ...extra });
const CHECK = {
  ok: true,
  finalize: { blockers: [] },
  publish: { blockers: [{ code: 'cross_period:closed_quarter_missing:x:q1', message: 'Q1 blank', overridable: false }] },
  cross_period: { previous: { id: 'p7', label: 'Month 7 2030' }, findings: [] },
  checklist: {
    items: [
      item('cash_confirmed', 'Cash balances confirmed', 'stale', { by: 'admin@example.invalid', at: '2030-09-01T10:00:00Z', changedParts: ['cash_accounts'] }),
      item('income_reviewed', 'Income reviewed', 'confirmed', { by: 'admin@example.invalid', at: '2030-09-01T10:00:00Z' }),
      item('distributions_confirmed', 'Distribution totals confirmed', 'blocked', { blockedBy: ['cross_period:closed_quarter_missing:x:q1'] }),
      item('categories_reviewed', 'Categories reviewed', 'unconfirmed'),
    ],
  },
  review: {
    blockers: [{ code: 'cross_period:closed_quarter_missing:x:q1', title: 'A closed distribution quarter is blank', problem: 'Q1 blank', action: 'A blank is not $0.00. Enter the amount.', where: 'BVA Import' }],
    needsReview: [{ code: 'checklist_incomplete', title: 'Checklist item not confirmed', problem: 'Categories reviewed: not confirmed yet.', action: 'Review the item and confirm it.', where: 'Review & Publish' }],
    warnings: [{ code: 'transfers_ended', title: 'Recurring transfers ended', problem: '1 recurring transfer(s) are not in this period.', action: 'Check they ended on purpose.', where: 'Review & Publish' }],
    completed: [{ code: 'passed:cash_total_mismatch', title: 'Cash accounts add up to Total Cash', problem: 'No issues found.' }],
    notes: [{ code: 'new_year', problem: 'Year-to-date figures restart this year.' }],
  },
};
afterEach(() => { cleanup(); state.calls = []; });

describe('Review & Publish: four groups, in plain language', () => {
  it('shows blockers, needs review, warnings (with the compared period) and completed checks', async () => {
    state.check = CHECK;
    render(<PublishPanel period={PERIOD} reload={() => {}} />);
    expect((await screen.findByTestId('review-blockers')).textContent).toMatch(/closed distribution quarter is blank.*What to do: A blank is not \$0\.00/);
    expect(screen.getByTestId('review-needsReview').textContent).toMatch(/Categories reviewed: not confirmed yet/);
    expect(screen.getByTestId('review-warnings').textContent).toMatch(/compared with Month 7 2030.*Recurring transfers ended/);
    expect(screen.getByTestId('review-warnings').textContent).toMatch(/1 note/);
    expect(screen.getByTestId('review-completed').textContent).toMatch(/Cash accounts add up to Total Cash/);
  });
});

describe('Review & Publish: the checklist', () => {
  it('each item says its state and why; only the stale item names what changed', async () => {
    state.check = CHECK;
    render(<PublishPanel period={PERIOD} reload={() => {}} />);
    const cash = await screen.findByTestId('checklist-cash_confirmed');
    expect(cash.dataset.state).toBe('stale');
    expect(cash.textContent).toMatch(/needs confirming again -- cash accounts changed since admin@example.invalid confirmed on 2030-09-01/);
    expect(screen.getByTestId('checklist-income_reviewed').textContent).toMatch(/confirmed by admin@example.invalid on 2030-09-01/);
    const blocked = screen.getByTestId('checklist-distributions_confirmed');
    expect(blocked.textContent).toMatch(/cannot be confirmed until this issue is resolved: A closed distribution quarter is blank/);
    expect(blocked.querySelector('button').disabled).toBe(true);
  });

  it('Confirm and Withdraw go to the server (who/when are recorded there)', async () => {
    state.check = CHECK;
    render(<PublishPanel period={PERIOD} reload={() => {}} />);
    const cash = await screen.findByTestId('checklist-cash_confirmed');
    fireEvent.click(cash.querySelector('button'));
    await waitFor(() => expect(state.calls).toContainEqual(['confirm_checklist', 'p8', { item: 'cash_confirmed' }]));
    fireEvent.click(screen.getByTestId('checklist-income_reviewed').querySelector('button'));
    await waitFor(() => expect(state.calls).toContainEqual(['unconfirm_checklist', 'p8', { item: 'income_reviewed' }]));
  });

  it('a published period shows what was recorded, read-only', async () => {
    state.check = { ok: true, finalize: { blockers: [] }, publish: { blockers: [] }, cross_period: null, checklist: null, review: null };
    const published = { ...PERIOD, published: true, checklist: { cash_confirmed: true, income_reviewed: true }, checklist_confirmations: { income_reviewed: { by: 'admin@example.invalid', at: '2030-09-02T00:00:00Z' } } };
    render(<PublishPanel period={published} reload={() => {}} />);
    const list = await screen.findByTestId('checklist-readonly');
    expect(list.textContent).toMatch(/Income reviewedconfirmed by admin@example.invalid on 2030-09-02/);
    expect(list.textContent).toMatch(/Cash balances confirmedticked \(before who\/when was recorded\)/);
    expect(list.querySelector('button')).toBeNull();
    expect(screen.queryByTestId('review-groups')).toBeNull();
  });
});
