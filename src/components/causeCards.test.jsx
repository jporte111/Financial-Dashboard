// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CauseList, ReviewGroups } from './admin/PublicationReview';
import { groupByCause } from '../../base44/shared/checklistCore.ts';

// Grouped review cards: one reason for every overridable member; hard blockers
// are shown as such and never included. Fictional data.
afterEach(cleanup);
const m = (code, kind, problem = `Fictional ${code}.`) => ({ code, kind, title: code, problem, action: '', where: '' });
const CAUSES = groupByCause([
  m('cross_period:month_vs_ytd:income', 'reason'), m('cross_period:month_vs_ytd:expenses', 'reason'),
  m('required_value_missing:total_cash', 'reason'), m('cross_period:closed_quarter_missing:alpha:q2', 'blocker'),
  m('transfers_ended', 'warning'),
], { previousLabel: 'Month 9 2030' });

describe('cause cards', () => {
  it('one reason accepts every overridable member not yet given a reason; hard blockers are excluded', () => {
    const onAccept = vi.fn();
    render(<CauseList causes={CAUSES} bucket="blockers" reasons={{}} onAccept={onAccept} />);
    const card = screen.getByTestId('cause-workbook_gaps');
    expect(card.textContent).toMatch(/must be fixed \(cannot be accepted with a reason\)/);
    expect(card.textContent).toMatch(/1 of these must be fixed/);
    fireEvent.change(screen.getByTestId('cause-reason-workbook_gaps'), { target: { value: 'Bookkeeper sending the balance' } });
    fireEvent.click(screen.getByTestId('cause-accept-workbook_gaps'));
    expect(onAccept).toHaveBeenCalledWith(['required_value_missing:total_cash'], 'Bookkeeper sending the balance');
  });

  it('upstream previous-month incompleteness is one card; reasons already given are shown and not asked again', () => {
    const onAccept = vi.fn();
    render(<CauseList causes={CAUSES} bucket="needsReview" reasons={{ 'cross_period:month_vs_ytd:income': 'Checked' }} onAccept={onAccept} />);
    const card = screen.getByTestId('cause-previous_month_incomplete');
    expect(card.textContent).toMatch(/Month 9 2030's published figures look incomplete · 2 findings/);
    expect(screen.getByTestId('cause-given-previous_month_incomplete').textContent).toMatch(/Reason given for 1 of 2: “Checked”/);
    fireEvent.change(screen.getByTestId('cause-reason-previous_month_incomplete'), { target: { value: 'Same cause' } });
    fireEvent.click(screen.getByTestId('cause-accept-previous_month_incomplete'));
    expect(onAccept).toHaveBeenCalledWith(['cross_period:month_vs_ytd:expenses'], 'Same cause');
  });

  it('the accept button needs a written reason', () => {
    render(<CauseList causes={CAUSES} bucket="needsReview" reasons={{}} onAccept={() => {}} />);
    expect(screen.getByTestId('cause-accept-previous_month_incomplete').disabled).toBe(true);
  });

  it('Review & Publish lists causes read-only, counting causes and findings', () => {
    const review = { blockers: [], needsReview: [{ code: 'checklist_incomplete', kind: 'checklist', title: 'Checklist item not confirmed', problem: 'Cash: not confirmed yet.' }], warnings: [], completed: [], notes: [], causes: CAUSES };
    render(<ReviewGroups review={review} comparedWith="Month 9 2030" />);
    expect(screen.getByTestId('review-blockers').textContent).toMatch(/Blockers — must be fixed \(1\) · 2 findings/);
    expect(screen.getByTestId('review-needsReview').textContent).toMatch(/\(2\) · 3 findings.*look incomplete.*Cash: not confirmed yet/);
    expect(screen.queryByTestId('cause-accept-previous_month_incomplete')).toBeNull();
  });
});
