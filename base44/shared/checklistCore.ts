// The pre-publication checklist (Phase 6c). Pure functions: the
// periodTransition backend records confirmations and enforces them; the admin
// screens show the result. Nothing here writes.
//
// The seven checklist items are unchanged. What is new:
//   - a confirmation records WHO confirmed, WHEN, a fingerprint of the data the
//     item covers, and the linked warnings showing at that moment;
//   - a confirmation goes STALE on its own when that data changes (from any
//     screen: re-import, inline decision, Monthly Data) or a new linked warning
//     appears -- only the items whose data changed, never the others;
//   - fingerprints use values only (no record ids or timestamps), so an
//     identical re-import resets nothing; a missing value is not $0.00;
//   - an item cannot be confirmed while a linked blocker is open;
//   - everything is sorted into four plain-language groups: blockers, needs
//     review, warnings, completed.

import { effectiveRecord } from './sourceMissing.ts';

// ---- the items and what each covers ----------------------------------------
export const PARTS: Record<string, string> = {
  line_names: 'budget line names and watch-list rows',
  line_groups: 'line groups (Fixed / Variable / Discretionary / Income / Savings)',
  line_ytd: 'line year-to-date figures',
  income_totals: 'income totals and the income budget',
  income_lines: 'income lines',
  cash_accounts: 'cash accounts',
  total_cash: 'Total Cash',
  distributions: 'distributions by entity and quarter',
  distribution_totals: 'Distributions YTD and Savings / Distributions In',
  expense_totals: 'expense totals and the expense budget',
  expense_lines: 'expense group lines',
  transfers: 'recurring transfers',
  savings_spend: 'expenses paid from savings',
  cutoff: 'reporting cutoff and pace',
  accepted_reasons: 'accepted reasons',
};

// A blocker or warning code without its routing prefix: "open_reconciliation:x" -> "x".
export const bareCode = (code: string) => String(code || '').replace(/^(cross_period|open_reconciliation):/, '');
const family = (code: string) => bareCode(code).split(':')[0];
const param = (code: string) => bareCode(code).split(':').slice(1).join(':');
const fam = (...names: string[]) => (code: string) => names.includes(family(code));

export const CHECKLIST_ITEMS = [
  {
    key: 'categories_reviewed', label: 'Categories reviewed', parts: ['line_names'],
    linked: fam('detail_unassigned', 'lines_added', 'lines_removed', 'detail_row_missing', 'detail_code_reused', 'detail_rows_missing_vs_prior',
      'detail_section_absent', 'detail_section_empty', 'detail_section_expected', 'detail_orphan_row', 'detail_row_blank', 'detail_code_missing',
      'required_line_value_missing', 'import_incomplete', 'expense_group_missing'),
  },
  { key: 'classes_reviewed', label: 'Classes reviewed', parts: ['line_groups'], linked: fam('detail_group_changed', 'detail_unassigned') },
  {
    key: 'refunds_reviewed', label: 'Refunds reviewed', parts: ['line_ytd'],
    linked: fam('group_ytd_decreased', 'income_line_decreased', 'detail_ytd_decreased', 'month_vs_ytd', 'ytd_income_decreased', 'ytd_expenses_decreased'),
  },
  {
    key: 'income_reviewed', label: 'Income reviewed', parts: ['income_totals', 'income_lines'],
    linked: (c: string) => fam('income_actual_mismatch', 'income_budget_workbook_mismatch', 'ytd_income_decreased', 'income_line_decreased', 'income_total_row_missing')(c)
      || (family(c) === 'month_vs_ytd' && param(c) === 'income')
      || (family(c) === 'section_missing' && param(c) === 'income')
      || (family(c) === 'required_value_missing' && ['ytd_income', 'annual_budgeted_income'].includes(param(c)))
      || (family(c) === 'annual_budget_changed' && param(c) === 'annual_budgeted_income'),
  },
  {
    key: 'cash_confirmed', label: 'Cash balances confirmed', parts: ['cash_accounts', 'total_cash'],
    linked: (c: string) => fam('cash_total_mismatch', 'cash_accounts_changed', 'cash_total_row_missing')(c)
      || (family(c) === 'section_missing' && param(c) === 'cash')
      || (family(c) === 'required_value_missing' && param(c) === 'total_cash'),
  },
  {
    key: 'distributions_confirmed', label: 'Distribution totals confirmed', parts: ['distributions', 'distribution_totals'],
    linked: (c: string) => fam('distribution_quarter_blank', 'distribution_workbook_total_corrected', 'distributions_ytd_decreased', 'closed_quarter_changed',
      'closed_quarter_missing', 'distribution_entity_removed', 'savings_in_ytd_missing', 'savings_in_ytd_decreased')(c)
      || (family(c) === 'section_missing' && param(c) === 'distributions')
      || (family(c) === 'required_value_missing' && param(c) === 'distributions_ytd'),
  },
  // The whole report: every part, every finding.
  { key: 'budget_report_reviewed', label: 'Budget report reviewed', parts: Object.keys(PARTS), linked: (_c: string) => true },
];
export const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((i) => i.key);

// ---- fingerprints -------------------------------------------------------------
const cents = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const text = (v: any) => (v === null || v === undefined ? null : String(v).trim().replace(/\s+/g, ' '));
const lineKey = (l: any) => `${l.bva_detail ? 'D' : 'S'}|${text(l.qb_code) || ''}|${text(l.category) || ''}`;
const sortRows = (rows: any[]) => rows.map((r) => JSON.stringify(r)).sort();

// The canonical value of each part: values only, keyed by natural names.
export function partValues(rec: { period: any; lines?: any[]; cash?: any[]; distributions?: any[]; transfers?: any[]; savings?: any[] }) {
  const p = effectiveRecord(rec.period) || {};
  const lines = rec.lines || [];
  const byId = new Map(lines.map((l) => [l.id, lineKey(l)]));
  const income = lines.filter((l) => !l.bva_detail && String(l.budget_group).toLowerCase() === 'income');
  const expense = lines.filter((l) => !l.bva_detail && ['fixed', 'variable', 'discretionary'].includes(String(l.budget_group).toLowerCase()));
  const lineFigures = (l: any) => [lineKey(l), cents(l.ytd_actual), cents(l.annual_budget), cents(l.month_actual)];
  const overrides = p.bva_overrides && typeof p.bva_overrides === 'object' ? p.bva_overrides : {};
  return {
    line_names: sortRows(lines.map(lineKey)),
    line_groups: sortRows(lines.map((l) => [lineKey(l), text(l.budget_group), !!l.group_confirmed])),
    line_ytd: sortRows(lines.map((l) => [lineKey(l), cents(l.ytd_actual)])),
    income_totals: [cents(p.ytd_income), cents(p.month_income), cents(p.annual_budgeted_income), cents(p.annual_budgeted_income_workbook)],
    income_lines: sortRows(income.map(lineFigures)),
    cash_accounts: sortRows((rec.cash || []).map((c) => [text(c.name), cents(c.balance), text(c.account_type)])),
    total_cash: [cents(p.total_cash)],
    distributions: sortRows((rec.distributions || []).map((d) => [text(d.entity_name), cents(d.q1), cents(d.q2), cents(d.q3), cents(d.q4)])),
    distribution_totals: [cents(p.distributions_ytd), cents(p.savings_in_ytd)],
    expense_totals: [cents(p.ytd_expenses), cents(p.month_expenses), cents(p.annual_budgeted_expenses)],
    expense_lines: sortRows(expense.map(lineFigures)),
    transfers: sortRows((rec.transfers || []).map((t) => [text(t.source), text(t.purpose), cents(t.amount)])),
    savings_spend: [cents(p.savings_spend_ytd), ...sortRows((rec.savings || []).map((s) => [text(s.category), cents(s.ytd_amount)]))],
    cutoff: [text(p.reporting_cutoff_date), p.months_elapsed === null || p.months_elapsed === undefined || p.months_elapsed === '' || !Number.isFinite(Number(p.months_elapsed)) ? null : Number(p.months_elapsed)],
    // Who accepted and when do not change the substance; a re-finalize with the
    // same reasons is not a change. Line ids are replaced by the line's name.
    accepted_reasons: Object.keys(overrides).sort().map((code) => [code.replace(/^(detail_unassigned:)(.+)$/, (_m, a, id) => a + (byId.get(id) || id)), text(overrides[code]?.reason)]),
  };
}

// A short, deterministic hash (cyrb53) -- the same in Deno and in the browser.
export function hashValue(value: any) {
  const str = JSON.stringify(value);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
export function partHashes(rec: any) {
  return Object.fromEntries(Object.entries(partValues(rec)).map(([k, v]) => [k, hashValue(v)]));
}

// ---- statuses ---------------------------------------------------------------
// Codes that describe the period's state rather than its data; never "linked".
const STATE_CODES = new Set(['period_not_found', 'state_uninitialized', 'published_read_only', 'already_final', 'already_published', 'not_final', 'no_validated_import', 'checklist_incomplete']);
export const isDataBlocker = (b: any) => !STATE_CODES.has(family(b.code));
// When the checks themselves could not run, nothing can be confirmed: these
// block EVERY item (fail closed), whatever the item covers.
const UNIVERSAL = new Set(['checks_unavailable', 'checklist_unavailable']);

// The warnings an item can go stale on: codes only (the wording may change).
export function warningCodes(period: any, crossFindings: any[] | null) {
  const v = (Array.isArray(period?.bva_validation_warnings) ? period.bva_validation_warnings : []).filter((w: any) => w && !w.blocksFinalize && !w.overridden).map((w: any) => String(w.code));
  const x = (crossFindings || []).filter((f: any) => f.severity === 'warn').map((f: any) => String(f.code));
  return [...new Set([...v, ...x])].sort();
}

// Each item's state:
//   blocked      a linked blocker is open: fix it (or accept it with a reason) first
//   unconfirmed  nobody has confirmed it yet
//   stale        confirmed, but its data changed or a new linked warning appeared since
//   confirmed    confirmed, and nothing it covers has changed
export function checklistStatus({ confirmations, hashes, openBlockers, warnings }: { confirmations: any; hashes: Record<string, string>; openBlockers: any[]; warnings: string[] }) {
  const conf = confirmations && typeof confirmations === 'object' ? confirmations : {};
  return CHECKLIST_ITEMS.map((item) => {
    const c = conf[item.key] && typeof conf[item.key] === 'object' ? conf[item.key] : null;
    const blockedBy = (openBlockers || []).filter((b) => isDataBlocker(b) && (UNIVERSAL.has(family(b.code)) || item.linked(b.code))).map((b) => b.code);
    const linkedWarnings = (warnings || []).filter((w) => item.linked(w));
    const base = { key: item.key, label: item.label, by: c?.by || null, at: c?.at || null };
    if (blockedBy.length) return { ...base, state: 'blocked', blockedBy, changedParts: [], newWarnings: [] };
    if (!c || !c.parts) return { ...base, state: 'unconfirmed', blockedBy: [], changedParts: [], newWarnings: [] };
    const changedParts = item.parts.filter((p) => c.parts[p] !== hashes[p]);
    const seen = new Set(Array.isArray(c.warnings) ? c.warnings : []);
    const newWarnings = linkedWarnings.filter((w) => !seen.has(w));
    const state = changedParts.length || newWarnings.length ? 'stale' : 'confirmed';
    return { ...base, state, blockedBy: [], changedParts, newWarnings };
  });
}

// The confirmation record written when an item is confirmed.
export function confirmationRecord(itemKey: string, hashes: Record<string, string>, warnings: string[], by: string, at: string) {
  const item = CHECKLIST_ITEMS.find((i) => i.key === itemKey);
  if (!item) throw new Error(`unknown checklist item ${itemKey}`);
  return { by, at, parts: Object.fromEntries(item.parts.map((p) => [p, hashes[p]])), warnings: warnings.filter((w) => item.linked(w)) };
}

// Plain-language reason an item is not done (used by the publish gate).
export function itemMessage(s: any) {
  if (s.state === 'blocked') return `${s.label}: cannot be confirmed until ${s.blockedBy.length === 1 ? 'this issue is' : `these ${s.blockedBy.length} issues are`} resolved: ${s.blockedBy.map((c: string) => explain(c).title).join('; ')}.`;
  if (s.state === 'unconfirmed') return `${s.label}: not confirmed yet.`;
  if (s.state === 'stale') {
    const why = [
      ...(s.changedParts.length ? [`${s.changedParts.map((p: string) => PARTS[p]).join(', ')} changed`] : []),
      ...(s.newWarnings.length ? [`new warning${s.newWarnings.length > 1 ? 's' : ''}: ${s.newWarnings.map((c: string) => explain(c).title).join('; ')}`] : []),
    ].join('; ');
    return `${s.label}: needs confirming again -- ${why} since ${s.by || 'it was'} confirmed${s.at ? ` on ${String(s.at).slice(0, 10)}` : ''}.`;
  }
  return `${s.label}: confirmed${s.by ? ` by ${s.by}` : ''}${s.at ? ` on ${String(s.at).slice(0, 10)}` : ''}.`;
}

// ---- plain language --------------------------------------------------------------
// One entry per code family: a short title, what to do, and where.
const IMPORT = 'BVA Import', DATA = 'Monthly Data', REVIEW = 'Review & Publish', WORKBOOK = 'the workbook, then BVA Import';
const ACCEPT = 'If the change is genuine (a refund, a reclassification, a correction), accept it with a written reason when finalizing; otherwise correct the workbook and import it again.';
export const CATALOGUE: Record<string, { title: string; action: string; where: string }> = {
  // state
  period_not_found: { title: 'Period not found', action: 'Reload the page; the period may have been removed.', where: REVIEW },
  state_uninitialized: { title: 'Period was not set up correctly', action: 'Re-create it through BVA Import.', where: IMPORT },
  published_read_only: { title: 'Already published', action: 'Published reports are read-only. Create a revision to correct it.', where: REVIEW },
  already_final: { title: 'Already final', action: 'Nothing to do; publish it when ready.', where: REVIEW },
  already_published: { title: 'Already published', action: 'Nothing to do.', where: REVIEW },
  not_final: { title: 'Not finalized yet', action: 'Finalize the validated import first.', where: IMPORT },
  no_validated_import: { title: 'No validated BVA import', action: 'Import the month\'s BVA workbook first.', where: IMPORT },
  checklist_incomplete: { title: 'Checklist item not confirmed', action: 'Review the item and confirm it.', where: REVIEW },
  checklist_item_blocked: { title: 'Checklist item cannot be confirmed yet', action: 'Resolve the linked issue first.', where: REVIEW },
  checklist_unavailable: { title: 'Checklist could not be evaluated', action: 'Nothing was changed. Try again in a moment.', where: REVIEW },
  // publish gate data rules
  required_value_missing: { title: 'A required figure is missing', action: 'A blank is not $0.00. Correct the workbook (or Monthly Totals) and import again.', where: WORKBOOK },
  cutoff_invalid: { title: 'The reporting cutoff date is not a valid date', action: 'Set the correct cutoff date and import again.', where: IMPORT },
  pace_inconsistent: { title: 'Elapsed months do not match the cutoff date', action: 'Re-import with the correct cutoff date.', where: IMPORT },
  cutoff_period_mismatch: { title: 'Cutoff date does not fit this reporting month', action: 'The cutoff must be in this month or the month before. Check the month and cutoff, then import again.', where: IMPORT },
  import_incomplete: { title: 'Budget lines are incomplete', action: 'Income and all three expense groups are required. Import the full workbook again.', where: IMPORT },
  required_line_value_missing: { title: 'A budget line is missing a figure', action: 'A blank is not $0.00. Correct the workbook and import again.', where: WORKBOOK },
  detail_unassigned: { title: 'A watch-list row has no confirmed group', action: 'Classify it (Fixed / Variable / Discretionary), or exclude it with a written reason.', where: IMPORT },
  // import validation
  cash_total_mismatch: { title: 'Cash accounts do not add up to Total Cash', action: 'Check the cash block in the workbook; correct it and import again, or accept it with a reason.', where: IMPORT },
  cutoff_already_reported: { title: 'The previous period already covers this cutoff', action: 'Check the cutoff date; each period must cover a later month.', where: IMPORT },
  cutoff_date_required: { title: 'No reporting cutoff date', action: 'Confirm the cutoff date on the import screen.', where: IMPORT },
  cutoff_not_month_end: { title: 'Cutoff is not a month end', action: 'Use the last day of the month, or accept with a reason.', where: IMPORT },
  detail_rows_missing_vs_prior: { title: 'Watch-list rows from last month are missing', action: 'Correct the workbook, or accept with a reason if they were dropped on purpose.', where: IMPORT },
  detail_section_absent: { title: 'No watch-list section in the workbook', action: 'Nothing required if none is expected; otherwise correct the workbook.', where: IMPORT },
  detail_section_empty: { title: 'The watch-list section is empty', action: 'Correct the workbook and import again.', where: WORKBOOK },
  detail_section_expected: { title: 'The watch-list section is missing', action: 'Last month had one. Correct the workbook, or accept with a reason.', where: IMPORT },
  distribution_quarter_blank: { title: 'A distribution quarter is blank', action: 'A blank is not $0.00. Enter the amount, or confirm none was received.', where: IMPORT },
  distribution_workbook_total_corrected: { title: 'The workbook\'s distribution total was corrected', action: 'Distributions YTD uses the sum of each entity\'s quarters. Review the noted difference.', where: IMPORT },
  expense_actual_mismatch: { title: 'Expense groups do not add up to total expenses', action: 'Check the expense summary; correct the workbook or accept with a reason.', where: IMPORT },
  expense_budget_mismatch: { title: 'Expense budgets do not add up', action: 'Check the expense budget totals; correct the workbook or accept with a reason.', where: IMPORT },
  expense_group_missing: { title: 'An expense group is missing', action: 'Fixed, Variable and Discretionary are all required. Correct the workbook.', where: WORKBOOK },
  income_actual_mismatch: { title: 'Income lines do not add up to total income', action: 'Check the income block; correct the workbook or accept with a reason.', where: IMPORT },
  income_budget_workbook_mismatch: { title: 'The workbook\'s income budget total differs', action: 'The calculated total is used. Review the noted difference.', where: IMPORT },
  pace_proxy_divergence: { title: 'The workbook\'s pace differs from elapsed months', action: 'The calculated pace is used. No action unless the cutoff is wrong.', where: IMPORT },
  period_follows_cutoff_month: { title: 'Report month follows the cutoff month', action: 'Expected for the monthly report. No action.', where: IMPORT },
  period_is_cutoff_month: { title: 'Report month is the cutoff month', action: 'Check this is intended.', where: IMPORT },
  reporting_convention_changed: { title: 'The reporting convention changed', action: 'Last month used a different cutoff convention. Check the cutoff, or accept with a reason.', where: IMPORT },
  reporting_month_mismatch: { title: 'Reporting month does not match the cutoff', action: 'It must be the cutoff month or the month after. Correct the month or cutoff.', where: IMPORT },
  section_missing: { title: 'A required workbook section is missing', action: 'Correct the workbook and import again.', where: WORKBOOK },
  source_value_missing: { title: 'A workbook value is blank', action: 'A blank is not $0.00. Correct the workbook and import again.', where: WORKBOOK },
  title_month_mismatch: { title: 'The workbook title names a different month', action: 'Check you imported the right workbook into the right month.', where: IMPORT },
  transfers_section_absent: { title: 'No recurring transfers section', action: 'Nothing required if none is expected.', where: IMPORT },
  transfers_section_empty: { title: 'The transfers section is empty', action: 'Correct the workbook and import again.', where: WORKBOOK },
  transfers_section_expected: { title: 'The recurring transfers section is missing', action: 'Last month had transfers. Correct the workbook, or accept with a reason.', where: IMPORT },
  transfers_total_mismatch: { title: 'Transfers do not add up to their total', action: 'Check the transfers block; correct the workbook or accept with a reason.', where: IMPORT },
  previous_period_unavailable: { title: 'The previous period could not be loaded', action: 'Press Retry on the import screen.', where: IMPORT },
  parse_warning: { title: 'The workbook could not be read cleanly', action: 'Review the workbook structure and import again.', where: WORKBOOK },
  // parser
  additional_sheets: { title: 'The workbook has extra sheets', action: 'Confirm nothing on them is needed.', where: IMPORT },
  cash_total_row_missing: { title: 'The Total Cash row was not found', action: 'Correct the workbook and import again.', where: WORKBOOK },
  cutoff_date_conflict: { title: 'The workbook shows conflicting cutoff dates', action: 'Confirm the correct cutoff date.', where: IMPORT },
  cutoff_date_missing: { title: 'The workbook has no cutoff date', action: 'Confirm the cutoff date on the import screen.', where: IMPORT },
  detail_row_blank: { title: 'A watch-list row has no figures', action: 'It was not imported. Check the workbook if it should have figures.', where: IMPORT },
  detail_code_missing: { title: 'A watch-list row has no account code', action: 'Its confirmed group cannot be carried over; classify it again, or add the code in the workbook.', where: IMPORT },
  detail_orphan_row: { title: 'A watch-list row could not be matched', action: 'Check the watch-list block in the workbook.', where: WORKBOOK },
  expense_total_row_missing: { title: 'The total expenses row was not found', action: 'Correct the workbook and import again.', where: WORKBOOK },
  income_total_row_missing: { title: 'The total income row was not found', action: 'Correct the workbook and import again.', where: WORKBOOK },
  duplicate_section_conflict: { title: 'A section appears twice with different figures', action: 'Remove the wrong copy from the workbook and import again.', where: WORKBOOK },
  duplicate_section_identical: { title: 'A section appears twice (same figures)', action: 'No action needed; consider tidying the workbook.', where: IMPORT },
  section_unparsed: { title: 'A section could not be read', action: 'Check its layout in the workbook.', where: WORKBOOK },
  transfer_labels_misaligned: { title: 'Transfer labels and amounts are misaligned', action: 'Check the transfers block in the workbook.', where: WORKBOOK },
  unrecognized_content: { title: 'Figures outside every recognized section', action: 'Confirm they are not financial data the dashboard needs.', where: IMPORT },
  // cross-period
  checks_unavailable: { title: 'Cross-period checks could not run', action: 'Nothing was changed. Try again in a moment.', where: REVIEW },
  previous_month_conflict: { title: 'The previous month has two published versions', action: 'Resolve that first in Review & Publish → Versions.', where: REVIEW },
  no_previous_period: { title: 'No earlier published period to compare with', action: 'No action.', where: REVIEW },
  previous_has_open_revision: { title: 'The previous month has an open revision', action: 'This month is compared with the version clients see now. Re-check after that revision is published.', where: REVIEW },
  cutoff_not_comparable: { title: 'Cutoff unknown; months not compared', action: 'No action unless the cutoff is wrong.', where: REVIEW },
  cutoff_not_after_previous: { title: 'This period does not cover a later month than the previous one', action: 'Check the cutoff date. After a legacy month this may be expected; accept it with a reason.', where: IMPORT },
  month_gap: { title: 'A month is not covered by any published period', action: 'Check whether a month was skipped.', where: REVIEW },
  new_year: { title: 'New year: year-to-date figures restart', action: 'No action.', where: REVIEW },
  legacy_previous: { title: 'The previous period was not validated; figures not compared', action: 'No action.', where: REVIEW },
  not_comparable: { title: 'A figure is missing; not compared', action: 'No action unless the figure should be there.', where: REVIEW },
  savings_in_ytd_missing: { title: 'Savings / Distributions In is missing', action: 'Last month had it. Enter it in Monthly Totals if known.', where: DATA },
  ytd_income_decreased: { title: 'Total income year-to-date went down', action: ACCEPT, where: IMPORT },
  ytd_expenses_decreased: { title: 'Total expenses year-to-date went down', action: ACCEPT, where: IMPORT },
  distributions_ytd_decreased: { title: 'Distributions YTD went down', action: ACCEPT, where: IMPORT },
  savings_in_ytd_decreased: { title: 'Savings / Distributions In went down', action: ACCEPT, where: IMPORT },
  annual_budget_changed: { title: 'An annual budget changed mid-year', action: 'If the budget was revised, accept it with a written reason; otherwise correct the workbook.', where: IMPORT },
  month_vs_ytd: { title: 'This month does not equal the change in year-to-date', action: 'Check the month column and year-to-date in the workbook; correct it or accept with a reason.', where: IMPORT },
  group_ytd_decreased: { title: 'An expense group\'s year-to-date went down', action: ACCEPT, where: IMPORT },
  group_budget_changed: { title: 'An expense group\'s annual budget changed', action: 'If the budget was revised, accept it with a written reason; otherwise correct the workbook.', where: IMPORT },
  income_line_decreased: { title: 'An income line went down', action: 'Review it (e.g. a reversal). No action required if expected.', where: REVIEW },
  lines_removed: { title: 'Budget lines from last month are gone', action: 'Check they were removed on purpose.', where: REVIEW },
  lines_added: { title: 'New budget lines this month', action: 'Check they are intended.', where: REVIEW },
  detail_row_missing: { title: 'A watch-list row from last month is missing', action: 'Correct the workbook, or accept with a reason if it was dropped on purpose.', where: IMPORT },
  detail_code_reused: { title: 'A watch-list code now names a different category', action: 'Check the code in the workbook; correct it or accept with a reason.', where: IMPORT },
  detail_group_changed: { title: 'A watch-list row changed group', action: 'If the reclassification is intended, accept it with a written reason.', where: IMPORT },
  detail_ytd_decreased: { title: 'A watch-list row\'s year-to-date went down', action: 'Review it (refund or reclassification). No action required if expected.', where: REVIEW },
  distribution_entity_removed: { title: 'A distribution entity from last month is gone', action: 'Check it was removed on purpose.', where: REVIEW },
  closed_quarter_missing: { title: 'A closed distribution quarter is blank', action: 'A blank is not $0.00. Enter the amount (last month had one).', where: IMPORT },
  closed_quarter_changed: { title: 'A closed distribution quarter changed', action: 'Closed quarters should not change. If it is a correction, accept it with a written reason.', where: IMPORT },
  transfers_ended: { title: 'Recurring transfers ended', action: 'Check they ended on purpose.', where: REVIEW },
  transfers_started: { title: 'New recurring transfers', action: 'Check they are intended.', where: REVIEW },
  cash_accounts_changed: { title: 'Cash accounts were added or removed', action: 'Check the change is intended.', where: REVIEW },
  later_month_cutoff: { title: 'A later published month does not cover a later cutoff', action: 'Review the later month; it may need a revision.', where: REVIEW },
  later_month_behind: { title: 'A later published month no longer follows from this one', action: 'It may need a revision too. Review it after publishing this one.', where: REVIEW },
};

export function explain(code: string) {
  const e = CATALOGUE[family(code)];
  return e || { title: bareCode(code).replace(/_/g, ' '), action: 'Review this item.', where: REVIEW };
}

// ---- the four groups --------------------------------------------------------------
// Everything a reviewer needs, in plain language:
//   blockers      must be fixed; cannot be overridden
//   needsReview   needs a written reason, or a checklist item to (re)confirm
//   warnings      worth a look; never block
//   completed     confirmed items, accepted reasons, automated checks that passed
// plus notes (context such as "new year"), kept out of the way.
// A check is listed as passed only if it actually RAN: `notRunIf` names the
// notes (info findings) that mean it was skipped, e.g. a missing month column.
const CHECK_FAMILIES = [
  { label: 'Cash accounts add up to Total Cash', codes: ['cash_total_mismatch', 'cash_total_row_missing'], kind: 'import' },
  { label: 'Income lines add up to total income', codes: ['income_actual_mismatch', 'income_total_row_missing'], kind: 'import' },
  { label: 'Expense groups add up to total expenses', codes: ['expense_actual_mismatch', 'expense_budget_mismatch', 'expense_group_missing', 'expense_total_row_missing'], kind: 'import' },
  { label: 'Every required figure is present', codes: ['required_value_missing', 'required_line_value_missing', 'source_value_missing', 'section_missing'], kind: 'import' },
  { label: 'Watch-list rows are classified', codes: ['detail_unassigned'], kind: 'import' },
  { label: 'Year-to-date figures did not go down', codes: ['ytd_income_decreased', 'ytd_expenses_decreased', 'group_ytd_decreased', 'distributions_ytd_decreased', 'savings_in_ytd_decreased'], kind: 'cross',
    notRunIf: ['not_comparable:ytd_income', 'not_comparable:ytd_expenses', 'not_comparable:distributions_ytd'] },
  { label: 'This month matches the change in year-to-date', codes: ['month_vs_ytd'], kind: 'cross', notRunIf: ['not_comparable:month_income', 'not_comparable:month_expenses', 'month_gap'] },
  { label: 'Closed distribution quarters are unchanged', codes: ['closed_quarter_changed', 'closed_quarter_missing'], kind: 'cross' },
  { label: 'Annual budgets are unchanged', codes: ['annual_budget_changed', 'group_budget_changed'], kind: 'cross' },
  { label: 'Watch-list rows are consistent with last month', codes: ['detail_row_missing', 'detail_code_reused', 'detail_group_changed'], kind: 'cross' },
];
// Findings after which crossPeriodChecks compares no figures at all.
const CROSS_STOPPERS = new Set(['no_previous_period', 'previous_month_conflict', 'cutoff_not_comparable', 'cutoff_not_after_previous', 'new_year', 'legacy_previous', 'checks_unavailable']);
// Did the cross-period figure comparisons run?
export const crossComparisonsRan = (findings: any[] | null) => Array.isArray(findings) && findings.length > 0 && !findings.some((f) => CROSS_STOPPERS.has(family(f.code)));

const entry = (code: string, message: string | null, extra: any = {}) => {
  const e = explain(code);
  return { code, title: e.title, problem: message || e.title, action: e.action, where: e.where, ...extra };
};

export function buildReview({ period, blockers, crossFindings, crossRan, items }: { period: any; blockers: any[]; crossFindings: any[] | null; crossRan: boolean; items: any[] }) {
  const data = (blockers || []).filter(isDataBlocker);
  const out = { blockers: [] as any[], needsReview: [] as any[], warnings: [] as any[], completed: [] as any[], notes: [] as any[] };
  for (const b of data) (b.overridable ? out.needsReview : out.blockers).push(entry(b.code, b.message, { kind: b.overridable ? 'reason' : 'blocker' }));
  for (const s of items || []) if (s.state !== 'confirmed') out.needsReview.push({ ...entry(s.state === 'blocked' ? 'checklist_item_blocked' : 'checklist_incomplete', itemMessage(s)), kind: 'checklist', item: s.key, state: s.state });
  const validation = (Array.isArray(period?.bva_validation_warnings) ? period.bva_validation_warnings : []).filter((w: any) => w && !w.blocksFinalize && !w.overridden);
  for (const w of validation) out.warnings.push(entry(String(w.code), w.message || null));
  for (const f of crossFindings || []) {
    if (f.severity === 'warn') out.warnings.push(entry(f.code, f.message));
    if (f.severity === 'info') out.notes.push(entry(f.code, f.message));
  }
  for (const s of items || []) if (s.state === 'confirmed') out.completed.push({ code: `checklist:${s.key}`, title: s.label, problem: itemMessage(s), action: '', where: REVIEW, kind: 'checklist' });
  const overrides = period?.bva_overrides && typeof period.bva_overrides === 'object' ? period.bva_overrides : {};
  for (const [code, o] of Object.entries(overrides) as any) {
    out.completed.push({ code, title: `Accepted: ${explain(code).title}`, problem: `Reason: "${o?.reason || ''}"${o?.by ? ` — ${o.by}` : ''}${o?.at ? `, ${String(o.at).slice(0, 10)}` : ''}`, action: '', where: REVIEW, kind: 'accepted' });
  }
  const present = new Set([...data.map((b) => family(b.code)), ...validation.map((w: any) => family(String(w.code))), ...(crossFindings || []).filter((f: any) => f.severity !== 'info').map((f: any) => family(f.code))]);
  const imported = !!period?.bva_parsed_source;
  const crossFigures = crossRan && crossComparisonsRan(crossFindings);
  const skipped = new Set((crossFindings || []).map((f: any) => bareCode(f.code)));
  for (const c of CHECK_FAMILIES) {
    const ran = c.kind === 'import' ? imported : crossFigures && !(c.notRunIf || []).some((n) => skipped.has(n));
    if (ran && !c.codes.some((k) => present.has(k))) out.completed.push({ code: `passed:${c.codes[0]}`, title: c.label, problem: 'No issues found.', action: '', where: REVIEW, kind: 'passed' });
  }
  return out;
}
