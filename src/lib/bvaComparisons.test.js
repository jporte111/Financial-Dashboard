import { describe, it, expect } from 'vitest';
import { computeYtd, savingsStatus, round2, STATUS, SAVINGS_STATUS } from './bva.js';

// CLOTHING — September 2026 published figures (validated BVA import):
// annual budget $654,321, actual YTD (through Aug 31) $654,321.09, 8 months elapsed.
const ACTUAL = 654321.09;
const ANNUAL = 654321;

describe('Clothing: the two comparisons stay distinct', () => {
  const c = computeYtd({ actualYtd: ACTUAL, annualBudget: ANNUAL }, 8);

  it('flags the full annual budget as exceeded', () => {
    expect(c.status).toBe(STATUS.EXCEEDED);
  });

  it('computes the over-annual-budget figure', () => {
    const overAnnual = Math.round((c.actual - c.annual) * 100) / 100;
    expect(overAnnual).toBe(54321.09);
  });

  it('computes the over-expected-YTD-pace figure', () => {
    const overPace = Math.round((c.actual - c.expectedYtdBudget) * 100) / 100;
    expect(overPace).toBe(54321.09);
    expect(round2(c.varianceToPace)).toBe(-54321.09); // signed: unfavorable (display rounds)
  });

  it('keeps 8/12 as the expected pace', () => {
    expect(c.pacePct).toBeCloseTo(2 / 3);
  });
});

// MONTHLY SAVINGS — savings target, tone inverted.
describe('MONTHLY SAVINGS target figures', () => {
  const c = savingsStatus({ actualYtd: 654321, annualBudget: 300000 }, 8);
  it('is below target by $63,500 at 8 of 12 months', () => {
    expect(c.expectedYtdBudget).toBe(200000);
    expect(c.varianceToPace).toBe(63500);
    expect(c.status).toBe(SAVINGS_STATUS.BELOW);
  });
});