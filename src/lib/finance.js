// Missing vs zero: a missing value (null / undefined / blank / not a number)
// renders as "—" — never as a fabricated $0.00. A real 0 still shows $0.00.
export const MISSING_TEXT = '—';
export const isMissingNumber = (n) =>
  n === null || n === undefined || (typeof n === 'string' && n.trim() === '') || !Number.isFinite(Number(n));

export const fmtCurrency = (n, opts = {}) => {
  if (isMissingNumber(n)) return MISSING_TEXT;
  const v = Number(n);
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2,
  });
};

export const fmtPct = (n) => (isMissingNumber(n) ? MISSING_TEXT : `${Number(n).toFixed(2)}%`);
// Ratio -> percent, keeping a missing ratio missing (null * 100 would be 0).
export const pct100 = (v) => (isMissingNumber(v) ? null : Number(v) * 100);

// A numeric editor input: the number entered, or null for a blank / invalid
// entry. Callers write nothing for null — a blank never becomes a fabricated
// 0, and a stored value is never silently cleared. Enter 0 for a confirmed zero.
export const numericInput = (raw) => (isMissingNumber(raw) ? null : Number(raw));
export const BLANK_INPUT_HINT = 'Blank keeps the current value; enter 0 for a confirmed zero.';

// --- BVA calculation core -------------------------------------------------
// The BVA workbook is the only financial-data source for this app; there is
// no QuickBooks integration left to keep separate helpers for.
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
  SAVINGS_STATUS,
  SAVINGS_STATUS_TEXT,
  SAVINGS_STATUS_STYLES,
  savingsStatus as bvaSavingsStatus,
} from './bva.js';

// "$1,234.56 Under Budget" / "$1,234.56 Over Budget" / "On pace"
// (positive variance = spending below the expected pace; negative = above)
export function fmtVariance(amount, { cents = true } = {}) {
  if (isMissingNumber(amount)) return MISSING_TEXT;
  const v = Number(amount);
  const rounded = Math.round(v * 100) / 100;
  if (rounded === 0) return 'On pace';
  const label = rounded > 0 ? 'Under Budget' : 'Over Budget';
  return `${fmtCurrency(Math.abs(rounded), { cents })} ${label}`;
}

// "+2.91%" / "-0.65%" with an explicit sign
export const fmtSignedPct = (n) => {
  if (isMissingNumber(n)) return MISSING_TEXT;
  const v = Number(n) * 100;
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

// Legacy budget-consumption status vocabulary. The only callers that ever
// produced these keys (the QuickBooks Live page and the Excel/QuickBooks
// reconciliation table) have been removed along with QuickBooks itself;
// these maps stay only because StatusPill and BudgetBar still merge them
// with the current PACE_STATUS_* maps for a single shared lookup.
export const STATUS_TEXT = { under: 'Under Budget', near: 'Near Budget', over: 'Over Budget' };

export const STATUS_STYLES = {
  under: { text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  near: { text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', bar: 'bg-amber-500', dot: 'bg-amber-500' },
  over: { text: 'text-rose-800', bg: 'bg-rose-50', border: 'border-rose-300', bar: 'bg-rose-500', dot: 'bg-rose-800' },
};

// "October 3, 2026" from a date-only string (e.g. '2026-10-03'), formatted
// without any timezone shift — a plain new Date('2026-10-03') is UTC midnight
// and slides a day backward in timezones behind UTC.
const DATE_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export function formatDateOnly(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return iso == null ? '' : String(iso);
  return `${DATE_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}