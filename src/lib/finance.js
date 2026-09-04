export const fmtCurrency = (n, opts = {}) => {
  const v = Number(n || 0);
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2,
  });
};

export const fmtPct = (n) => `${Number(n || 0).toFixed(2)}%`;

// --- BVA calculation core -------------------------------------------------
// The BVA dashboard uses these directly; the QuickBooks pages keep the
// budget-consumption helpers below unchanged.
export {
  computeYtd as bvaComputeYtd,
  computeMonth as bvaComputeMonth,
  computeLine as bvaComputeLine,
  aggregateYtd as bvaAggregateYtd,
  expectedPacePct,
  elapsedMonthsFromCutoff,
  paceStatus,
  isFavorable,
  isUnfavorable,
  round2,
  STATUS as PACE_STATUS,
  STATUS_TEXT as PACE_STATUS_TEXT,
  STATUS_STYLES as PACE_STATUS_STYLES,
  STATUS_TOOLTIP as PACE_VARIANCE_TOOLTIP,
  flagsForCategory,
  FLAG,
  FLAG_TEXT,
} from './bva.js';

// "$1,234.56 favorable" / "$1,234.56 unfavorable" / "On pace"
export function fmtVariance(amount, { cents = true } = {}) {
  const v = Number(amount || 0);
  const rounded = Math.round(v * 100) / 100;
  if (rounded === 0) return 'On pace';
  const label = rounded > 0 ? 'favorable' : 'unfavorable';
  return `${fmtCurrency(Math.abs(rounded), { cents })} ${label}`;
}

// "+2.91%" / "-0.65%" with an explicit sign
export const fmtSignedPct = (n) => {
  const v = Number(n || 0) * 100;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
};

export const GROUP_LABELS = {
  fixed: 'Fixed',
  variable: 'Variable',
  discretionary: 'Discretionary',
  income: 'Income',
  savings: 'Savings',
};

// Core budget math for a single line
export function computeLine(line, monthsElapsed = 12, useMonth = false) {
  const annual = Number(line.annual_budget || 0);
  const actual = useMonth ? Number(line.month_actual || 0) : Number(line.ytd_actual || 0);
  const months = useMonth ? 1 : monthsElapsed;
  const remaining = annual - actual;
  const pctUsed = annual ? (actual / annual) * 100 : 0;
  let expected;
  if (useMonth) expected = annual / 12;
  else if (line.pace_method === 'none') expected = annual;
  else if (line.pace_method === 'custom' && line.expected_ytd_override != null)
    expected = Number(line.expected_ytd_override);
  else expected = (annual * monthsElapsed) / 12;
  const variance = expected - actual; // positive = under pace
  const pctVariance = expected ? (variance / expected) * -100 : 0;
  return { annual, ytd: actual, remaining, pctUsed, expected, variance, pctVariance, status: statusOf(variance, expected) };
}

export function statusOf(variance, expected) {
  if (variance >= 0) {
    if (expected > 0 && variance / expected < 0.05) return 'near';
    return 'under';
  }
  return 'over';
}

export const STATUS_TEXT = { under: 'Under Budget', near: 'Near Budget', over: 'Over Budget' };

export const STATUS_STYLES = {
  under: { text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  near: { text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', bar: 'bg-amber-500', dot: 'bg-amber-500' },
  over: { text: 'text-rose-800', bg: 'bg-rose-50', border: 'border-rose-300', bar: 'bg-rose-500', dot: 'bg-rose-800' },
};

export function aggregateGroup(lines, monthsElapsed, useMonth = false) {
  const totals = lines.reduce(
    (acc, l) => {
      const c = computeLine(l, monthsElapsed, useMonth);
      acc.month += Number(l.month_actual || 0);
      acc.ytd += c.ytd;
      acc.annual += c.annual;
      acc.expected += c.expected;
      return acc;
    },
    { month: 0, ytd: 0, annual: 0, expected: 0 }
  );
  const remaining = totals.annual - totals.ytd;
  const pctUsed = totals.annual ? (totals.ytd / totals.annual) * 100 : 0;
  const variance = totals.expected - totals.ytd;
  return { ...totals, remaining, pctUsed, variance, status: statusOf(variance, totals.expected) };
}