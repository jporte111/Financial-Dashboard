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

export const GROUP_LABELS = {
  fixed: 'Fixed',
  variable: 'Variable',
  discretionary: 'Discretionary',
  income: 'Income',
  savings: 'Savings',
};

// Core budget math for a single line
export function computeLine(line, monthsElapsed = 12) {
  const annual = Number(line.annual_budget || 0);
  const ytd = Number(line.ytd_actual || 0);
  const remaining = annual - ytd;
  const pctUsed = annual ? (ytd / annual) * 100 : 0;
  let expected;
  if (line.pace_method === 'none') expected = annual;
  else if (line.pace_method === 'custom' && line.expected_ytd_override != null)
    expected = Number(line.expected_ytd_override);
  else expected = (annual * monthsElapsed) / 12;
  const variance = expected - ytd; // positive = under pace
  const pctVariance = expected ? (variance / expected) * -100 : 0;
  return { annual, ytd, remaining, pctUsed, expected, variance, pctVariance, status: statusOf(variance, expected) };
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
  over: { text: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200', bar: 'bg-rose-500', dot: 'bg-rose-500' },
};

export function aggregateGroup(lines, monthsElapsed) {
  const totals = lines.reduce(
    (acc, l) => {
      const c = computeLine(l, monthsElapsed);
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