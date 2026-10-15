import { describe, it, expect } from 'vitest';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, workbookLikeParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { round2 } from './bva.js';

const run = (parsed, opts = {}) => validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF, ...opts });

describe('parts-vs-total reconciliations (requirements 1-6)', () => {
  it('1. income details equal Total Income', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.income.actualTotal).toBe(770007);
    expect(v.warnings.find((w) => w.code === 'income_actual_mismatch')).toBeUndefined();
  });

  it('2. expense groups equal Total Expenses', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.expenses.actualTotal).toBe(215000);
    expect(v.warnings.find((w) => w.code === 'expense_actual_mismatch')).toBeUndefined();
  });

  it('3. expense budgets equal Total Annual Expense Budget', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.expenses.budgetTotal).toBe(360000);
    expect(v.warnings.find((w) => w.code === 'expense_budget_mismatch')).toBeUndefined();
  });

  it('4. cash accounts equal Total Cash', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.cash.total).toBe(40000);
    expect(v.warnings.find((w) => w.code === 'cash_total_mismatch')).toBeUndefined();
  });

  it('5. distribution entities equal Distributions YTD (clean case)', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.distributions.entitySum).toBe(5000);
    expect(v.reconciled.distributions.ytd).toBe(5000);
    expect(v.reconciled.distributions.workbookReportedTotal).toBe(5000);
    expect(v.reconciled.distributions.reconciled).toBe(true);
  });

  it('6. recurring transfers equal their total', () => {
    const v = run(cleanParsed());
    expect(v.reconciled.transfers.total).toBe(2750);
  });
});

describe('workbook defect handling', () => {
  it('income budget: uses the independently calculated total, records the workbook value as a discrepancy, does not block finalize', () => {
    const v = run(workbookLikeParsed());
    const w = v.warnings.find((x) => x.code === 'income_budget_workbook_mismatch');
    expect(w).toBeDefined();
    expect(w.sourceValue).toBe(1320000);
    expect(w.calculatedValue).toBe(1320012);
    expect(w.blocksFinalize).toBe(false);
    expect(w.requiresAdminReview).toBe(true);
    // reconciled value is the calculated one
    expect(v.reconciled.income.budgetTotal).toBe(1320012);
    expect(v.reconciled.income.workbookBudgetTotal).toBe(1320000);
    expect(v.reconciled.income.remaining).toBe(round2(1320012 - 770007));
  });

  it('distributions, known formula defect: the calculated entity-quarter total is shown; the printed one is kept; a warning, no override', () => {
    const v = run(workbookLikeParsed());
    const w = v.warnings.find((x) => x.code === 'distribution_workbook_total_corrected');
    expect(w).toBeDefined();
    expect(w.sourceValue).toBe(6500); // the workbook's own (wrong) displayed total — audit only
    expect(w.calculatedValue).toBe(8000); // entity-quarter sum — authoritative
    expect(w.requiresAdminReview).toBe(true); // still flagged so the source spreadsheet can be fixed
    expect(w.blocksFinalize).toBe(false); // arithmetically correct; no override needed
    // the specific, attributed correction notice
    expect(w.message).toBe(
      'The workbook does not add up: its Distributions YTD total omits Entity Two Q2 of $1,500.00 (a known workbook formula defect). The calculated entity-quarter total of $8,000.00 is shown.'
    );
    expect(w.knownDefect).toBe(true);
    expect(v.reconciled.distributions.entitySum).toBe(8000);
    expect(v.reconciled.distributions.ytd).toBe(8000); // calculated, for checking
    expect(v.reconciled.display.distributions_ytd).toBe(8000); // what the dashboard shows (the known-defect exception)
    expect(v.reconciled.distributions.workbookReportedTotal).toBe(6500);
    expect(v.reconciled.distributions.reconciled).toBe(false); // factually: workbook != calculated
    // (this fixture also has an unrelated, still-blocking cash discrepancy —
    // see the "finalize gating" describe block below for that interaction —
    // so overall v.blocksFinalize is not asserted here.)
    // per-entity recompute still happens, ignoring each entity's own (also
    // wrong) displayed YTD
    const two = v.reconciled.distributions.entities.find((e) => e.name === 'Entity Two');
    expect(two.calculatedYtd).toBe(5000);
    expect(two.reportedYtd).toBe(4500);
    expect(two.matches).toBe(false);
  });

  it('falls back to a generic distributions message when the gap cannot be attributed to one entity/quarter', () => {
    const p = cleanParsed();
    // Reported total disagrees, but no per-quarter column totals were parsed,
    // so there is nothing to pin the gap to.
    p.distributions.reportedTotal = 4000;
    const v = run(p);
    const w = v.warnings.find((x) => x.code === 'distribution_workbook_total_corrected');
    expect(w).toBeDefined();
    expect(w.blocksFinalize).toBe(false);
    expect(w.message).toBe("The workbook does not add up: the entities' quarters do not sum to its Distributions YTD total. The workbook's total is shown; the entity-quarter total is kept for checking.");
    expect(v.reconciled.display.distributions_ytd).toBe(4000);
  });

  it('carries forward parser structural warnings (misaligned transfer labels)', () => {
    const v = run(workbookLikeParsed());
    const w = v.warnings.find((x) => x.code === 'transfer_labels_misaligned');
    expect(w).toBeDefined();
    expect(w.requiresAdminReview).toBe(true);
    expect(w.blocksFinalize).toBe(false);
  });
});

describe('finalize gating (requirement: no Final while required reconciliations fail)', () => {
  it('a clean workbook does not block finalize', () => {
    expect(run(cleanParsed()).blocksFinalize).toBe(false);
  });
  it('a real-shaped workbook\'s cash discrepancy and distributions correction are warnings, not blockers', () => {
    const v = run(workbookLikeParsed());
    expect(v.blocksFinalize).toBe(false);
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['cash_total_mismatch', 'distribution_workbook_total_corrected']));
  });
  it('a cash mismatch keeps both figures, uses the calculated total, and does not block', () => {
    const p = cleanParsed();
    p.cash.reportedTotal = 41000; // accounts still sum to 40000
    const v = run(p);
    const w = v.warnings.find((x) => x.code === 'cash_total_mismatch');
    expect(w).toMatchObject({ blocksFinalize: false, sourceValue: 41000, calculatedValue: 40000 });
    expect(v.reconciled.cash.total).toBe(40000); // calculated value used
  });
});

describe('detail categories are recomputed, never read from workbook formula columns', () => {
  it('recomputes remaining / percent / variance / status per monitored category', () => {
    const v = run(cleanParsed());
    const byCode = Object.fromEntries(v.reconciled.detail.categories.map((c) => [c.code, c]));
    // Gardening: 35000 of 60000 at 7 months -> exactly on pace
    expect(round2(byCode['6100'].varianceToPace)).toBe(0);
    expect(byCode['6100'].status).toBe('on_pace');
    // Clothing: 70000 > 60000 annual -> exceeded
    expect(byCode['6300'].status).toBe('annual_budget_exceeded');
    // Medical: 40000 of 60000 -> over expected pace but not exceeded
    expect(byCode['6400'].status).toBe('over_pace');
    // Tutoring: 5000 of 60000 -> well under pace
    expect(byCode['6200'].status).toBe('under_pace');
    // all still marked unassigned until an admin maps them to a group
    expect(v.reconciled.detail.categories.every((c) => c.group === 'unassigned')).toBe(true);
  });
});

describe('elapsed months derive from the confirmed cutoff, not the filename', () => {
  it('uses cutoff 2026-07-31 => 7 months even though the title says August', () => {
    const v = validateBva(workbookLikeParsed(), { cutoffDate: '2026-07-31' });
    expect(v.elapsedMonths).toBe(7);
    expect(round2(v.pacePct * 100)).toBe(58.33);
  });
  it('an explicit elapsedMonths option overrides the cutoff', () => {
    const v = validateBva(cleanParsed(), { elapsedMonths: 6 });
    expect(v.elapsedMonths).toBe(6);
  });
});
