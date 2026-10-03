import { describe, it, expect } from 'vitest';
import { buildBvaDashboard } from './bvaDashboard.js';

// The five stored September 2026 warnings, with the audit trail exactly as
// saved in the Import screen: an override reason for the workbook title, a
// source correction for the workbook's pace proxy, and no confirmation yet
// for the blank Sample Bank Q1/Q2 distribution cells.
const WARNINGS = [
  { code: 'transfer_labels_misaligned', section: 'transfers', message: 'Recurring transfer labels vary between workbook layouts; confirm the source and purpose of each transfer in Admin.', requiresAdminReview: true, blocksFinalize: false },
  { code: 'period_follows_cutoff_month', section: 'meta', message: 'September 2026 is the report month; its data runs through 2026-08-31 (the previous month end).', requiresAdminReview: true, blocksFinalize: false },
  { code: 'title_month_mismatch', section: 'meta', message: 'The workbook title names August 2026, but it is being imported as September 2026.', requiresAdminReview: true, blocksFinalize: false },
  { code: 'pace_proxy_divergence', section: 'expenses', message: "The workbook's pace reference differs from elapsed reporting months / 12. Calculated pace is used.", sourceValue: 58.33, calculatedValue: 66.67, requiresAdminReview: true, blocksFinalize: false },
  { code: 'distribution_quarter_blank', section: 'distributions', message: 'Blank distribution cells for quarters that have begun: Sample Bank Q1, Sample Bank Q2. They add nothing to Distributions YTD; confirm none was received.', requiresAdminReview: true, blocksFinalize: false },
];

const PERIOD = (extra = {}) => ({
  label: 'September 2026',
  month: 9,
  year: 2026,
  months_elapsed: 8,
  reporting_cutoff_date: '2026-08-31',
  status: 'final',
  published: true,
  bva_import_status: 'final',
  bva_validation_warnings: WARNINGS,
  ...extra,
});

const LINES = [
  { id: 'fix', category: 'FIXED', budget_group: 'fixed', bva_detail: false, group_confirmed: true, ytd_actual: 1000, annual_budget: 2400, month_actual: null },
];

const TRANSFERS = [
  { id: 't1', amount: 1000.00, source: 'Sample Bank', purpose: 'Sample Purpose', visible_to_client: true },
  { id: 't2', amount: 22224.71, source: 'Mortgage', purpose: 'Sample Bank', visible_to_client: true },
];

const DISTRIBUTIONS = [{ id: 'd1', entity_name: 'Sample Bank', q1: null, q2: null, q3: 4500, q4: null }];

const build = (period, distributions = DISTRIBUTIONS, transfers = TRANSFERS) =>
  buildBvaDashboard(
    { period, budgetLines: LINES, cashAccounts: [], distributions, transfers, savingsSpends: [] },
    {}
  );

describe('warning resolution classification', () => {
  it('classifies the September warnings from the saved audit trail', () => {
    const vm = build(
      PERIOD({
        bva_overrides: {
          title_month_mismatch: { reason: 'September reporting intentionally uses the August BVA.', by: 'admin', at: '2026-10-03T16:33:48.927Z' },
        },
        bva_corrections: [
          { id: 'c1', kind: 'source', target: 'pace_proxy_divergence', path: 'expenseSummary.pacePctProxy', original_value: 58.33, value: 66.67, reason: 'this is the correct pace', by: 'admin', at: '2026-10-03T16:34:37.106Z' },
        ],
      })
    );
    expect(vm.warnings.resolution.accepted.map((w) => w.code)).toContain('title_month_mismatch');
    expect(vm.warnings.resolution.accepted.find((w) => w.code === 'title_month_mismatch').note).toContain('August BVA');
    expect(vm.warnings.resolution.resolved.map((w) => w.code)).toContain('pace_proxy_divergence');
    expect(vm.warnings.resolution.resolved.map((w) => w.code)).toContain('transfer_labels_misaligned');
    expect(vm.warnings.resolution.informational.map((w) => w.code)).toContain('period_follows_cutoff_month');
    expect(vm.warnings.resolution.unresolved.map((w) => w.code)).toEqual(['distribution_quarter_blank']);
    expect(vm.warnings.unresolved.length).toBe(1);
    expect(vm.hasUnresolvedWarnings).toBe(true);
  });

  it('keeps every stored warning in the list (audit history preserved)', () => {
    const vm = build(PERIOD());
    expect(vm.warnings.list.length).toBe(WARNINGS.length);
  });

  it('marks blank distribution quarters resolved once each is confirmed', () => {
    const vm = build(
      PERIOD({
        bva_overrides: { title_month_mismatch: { reason: 'intentional', by: 'admin', at: '2026-10-03T16:33:48.927Z' } },
        bva_corrections: [
          { id: 'c1', kind: 'source', target: 'pace_proxy_divergence', path: 'expenseSummary.pacePctProxy', original_value: 58.33, value: 66.67, reason: 'correct pace', by: 'admin', at: '2026-10-03T16:34:37.106Z' },
        ],
      }),
      [{ id: 'd1', entity_name: 'Sample Bank', q1: 0, q2: 0, q3: 4500, q4: null }]
    );
    expect(vm.warnings.resolution.resolved.map((w) => w.code)).toContain('distribution_quarter_blank');
    expect(vm.warnings.unresolved.length).toBe(0);
  });

  it('keeps the transfer-label warning unresolved while any transfer lacks labels', () => {
    const vm = build(PERIOD(), DISTRIBUTIONS, [{ id: 't1', amount: 1, source: null, purpose: null, visible_to_client: true }]);
    expect(vm.warnings.resolution.unresolved.map((w) => w.code)).toContain('transfer_labels_misaligned');
  });
});