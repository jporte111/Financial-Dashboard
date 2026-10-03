import { describe, it, expect } from 'vitest';
import { fmtVariance, fmtSignedPct, fmtCurrency, fmtPct } from './finance.js';

describe('fmtVariance wording — "Over Budget" / "Under Budget" / "On pace"', () => {
  it('a negative variance (spending above expected pace) reads "Over Budget"', () => {
    expect(fmtVariance(-54321.09)).toBe('$54,321.09 Over Budget');
    expect(fmtVariance(-4321.09)).toBe('$4,321.09 Over Budget');
  });

  it('a positive variance (spending below expected pace) reads "Under Budget"', () => {
    expect(fmtVariance(54321.09)).toBe('$54,321.09 Under Budget');
  });

  it('a zero variance reads "On pace"', () => {
    expect(fmtVariance(0)).toBe('On pace');
    expect(fmtVariance(0.004)).toBe('On pace'); // rounds to zero at cents
  });

  it('never emits the words "favorable" or "unfavorable"', () => {
    for (const v of [-100000, -1, -0.01, 0, 0.01, 1, 100000]) {
      expect(fmtVariance(v)).not.toMatch(/favorable/i);
    }
  });

  it('respects the cents option', () => {
    expect(fmtVariance(-54321.09, { cents: false })).toBe('$54,321 Over Budget');
  });
});

describe('fmtSignedPct', () => {
  it('prefixes an explicit sign and formats to two decimals', () => {
    expect(fmtSignedPct(-0.0291)).toBe('-2.91%');
    expect(fmtSignedPct(0.0443)).toBe('+4.43%');
    expect(fmtSignedPct(0)).toBe('0.00%');
  });
});

// sanity that the shared money/percent formatters are unchanged
describe('fmtCurrency / fmtPct still format as before', () => {
  it('fmtCurrency', () => {
    expect(fmtCurrency(7654321.09)).toBe('$7,654,321.09');
    expect(fmtCurrency(500, { cents: false })).toBe('$500');
  });
  it('fmtPct', () => {
    expect(fmtPct(58.33)).toBe('58.33%');
  });
});
