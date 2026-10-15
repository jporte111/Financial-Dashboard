import { describe, it, expect } from 'vitest';
import { planBvaImport, importPreflight, groupMapFromLines } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { workbookLikeParsed, cleanParsed, distributionsGapOnlyParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';

const confirm = { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF, filename: 'SS-Budget-August-2026.xlsx', importedBy: 'admin@x' };

function plan(parsedFactory = workbookLikeParsed, { existingPeriods = [], existing = {}, groupMap = {} } = {}) {
  const parsed = parsedFactory();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  return planBvaImport({ parsed, validation, confirm, existingPeriods, existing, groupMap });
}

describe('requirement 15: re-importing a month does not duplicate the period', () => {
  it('creates a period when none exists for the month/year', () => {
    const p = plan();
    expect(p.action).toBe('create');
    expect(p.periodId).toBe(null);
    expect(p.periodData.month).toBe(7);
    expect(p.periodData.year).toBe(2026);
  });

  it('updates the SAME period in place when one already exists for that month/year', () => {
    const existingPeriods = [
      { id: 'jul-2026', month: 7, year: 2026, status: 'draft' },
      { id: 'jun-2026', month: 6, year: 2026, status: 'final' },
      { id: 'jul-2025', month: 7, year: 2025, status: 'final' },
    ];
    const p = plan(workbookLikeParsed, { existingPeriods });
    expect(p.action).toBe('update');
    expect(p.periodId).toBe('jul-2026');
    // does not touch the review-workflow status on update
    expect(p.periodData.status).toBeUndefined();
    expect(p.periodData.published).toBeUndefined();
  });
});

describe('requirement 16: other finalized periods remain available and untouched', () => {
  it('the plan references only the target period id', () => {
    const existingPeriods = [
      { id: 'jul-2026', month: 7, year: 2026, status: 'draft' },
      { id: 'jun-2026', month: 6, year: 2026, status: 'final', published: true },
      { id: 'may-2026', month: 5, year: 2026, status: 'final', published: true },
    ];
    const p = plan(workbookLikeParsed, { existingPeriods });
    expect(p.periodId).toBe('jul-2026');
    // nothing in the plan mentions the other periods
    const blob = JSON.stringify({ pd: p.periodData, bl: p.budgetLines, ca: p.cashAccounts });
    expect(blob).not.toContain('jun-2026');
    expect(blob).not.toContain('may-2026');
  });
});

describe('child-entity reconciliation on re-import', () => {
  const existing = {
    budgetLines: [
      { id: 'bl-fixed', category: 'FIXED', budget_group: 'fixed', bva_detail: false, qb_code: '' },
      { id: 'bl-old', category: 'OLD REMOVED CATEGORY', budget_group: 'variable', bva_detail: true, qb_code: '9998' },
    ],
    cashAccounts: [{ id: 'ca-checking', name: 'Checking' }],
    distributions: [{ id: 'd-one', entity_name: 'Entity One' }],
    transfers: [{ id: 't-tax', amount: 500, purpose: 'Tax Savings', source: 'Acct A' }],
  };

  it('updates matching rows, creates new ones, and deletes rows no longer in the workbook — all within the period', () => {
    const p = plan(cleanParsed, { existingPeriods: [{ id: 'jul-2026', month: 7, year: 2026 }], existing });
    const fixed = p.budgetLines.toUpdate.find((u) => u.id === 'bl-fixed');
    expect(fixed).toBeDefined();
    expect(fixed.data.budget_group).toBe('fixed');
    expect(p.budgetLines.toDelete).toContain('bl-old');
    expect(p.budgetLines.toCreate.length).toBeGreaterThan(0);
    expect(p.cashAccounts.toUpdate.some((u) => u.id === 'ca-checking')).toBe(true);
    expect(p.distributions.toUpdate.some((u) => u.id === 'd-one')).toBe(true);
    expect(p.transfers.toUpdate.some((u) => u.id === 't-tax')).toBe(true);
  });
});

describe('income budget + distributions handling', () => {
  it('stores the workbook\'s printed income budget (the calculated one stays in the warning)', () => {
    const p = plan(workbookLikeParsed);
    expect(p.periodData.annual_budgeted_income).toBe(1320000); // printed
    expect(p.periodData.annual_budgeted_income_workbook).toBe(1320000);
    expect(p.warnings.find((w) => w.code === 'income_budget_workbook_mismatch')).toMatchObject({ sourceValue: 1320000, calculatedValue: 1320012 });
  });

  it('stores the workbook\'s printed Distributions YTD, each entity\'s printed YTD, and its quarter totals', () => {
    const p = plan(workbookLikeParsed);
    // The workbook prints 6500; the entities' quarters add up to 8000 (kept in the warning).
    expect(p.periodData.distributions_ytd).toBe(6500);
    expect(p.warnings.find((w) => w.code === 'distribution_workbook_total_corrected')).toMatchObject({ sourceValue: 6500, calculatedValue: 8000 });
    const two = p.distributions.toCreate.find((d) => d.entity_name === 'Entity Two');
    expect(two.workbook_ytd).toBe(4500);
    expect(typeof p.periodData.distribution_quarter_totals).toBe('object');
  });

  it('with no printed total, the calculated one is stored', () => {
    const parsed = workbookLikeParsed();
    parsed.distributions.reportedTotal = null;
    parsed.income.reportedBudgetTotal = null;
    const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
    const p = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF } });
    expect(p.periodData.distributions_ytd).toBe(8000);
    expect(p.periodData.annual_budgeted_income).toBe(1320012);
  });
});

describe('detail-group mapping: preserve confirmed mappings, never fall back to discretionary', () => {
  const detailLines = (p) =>
    Object.fromEntries(
      [...p.budgetLines.toCreate, ...p.budgetLines.toUpdate.map((u) => u.data)]
        .filter((l) => l.bva_detail)
        .map((l) => [l.qb_code, l])
    );

  it('re-uses a prior confirmed mapping (by normalized account number) and marks the row confirmed', () => {
    const prior = groupMapFromLines([
      { qb_code: '6300', budget_group: 'discretionary', group_confirmed: true },
      { qb_code: '6100', budget_group: 'variable', group_confirmed: true },
      { qb_code: '6200', budget_group: 'fixed', group_confirmed: false }, // not confirmed -> ignored
    ]);
    const byCode = detailLines(plan(cleanParsed, { groupMap: prior }));
    expect(byCode['6300'].budget_group).toBe('discretionary');
    expect(byCode['6300'].group_confirmed).toBe(true);
    expect(byCode['6100'].budget_group).toBe('variable');
    expect(byCode['6100'].group_confirmed).toBe(true);
    // no confirmed prior mapping -> Unassigned, not discretionary
    expect(byCode['6200'].budget_group).toBe('unassigned');
    expect(byCode['6200'].group_confirmed).toBe(false);
  });

  it('with no prior mappings, every monitored detail row is unassigned/unconfirmed and none default to discretionary', () => {
    const byCode = detailLines(plan(cleanParsed));
    const rows = Object.values(byCode);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.budget_group === 'unassigned')).toBe(true);
    expect(rows.every((l) => l.group_confirmed === false)).toBe(true);
    expect(rows.some((l) => l.budget_group === 'discretionary')).toBe(false);
  });

  it('the DETAIL watchlist rows are never mixed into the Fixed/Variable/Discretionary summary lines', () => {
    const p = plan(cleanParsed);
    const summaries = [...p.budgetLines.toCreate, ...p.budgetLines.toUpdate.map((u) => u.data)].filter(
      (l) => !l.bva_detail && ['fixed', 'variable', 'discretionary'].includes(l.budget_group)
    );
    // exactly the three group-summary rows, straight from the expense-summary block
    expect(summaries).toHaveLength(3);
    expect(summaries.every((l) => l.group_confirmed === true)).toBe(true);
  });
});

// Finalizing and publishing moved to the server-side gate
// (base44/shared/publishGate.ts, tested in publishGate.test.js and
// periodTransition.test.js). The import plan itself never writes state.
describe('import plan never writes period state', () => {
  it('omits status / published / bva_import_status / finalized_* on create and update', () => {
    const parsed = workbookLikeParsed();
    const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
    for (const existingPeriods of [[], [{ id: 'p1', month: 7, year: 2026, published: false }]]) {
      const p = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, existingPeriods });
      for (const k of ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides']) {
        expect(p.periodData).not.toHaveProperty(k);
      }
    }
  });
});

describe('importPreflight (checked before any write)', () => {
  it('allows creating a new month', () => {
    expect(importPreflight(null)).toEqual({ allowed: true, action: 'create', needsInvalidate: false });
  });
  it('refuses a published month', () => {
    const r = importPreflight({ id: 'p1', label: 'July 2026', published: true, status: 'final' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/published/i);
  });
  it('requires a server-side reset to draft before updating an unpublished month', () => {
    expect(importPreflight({ id: 'p1', published: false, status: 'final' })).toEqual({ allowed: true, action: 'update', needsInvalidate: true });
    expect(importPreflight({ id: 'p1', published: false, status: 'draft' }).needsInvalidate).toBe(true);
  });
});
