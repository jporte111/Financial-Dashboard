import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';
import { round2, STATUS } from './bva.js';

// Requirement 18: every acceptance value for the reference period must
// reconcile. Both the real workbook and its expected-values file are
// client-confidential and live only in the git-ignored bva-workbooks/
// directory — no client figures are committed to this repo. When either file
// is absent (e.g. CI), this suite is skipped with a notice.
//
// bva-workbooks/expected-july-2026.json shape:
//   { "cutoffDate", "elapsedMonths", "pacePct",
//     "cash": { "total" },
//     "income": { "actualTotal", "budgetTotalCalculated", "budgetTotalWorkbook", "remaining", "percentUsed" },
//     "expenses": { "actualTotal", "budgetTotal", "remaining", "percentUsed",
//                   "overallVariance", "overallVariancePct" },
//     "groups": { "fixed": { "actual","annual","remaining","percentUsed","variance","variancePct","status" }, "variable": {...}, "discretionary": {...} },
//     "distributions": { "entitySum", "workbookReportedTotal",
//                         "gap": { "entity", "quarter", "amount", "entityYtd", "message" } },
//     "transfers": { "total" } }
const DIR = path.resolve(process.cwd(), 'bva-workbooks');
const WORKBOOK = path.join(DIR, 'SS-Budget-August-2026.xlsx');
const EXPECTED_FILE = path.join(DIR, 'expected-july-2026.json');
const ready = fs.existsSync(WORKBOOK) && fs.existsSync(EXPECTED_FILE);

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[bvaAcceptance] skipped — need both bva-workbooks/SS-Budget-August-2026.xlsx and bva-workbooks/expected-july-2026.json (git-ignored) to run.`
  );
}

describe.skipIf(!ready)('acceptance values reconcile against the reference workbook (requirement 18)', () => {
  const EXPECTED = ready ? JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')) : {};
  const parsed = ready ? parseBvaWorkbook(fs.readFileSync(WORKBOOK)) : null;
  const v = ready ? validateBva(parsed, { cutoffDate: parsed.meta.cutoffDate }) : null;
  const R = v ? v.reconciled : null;
  const g = (key) => R.expenses.groups.find((x) => x.key === key);
  const pct = (x) => round2(x * 100);

  it('reporting context matches', () => {
    expect(parsed.meta.cutoffDate).toBe(EXPECTED.cutoffDate);
    expect(v.elapsedMonths).toBe(EXPECTED.elapsedMonths);
    expect(pct(v.pacePct)).toBe(EXPECTED.pacePct);
  });

  it('Total Cash reconciles to the workbook total', () => {
    expect(R.cash.total).toBe(EXPECTED.cash.total);
    expect(v.warnings.find((w) => w.code === 'cash_total_mismatch')).toBeUndefined();
  });

  it('Income: calculated budget wins; workbook total kept as a non-blocking discrepancy', () => {
    expect(R.income.actualTotal).toBe(EXPECTED.income.actualTotal);
    expect(R.income.budgetTotal).toBe(EXPECTED.income.budgetTotalCalculated);
    expect(R.income.workbookBudgetTotal).toBe(EXPECTED.income.budgetTotalWorkbook);
    expect(R.income.remaining).toBe(EXPECTED.income.remaining);
    expect(pct(R.income.percentUsed)).toBe(EXPECTED.income.percentUsed);
    expect(v.warnings.find((w) => w.code === 'income_budget_workbook_mismatch').blocksFinalize).toBe(false);
  });

  it('Expenses totals and overall pace variance reconcile', () => {
    expect(R.expenses.actualTotal).toBe(EXPECTED.expenses.actualTotal);
    expect(R.expenses.budgetTotal).toBe(EXPECTED.expenses.budgetTotal);
    expect(R.expenses.remaining).toBe(EXPECTED.expenses.remaining);
    expect(pct(R.expenses.percentUsed)).toBe(EXPECTED.expenses.percentUsed);
    expect(round2(R.expenses.overall.varianceToPace)).toBe(EXPECTED.expenses.overallVariance);
    expect(pct(R.expenses.overall.variancePct)).toBe(EXPECTED.expenses.overallVariancePct);
    expect(R.expenses.overall.favorable).toBe(false);
  });

  for (const key of ['fixed', 'variable', 'discretionary']) {
    it(`${key} group reconciles (actual, budget, remaining, % used, variance $/%, status)`, () => {
      const e = EXPECTED.groups[key];
      const x = g(key);
      expect(x.actual).toBe(e.actual);
      expect(x.annual).toBe(e.annual);
      expect(round2(x.remaining)).toBe(e.remaining);
      expect(pct(x.percentUsed)).toBe(e.percentUsed);
      expect(round2(x.varianceToPace)).toBe(e.variance);
      expect(pct(x.variancePct)).toBe(e.variancePct);
      expect(x.status).toBe(e.status === 'over' ? STATUS.OVER : e.status === 'under' ? STATUS.UNDER : e.status);
    });
  }

  it('Fixed + Variable + Discretionary reconcile to the totals', () => {
    expect(round2(g('fixed').actual + g('variable').actual + g('discretionary').actual)).toBe(EXPECTED.expenses.actualTotal);
    expect(round2(g('fixed').annual + g('variable').annual + g('discretionary').annual)).toBe(EXPECTED.expenses.budgetTotal);
  });

  it('Distributions: the known formula defect -- the calculated entity-quarter total is shown; the printed one is kept; a warning, no override', () => {
    expect(R.distributions.entitySum).toBe(EXPECTED.distributions.entitySum);
    expect(R.distributions.ytd).toBe(EXPECTED.distributions.entitySum);
    expect(R.distributions.workbookReportedTotal).toBe(EXPECTED.distributions.workbookReportedTotal);
    expect(R.distributions.reconciled).toBe(false); // factually: the workbook total disagrees
    const w = v.warnings.find((x) => x.code === 'distribution_workbook_total_corrected');
    expect(w).toBeDefined();
    expect(w.requiresAdminReview).toBe(true); // still flagged so the workbook formula gets fixed
    expect(w.blocksFinalize).toBe(false); // arithmetically correct; no override needed
    expect(w.sourceValue).toBe(EXPECTED.distributions.workbookReportedTotal);
    expect(w.calculatedValue).toBe(EXPECTED.distributions.entitySum);
    expect(w.difference).toBe(EXPECTED.distributions.gap.amount);
    // The wording changed with the printed-total rule; the attributed gap is still named.
    expect(w.message).toMatch(/^The workbook does not add up: its Distributions YTD total omits .*known workbook formula defect/);
    expect(w.knownDefect).toBe(true);
    expect(R.display.distributions_ytd).toBe(EXPECTED.distributions.entitySum);
    expect(v.blocksFinalize).toBe(false);
    expect(R.distributions.entities.some((e) => e.matches === false)).toBe(true);
  });

  it("the flagged entity's YTD is its own quarters summed, ignoring the workbook's broken per-entity formula", () => {
    const e = R.distributions.entities.find((x) => x.name === EXPECTED.distributions.gap.entity);
    expect(e).toBeDefined();
    expect(round2(e.q1 + e.q2 + e.q3 + e.q4)).toBe(EXPECTED.distributions.gap.entityYtd);
    expect(e.calculatedYtd).toBe(EXPECTED.distributions.gap.entityYtd);
  });

  it('Recurring transfers total reconciles; labels flagged for review', () => {
    expect(R.transfers.total).toBe(EXPECTED.transfers.total);
    expect(v.warnings.find((w) => w.code === 'transfer_labels_misaligned')).toBeDefined();
  });

  it('every monitored DETAIL category is Unassigned until an admin confirms its group', () => {
    expect(R.detail.categories.length).toBeGreaterThan(0);
    expect(R.detail.categories.every((d) => (d.group || 'unassigned') === 'unassigned')).toBe(true);
  });
});