// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Phase 8 reporting polish: wording, layout and the Validation Warnings tab.
// Presentation only -- the figures come from buildBvaDashboard unchanged.
// Fictional figures throughout.
const h = vi.hoisted(() => ({ check: null }));
vi.mock('@/api/base44Client', () => ({ base44: { entities: { Transaction: { filter: async () => [] } } } }));
vi.mock('@/lib/periodTransition', () => ({ periodTransition: async () => h.check }));

import HeroMetrics from './client/HeroMetrics';
import GroupCards from './client/GroupCards';
import ClientSidePanel from './client/ClientSidePanel';
import ValidationWarnings from './admin/ValidationWarnings';
import { ReviewGroups } from './admin/PublicationReview';
import { buildBvaDashboard } from '@/lib/bvaDashboard';
import { heroTakeaway, LABEL } from '@/lib/reportText';
import { fmtPacePoints, fmtVariance } from '@/lib/finance';

afterEach(cleanup);

const PERIOD = { id: 'p', label: 'July 9102', month: 7, year: 9102, months_elapsed: 6, reporting_cutoff_date: '9102-06-30', status: 'final', published: true, bva_import_status: 'final', total_cash: 5250, ytd_income: 4806, ytd_expenses: 138 };
const line = (id, group, ytd, annual, month) => ({ id, category: id, budget_group: group, bva_detail: false, group_confirmed: true, ytd_actual: ytd, annual_budget: annual, month_actual: month });
const LINES = [
  line('FIXED', 'fixed', 60, 120, 10),
  line('VARIABLE', 'variable', 30, 60, 5),
  line('Rent', 'discretionary', 20, 48, 4),
  line('Travel', 'discretionary', 28, 48, 4),
  { id: 'inc', category: 'Salary', budget_group: 'income', bva_detail: false, ytd_actual: 4806, annual_budget: 9612, month_actual: 801 },
];
const vmOf = (period = PERIOD, extra = {}) => buildBvaDashboard({ period, budgetLines: LINES, cashAccounts: [{ id: 'c1', account_name: 'ZZ Test Checking', balance: 5250, account_type: 'bank' }], distributions: [], transfers: [], savingsSpends: [], ...extra });

describe('one month convention', () => {
  it('the report is named by its report month, the data by its cutoff', () => {
    expect(vmOf().labels.reportLine).toBe('July 9102 report · data through June 30, 9102');
    expect(vmOf().labels.reportHeading).toBe('July 9102 report');
  });
});

describe('pace wording', () => {
  it('the pace gap is in points below / above pace', () => {
    expect(fmtPacePoints(0.0769)).toBe('7.69 pts below pace');
    expect(fmtPacePoints(-0.0065)).toBe('0.65 pts above pace');
    expect(fmtPacePoints(0)).toBe('On pace');
    expect(fmtPacePoints(null)).toBe('—');
  });
  it('no Under/Over Budget anywhere in the client hero or group cards', () => {
    const vm = vmOf();
    const { container } = render(<><HeroMetrics vm={vm} /><GroupCards groups={vm.groups} pacePct={vm.pacePct} /></>);
    expect(container.textContent).not.toMatch(/Under Budget|Over Budget|Under Expected Pace|Over Expected Pace/);
    expect(fmtVariance(-5)).toMatch(/above expected pace/);
  });
});

describe('hero', () => {
  it('one name per figure, and a takeaway from existing figures', () => {
    const vm = vmOf();
    render(<HeroMetrics vm={vm} />);
    for (const l of [LABEL.totalCash, LABEL.incomeYtd, LABEL.expensesYtd, LABEL.distributionsYtd]) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.queryByText(/Net Cash Position|Net Distributions/)).toBeNull();
    expect(screen.queryByText(/Expenses through/)).toBeNull();
    expect(screen.getByTestId('hero-takeaway').textContent).toBe(heroTakeaway(vm));
    expect(heroTakeaway(vm)).toMatch(/^Through June 30, 9102, spending is (on expected pace|\$[\d,]+ (below|above) expected pace) and income is at 50\.00% of its annual budget \(50\.00% expected by now\)\.$/);
  });
  it('the takeaway leaves out a part whose figures are missing, and is absent with none', () => {
    const vm = vmOf();
    expect(heroTakeaway({ ...vm, snapshot: { ...vm.snapshot, incomeBudgetUsedPct: null } })).not.toMatch(/income/);
    expect(heroTakeaway({ ...vm, snapshot: { ...vm.snapshot, incomeBudgetUsedPct: null, overallVarianceAmount: null } })).toBeNull();
  });
});

describe('group cards', () => {
  it('a one-line group shows no repeated row; View transactions opens that line', () => {
    const vm = vmOf();
    const onSelect = vi.fn();
    render(<GroupCards groups={vm.groups} pacePct={vm.pacePct} onSelect={onSelect} />);
    const fixed = screen.getByTestId('group-card-fixed');
    expect(fixed.textContent).not.toMatch(/FIXED/); // the summary row is gone
    expect(fixed.textContent).toMatch(/This month \$10\.00/);
    fireEvent.click(screen.getByTestId('view-transactions-fixed'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'FIXED', category: 'FIXED' }));
  });
  it('a group of several lines still lists them (each opens its transactions)', () => {
    const vm = vmOf();
    const onSelect = vi.fn();
    render(<GroupCards groups={vm.groups} pacePct={vm.pacePct} onSelect={onSelect} />);
    expect(screen.queryByTestId('view-transactions-discretionary')).toBeNull();
    fireEvent.click(screen.getByText('Travel'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'Travel' }));
  });
  it('a line without drill-down gets no button', () => {
    const vm = buildBvaDashboard({ period: PERIOD, budgetLines: [{ ...LINES[0], drilldown_enabled: false }], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [] });
    render(<GroupCards groups={vm.groups} pacePct={vm.pacePct} onSelect={() => {}} />);
    expect(screen.queryByTestId('view-transactions-fixed')).toBeNull();
  });
});

describe('side panel', () => {
  it('savings figures: the approved names, and a missing value is "—" with a caption', () => {
    render(<ClientSidePanel vm={vmOf()} />);
    expect(screen.getByText(LABEL.savingsIn)).toBeTruthy();
    expect(screen.getByText('Savings In (incl. distributions)')).toBeTruthy();
    expect(screen.queryByText('Distributions In')).toBeNull();
    expect(screen.queryByText('Not provided')).toBeNull();
    expect(screen.getAllByText('Not provided for this report').length).toBeGreaterThan(0);
    expect(screen.getByTestId('cash-total').textContent).toMatch(/Total Cash\$5,250\.00/);
  });
});

describe('Validation Warnings tab', () => {
  const warningCause = { key: 'distribution_quarter_blank', bucket: 'warnings', title: 'A distribution quarter is blank', action: 'Check the quarter.', members: [{ code: 'distribution_quarter_blank', problem: 'ZZ Alpha Q2 is blank', kind: 'warning' }] };
  const blockerCause = { key: 'missing_actual', bucket: 'blockers', title: 'A line has no Actual YTD', action: 'Fix the workbook.', members: [{ code: 'missing_actual', problem: 'Line X', kind: 'blocker' }] };
  it('an unpublished report: warnings by cause, never-block statement, blockers only pointed to', async () => {
    h.check = { ok: true, review: { causes: [warningCause, blockerCause], blockers: [], warnings: [], needsReview: [], completed: [], notes: [] }, cross_period: { previous: { label: 'June 9102' } } };
    const onOpenReview = vi.fn();
    render(<ValidationWarnings period={{ ...PERIOD, published: false, status: 'draft' }} onOpenReview={onOpenReview} />);
    await waitFor(() => expect(screen.getByTestId('cause-distribution_quarter_blank')).toBeTruthy());
    expect(screen.getByTestId('warnings-never-block').textContent).toMatch(/never block finalizing or publishing, and need no acknowledgement or written reason/);
    expect(screen.queryByTestId('cause-missing_actual')).toBeNull(); // the blocker is not listed here
    expect(screen.getByTestId('blockers-elsewhere').textContent).toMatch(/1 problem that must be fixed/);
    fireEvent.click(screen.getByText(/Open Review & Publish/));
    expect(onOpenReview).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull(); // no reason to write
  });
  it('a published report: the warnings recorded at import, grouped by cause', () => {
    render(<ValidationWarnings period={{ ...PERIOD, bva_validation_warnings: [{ code: 'distribution_quarter_blank', message: 'ZZ Alpha Q2 is blank' }] }} />);
    expect(screen.getByText(/recorded when its workbook was imported/)).toBeTruthy();
    expect(screen.getByText('ZZ Alpha Q2 is blank')).toBeTruthy();
  });
  it('Review & Publish counts the warnings and links to the tab instead of repeating them', () => {
    const onShowWarnings = vi.fn();
    render(<ReviewGroups review={{ causes: [warningCause, blockerCause], blockers: [], warnings: [], needsReview: [], completed: [], notes: [] }} onShowWarnings={onShowWarnings} />);
    expect(screen.getByTestId('review-blockers').textContent).toMatch(/A line has no Actual YTD/);
    expect(screen.queryByText('A distribution quarter is blank')).toBeNull();
    expect(screen.getByTestId('review-warnings-pointer').textContent).toMatch(/1 warning — it never blocks finalizing or publishing/);
    fireEvent.click(screen.getByText('See Validation Warnings'));
    expect(onShowWarnings).toHaveBeenCalled();
  });
});
