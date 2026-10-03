import { describe, it, expect } from 'vitest';
import { computeYtd, savingsStatus, round2, STATUS, SAVINGS_STATUS } from './bva.js';

// CLOTHING-style line (fictional figures): actual YTD above the FULL annual
// budget, 8 of 12 months elapsed — the annual-budget and YTD-pace comparisons
// must stay distinct.
const ACTUAL = 1350;
const ANNUAL = 1200;

describe('Clothing: the two comparisons stay distinct', () => {
  const c = computeYtd({ actualYtd: ACTUAL, annualBudget: ANNUAL }, 8);

  it('flags the full annual budget as exceeded', () => {
    expect(c.status).toBe(STATUS.EXCEEDED);
  });

  it('computes the over-annual-budget figure', () => {
    const overAnnual = Math.round((c.actual - c.annual) * 100) / 100;
    expect(overAnnual).toBe(150);
  });

  it('computes the over-expected-YTD-pace figure', () => {
    const overPace = Math.round((c.actual - c.expectedYtdBudget) * 100) / 100;
    expect(overPace).toBe(550);
    expect(round2(c.varianceToPace)).toBe(-550); // signed: unfavorable (display rounds)
  });

  it('keeps 8/12 as the expected pace', () => {
    expect(c.pacePct).toBeCloseTo(2 / 3);
  });
});

// MONTHLY SAVINGS-style line (fictional): a savings target, tone inverted.
describe('MONTHLY SAVINGS target figures', () => {
  const c = savingsStatus({ actualYtd: 5700, annualBudget: 11400 }, 8);
  it('is below target by $1,900 at 8 of 12 months', () => {
    expect(c.expectedYtdBudget).toBe(7600);
    expect(c.varianceToPace).toBe(1900);
    expect(c.status).toBe(SAVINGS_STATUS.BELOW);
  });
});