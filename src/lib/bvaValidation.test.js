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
    expect(v.reconciled.distributions.reportedTotal).toBe(5000);
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

  it('distributions: preserves the business-reported total, flags the entity-sum gap, requires Admin review, blocks finalize, and is not marked reconciled', () => {
    const v = run(workbookLikeParsed());
    const w = v.warnings.find((x) => x.code === 'distribution_entity_sum_mismatch');
    expect(w).toBeDefined();
    expect(w.sourceValue).toBe(5000); // business-reported, preserved
    expect(w.calculatedValue).toBe(8000); // entity quarters sum
    expect(w.requiresAdminReview).toBe(true);
    expect(w.blocksFinalize).toBe(true);
    expect(v.reconciled.distributions.reportedTotal).toBe(5000);
    expect(v.reconciled.distributions.reconciled).toBe(false);
    // per-entity recompute still happens
    const two = v.reconciled.distributions.entities.find((e) => e.name === 'Entity Two');
    expect(two.calculatedYtd).toBe(5000);
    expect(two.reportedYtd).toBe(2000);
    expect(two.matches).toBe(false);
  });

  it('an explicit override clears the finalize block for the distribution discrepancy', () => {
    const v = run(workbookLikeParsed(), {
      overrides: { distribution_entity_sum_mismatch: { reason: 'confirmed with bookkeeper', by: 'admin@x', at: '2026-09-03' } },
    });
    const w = v.warnings.find((x) => x.code === 'distribution_entity_sum_mismatch');
    expect(w.blocksFinalize).toBe(false);
    expect(v.blocksFinalize).toBe(false);
    // the warning is still recorded, just not blocking
    expect(w).toBeDefined();
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
  it('a real-shaped workbook blocks finalize until the distribution discrepancy is overridden', () => {
    const v = run(workbookLikeParsed());
    expect(v.blocksFinalize).toBe(true);
    expect(v.openReconciliations).toContain('distribution_entity_sum_mismatch');
  });
  it('flags a hard cash mismatch as a finalize blocker', () => {
    const p = cleanParsed();
    p.cash.reportedTotal = 41000; // accounts still sum to 40000
    const v = run(p);
    const w = v.warnings.find((x) => x.code === 'cash_total_mismatch');
    expect(w.blocksFinalize).toBe(true);
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
