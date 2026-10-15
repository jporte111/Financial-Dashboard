// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CauseList, ReviewGroups } from './admin/PublicationReview';
import { groupByCause } from '../../base44/shared/checklistCore.ts';

// Grouped review cards: read-only; warnings need no reason; a structural
// member is marked as must-fix. Fictional data.
afterEach(cleanup);
const m = (code, kind, problem = `Fictional ${code}.`) => ({ code, kind, title: code, problem, action: '', where: '' });
const CAUSES = groupByCause([
  m('cross_period:month_vs_ytd:income', 'warning'), m('cross_period:month_vs_ytd:expenses', 'warning'),
  m('required_value_missing:total_cash', 'warning'), m('cross_period:closed_quarter_missing:alpha:q2', 'warning'),
  m('open_reconciliation:duplicate_section_conflict:cash', 'blocker'),
  m('transfers_ended', 'warning'),
], { previousLabel: 'Month 9 2030' });

describe('cause cards', () => {
  it('workbook gaps are one card of warnings, with no reason box', () => {
    render(<CauseList causes={CAUSES} bucket="warnings" />);
    const card = screen.getByTestId('cause-workbook_gaps');
    expect(card.textContent).toMatch(/2 findings/);
    expect(card.textContent).toMatch(/never \$0\.00/);
    expect(card.querySelector('input')).toBeNull();
    expect(card.querySelector('button')).toBeNull();
  });

  it('upstream previous-month incompleteness is one card', () => {
    render(<CauseList causes={CAUSES} bucket="warnings" />);
    expect(screen.getByTestId('cause-previous_month_incomplete').textContent).toMatch(/Month 9 2030's published figures look incomplete · 2 findings/);
  });

  it('a structural problem is its own blocker card', () => {
    render(<CauseList causes={CAUSES} bucket="blockers" />);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByText(/A section appears twice with different figures/)).toBeTruthy();
  });

  it('Review & Publish lists causes by bucket, counting causes and findings', () => {
    const review = { blockers: [], needsReview: [{ code: 'checklist_incomplete', kind: 'checklist', title: 'Checklist item not confirmed', problem: 'Cash: not confirmed yet.' }], warnings: [], completed: [], notes: [], causes: CAUSES };
    render(<ReviewGroups review={review} comparedWith="Month 9 2030" />);
    expect(screen.getByTestId('review-blockers').textContent).toMatch(/Blockers — must be fixed \(1\)/);
    expect(screen.getByTestId('review-needsReview').textContent).toMatch(/Cash: not confirmed yet/);
    expect(screen.getByTestId('review-warnings').textContent).toMatch(/\(3\) · 5 findings.*never block and need no written reason/);
  });
});
