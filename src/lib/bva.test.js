import { describe, it, expect } from 'vitest';
import {
  elapsedMonthsFromCutoff,
  expectedPacePct,
  computeYtd,
  computeMonth,
  computeLine,
  aggregateYtd,
  paceStatus,
  isFavorable,
  isUnfavorable,
  round2,
  STATUS,
  STATUS_TEXT,
  flagsForCategory,
  FLAG,
} from './bva.js';

const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

describe('expected pace (requirement 9)', () => {
  it('July cutoff => 7 elapsed months', () => {
    expect(elapsedMonthsFromCutoff('2026-07-31')).toBe(7);
  });
  it('July expected pace equals 58.33%', () => {
    expect(round2(expectedPacePct(7) * 100)).toBe(58.33);
    expect(expectedPacePct(7)).toBeCloseTo(7 / 12, 10);
  });
  it('clamps out-of-range month counts', () => {
    expect(expectedPacePct(0)).toBe(0);
    expect(expectedPacePct(15)).toBe(1);
  });
});

describe('single-line YTD math (requirements 7, 8, 10)', () => {
  // Synthetic figures. At 7 months elapsed, pace = 7/12. Chosen so the
  // variance rounds to a non-trivial signed value: expected = 240000 * 7/12
  // = 140000; actual 145000 -> variance -5000 unfavorable.
  const line = { ytd_actual: 145000, annual_budget: 240000 };
  const c = computeYtd({ actualYtd: line.ytd_actual, annualBudget: line.annual_budget }, 7);

  it('Remaining = Annual Budget - Actual YTD', () => {
    expect(round2(c.remaining)).toBe(round2(240000 - 145000));
    expect(round2(c.remaining)).toBe(95000);
  });
  it('Percent Used = Actual YTD / Annual Budget', () => {
    expect(c.percentUsed).toBeCloseTo(145000 / 240000, 10);
  });
  it('Expected YTD Budget = Annual Budget * pace', () => {
    expect(c.expectedYtdBudget).toBeCloseTo(240000 * (7 / 12), 8);
    expect(round2(c.expectedYtdBudget)).toBe(140000);
  });
  it('Variance to Expected Pace compares Actual YTD with Expected YTD Budget', () => {
    expect(c.varianceToPace).toBeCloseTo(c.expectedYtdBudget - 145000, 10);
    expect(round2(c.varianceToPace)).toBe(-5000);
  });
  it('Variance % = Expected Pace % - Percent Used', () => {
    expect(c.variancePct).toBeCloseTo(7 / 12 - 145000 / 240000, 12);
    // 58.3333% - 60.4167% = -2.08%
    expect(round2(c.variancePct * 100)).toBe(-2.08);
  });
});

describe('favorable / unfavorable sign convention (requirements 11, 12)', () => {
  it('positive variance is favorable', () => {
    // expected 140000, actual 100000 -> +40000
    const c = computeYtd({ actualYtd: 100000, annualBudget: 240000 }, 7);
    expect(c.varianceToPace).toBeGreaterThan(0);
    expect(isFavorable(c.varianceToPace)).toBe(true);
    expect(c.status).toBe(STATUS.UNDER);
    expect(STATUS_TEXT[c.status]).toBe('Below Expected Pace');
  });
  it('negative variance is unfavorable', () => {
    // expected 140000, actual 175000 -> -35000
    const c = computeYtd({ actualYtd: 175000, annualBudget: 240000 }, 7);
    expect(c.varianceToPace).toBeLessThan(0);
    expect(isUnfavorable(c.varianceToPace)).toBe(true);
    expect(c.status).toBe(STATUS.OVER);
    expect(STATUS_TEXT[c.status]).toBe('Above Expected Pace');
  });
  it('exact pace is On Pace', () => {
    const c = computeYtd({ actualYtd: 70000, annualBudget: 120000 }, 7); // 120000 * 7/12 = 70000
    expect(round2(c.varianceToPace)).toBe(0);
    expect(c.status).toBe(STATUS.ON);
  });
});

describe('Annual Budget Exceeded (requirement 13)', () => {
  it('appears only when Actual YTD exceeds the full Annual Budget', () => {
    expect(paceStatus({ actualYtd: 70000, annualBudget: 60000, varianceToPace: -25000 })).toBe(STATUS.EXCEEDED);
  });
  it('does not appear when merely above expected pace', () => {
    // 66.7% used at 58.33% pace, but still under the annual budget.
    const s = paceStatus({ actualYtd: 40000, annualBudget: 60000, varianceToPace: -5000 });
    expect(s).toBe(STATUS.OVER);
    expect(s).not.toBe(STATUS.EXCEEDED);
  });
  it('does not appear when exactly at the annual budget', () => {
    expect(paceStatus({ actualYtd: 60000, annualBudget: 60000, varianceToPace: -25000 })).toBe(STATUS.OVER);
  });
});

describe('This Month vs Year to Date modes (requirement 14)', () => {
  const line = { ytd_actual: 700000, month_actual: 0, annual_budget: 1200000, monthly_budget: 100000 };

  it('YTD mode uses ytd_actual and the full annual budget', () => {
    const c = computeLine(line, { elapsedMonths: 7, month: false });
    expect(c.mode).toBe('ytd');
    expect(c.actual).toBe(700000);
    expect(c.annual).toBe(1200000);
    expect(c.expectedYtdBudget).toBeCloseTo(1200000 * (7 / 12), 6);
  });

  it('This Month mode uses month_actual and a monthly budget, not YTD', () => {
    const c = computeLine(line, { elapsedMonths: 7, month: true });
    expect(c.mode).toBe('month');
    expect(c.actual).toBe(0); // month_actual, NOT ytd_actual
    expect(c.monthlyBudget).toBe(100000);
    expect(c).not.toHaveProperty('expectedYtdBudget');
    expect(c.hasActivity).toBe(false); // caller shows "No current-month activity imported."
  });

  it('This Month falls back to annual/12 when no explicit monthly budget', () => {
    const c = computeMonth({ monthActual: 5000, annualBudget: 120000 });
    expect(c.monthlyBudget).toBe(10000);
    expect(c.hasActivity).toBe(true);
  });

  it('a blank Current Month stays zero and is never replaced by YTD', () => {
    const c = computeMonth({ monthActual: 0, annualBudget: 120000 });
    expect(c.actual).toBe(0);
    expect(c.hasActivity).toBe(false);
  });
});

describe('group aggregation', () => {
  it('sums lines then runs the YTD math on the totals', () => {
    // synthetic three-group set; totals: actual 300000, annual 492000
    const lines = [
      { ytd_actual: 90000, annual_budget: 144000 },
      { ytd_actual: 70000, annual_budget: 168000 },
      { ytd_actual: 140000, annual_budget: 180000 },
    ];
    const agg = aggregateYtd(lines, 7);
    expect(round2(agg.actual)).toBe(300000);
    expect(round2(agg.annual)).toBe(492000);
    // expected = 492000 * 7/12 = 287000; variance = 287000 - 300000 = -13000
    expect(round2(agg.varianceToPace)).toBe(-13000);
    // 58.3333% - (300000/492000 = 60.9756%) = -2.64%
    expect(round2(agg.variancePct * 100)).toBe(-2.64);
    expect(agg.status).toBe(STATUS.OVER);
  });
});

describe('category flagging for "Needs Attention"', () => {
  it('flags an over-pace category with the pace reason', () => {
    const { flagged, reasons } = flagsForCategory({ actualYtd: 40000, annualBudget: 60000 }, 7);
    expect(flagged).toBe(true);
    expect(reasons).toContain(FLAG.OVER_PACE);
    expect(reasons).not.toContain(FLAG.EXCEEDED);
  });
  it('flags an exceeded category with the exceeded reason only', () => {
    const { reasons } = flagsForCategory({ actualYtd: 70000, annualBudget: 60000 }, 7);
    expect(reasons).toContain(FLAG.EXCEEDED);
    expect(reasons).not.toContain(FLAG.OVER_PACE);
  });
  it('flags a category carrying an unresolved validation warning', () => {
    const { flagged, reasons } = flagsForCategory({ actualYtd: 1000, annualBudget: 60000 }, 7, true);
    expect(flagged).toBe(true);
    expect(reasons).toContain(FLAG.UNRESOLVED_WARNING);
  });
  it('does not flag a healthy under-pace category', () => {
    const { flagged } = flagsForCategory({ actualYtd: 5000, annualBudget: 60000 }, 7);
    expect(flagged).toBe(false);
  });
});

// keep helper referenced
void near;
