// Admin → Monthly Totals: build the ReportingPeriod write for the entered
// totals without ever sending null (Base44 rejects it) or turning a blank into
// 0 (which would read as a confirmed $0.00). A blank input leaves the stored
// number untouched and lists the field in source_missing_fields, so every
// reader treats it as missing; entering a value takes it off the list.
import { nextMissingList, MISSING_MARKER } from '../../base44/shared/sourceMissing.ts';

export const TOTALS_FIELDS = [
  ['total_cash', 'Total Cash'],
  ['ytd_income', 'YTD Income'],
  ['ytd_expenses', 'YTD Expenses'],
  ['month_income', 'Current Month Income'],
  ['month_expenses', 'Current Month Expenses'],
  ['distributions_ytd', 'Distributions YTD'],
  ['savings_in_ytd', 'Savings / Distributions In'],
  ['savings_spend_ytd', 'Expenses Paid From Savings'],
  ['months_elapsed', 'Months Elapsed (budget pace)'],
];

const isBlank = (v) => v === '' || v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// Returns { data } to write, or { error } when an input is not a number.
export function totalsWrite(period, form, today = new Date().toISOString().slice(0, 10)) {
  const fields = TOTALS_FIELDS.map(([k]) => k);
  const entered = {};
  for (const k of fields) {
    const raw = form[k];
    if (isBlank(raw)) {
      entered[k] = null;
      continue;
    }
    const x = Number(raw);
    if (!Number.isFinite(x)) return { error: `${TOTALS_FIELDS.find(([f]) => f === k)[1]} is not a number.` };
    entered[k] = x;
  }
  const data = Object.fromEntries(Object.entries(entered).filter(([, v]) => v !== null));
  return { data: { ...data, [MISSING_MARKER]: nextMissingList(period, fields, entered), last_updated: today } };
}
