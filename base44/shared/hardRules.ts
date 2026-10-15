// The validation model: the dashboard shows what the BVA workbook contains.
// Missing and unusual values are highlighted as warnings and never block
// finalize or publish, and no written reason is needed to publish them. A
// blank stays missing -- shown as missing, never as $0.00.
//
// Only a structural or integrity failure blocks: the app cannot tell what the
// workbook says, or which reporting period it is.
//
// Workbook findings (bvaValidation.js / the parser) that block, by family:
export const HARD_VALIDATION_FAMILIES = new Set([
  // which period the workbook is: no cutoff, or the workbook states two
  'cutoff_date_required',
  'cutoff_date_conflict',
  // the confirmed month is neither the cutoff month nor the month after it
  'reporting_month_mismatch',
  // the previous month already reports data through this cutoff (a duplicate)
  'cutoff_already_reported',
  // a required section (cash, income, expense summary, distributions) was not
  // found, or was found but its columns could not be read
  'section_missing',
  'section_unparsed',
  // two copies of a section with different figures: no way to tell which is right
  'duplicate_section_conflict',
  // the expense summary lacks Fixed / Variable / Discretionary
  'expense_group_missing',
]);

// Browser-only: the previous month could not be read while importing. The
// server runs its own checks (and fails closed on its own), so this one is
// not re-judged from the stored import.
export const CLIENT_ONLY_HARD = new Set(['previous_period_unavailable']);

const family = (code: string) => String(code || '').replace(/^(cross_period|open_reconciliation):/, '').split(':')[0];
export const isHardValidation = (code: string) => HARD_VALIDATION_FAMILIES.has(family(code));
