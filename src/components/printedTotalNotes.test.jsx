// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Client notes when the workbook does not add up: the printed total is shown
// and the note says what the rows add up to. Fictional data.
import CashCard from './CashCard';
import { incomeNotes } from '../lib/printedTotalNotes';

afterEach(cleanup);

describe('Total Cash', () => {
  it('printed total differs from the accounts: the printed total is shown, and the note says so', () => {
    render(<CashCard total={41000} reportedTotal={41000} reconciles={false} accounts={[{ id: 'a', name: 'Test Checking', balance: 40000 }]} />);
    expect(screen.getByText('$41,000.00')).toBeTruthy();
    expect(screen.getByTestId('cash-does-not-add-up').textContent).toMatch(/accounts total \$40,000\.00; the workbook's Total Cash of \$41,000\.00 is shown/);
  });
  it('a blank balance with a printed total: no "partial" claim', () => {
    render(<CashCard total={39000} reportedTotal={39000} accounts={[{ id: 'a', name: 'Test Checking', balance: null }, { id: 'b', name: 'Test Savings', balance: 100 }]} />);
    expect(screen.getByTestId('cash-partial').textContent).toMatch(/no balance in the workbook.*Total Cash is shown/);
  });
  it('agreeing figures: no note', () => {
    render(<CashCard total={100} reportedTotal={100} accounts={[{ id: 'a', name: 'Test Checking', balance: 100 }]} />);
    expect(screen.queryByTestId('cash-does-not-add-up')).toBeNull();
  });
});

describe('income', () => {
  it('printed totals that differ from the lines are named', () => {
    const notes = incomeNotes({ ytdIncome: 999, incomeCalculatedYtd: 1000, annualBudgetedIncome: 1200, incomeCalculatedBudget: 1212, incomeWorkbookBudget: 1200 });
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/lines' budgets total \$1,212\.00; the workbook's annual income budget of \$1,200\.00 is shown/);
  });
  it('a period stored before the rule (calculated budget shown) keeps its old wording', () => {
    expect(incomeNotes({ ytdIncome: 1, incomeCalculatedYtd: 1, annualBudgetedIncome: 1212, incomeCalculatedBudget: 1212, incomeWorkbookBudget: 1200 })[0]).toMatch(/independently calculated total \$1,212\.00 is used/);
  });
});
