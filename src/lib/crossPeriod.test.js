// Cross-period checks (base44/shared/crossPeriod.ts). Fictional data only.
import { describe, it, expect } from 'vitest';
import { crossPeriodChecks, laterMonthChecks, alignedPrevious, alignedNext, cutoffIndex, CROSS_PERIOD_PREFIX } from '../../base44/shared/crossPeriod.ts';
import { crossPeriodBlockers, evaluatePublish, recordedOverrides } from '../../base44/shared/publishGate.ts';

// A validated, published month whose data runs through the previous month end
// (the report-month convention), with simple fictional figures.
const P = (month, extra = {}) => ({
  id: `p${month}`, label: `Month ${month}`, month, year: 2030, status: 'final', bva_import_status: 'final', published: true,
  reporting_cutoff_date: `2030-${String(month - 1).padStart(2, '0')}-28`, months_elapsed: month - 1,
  ytd_income: 1000 * (month - 1), ytd_expenses: 800 * (month - 1), month_income: 1000, month_expenses: 800,
  distributions_ytd: 300, savings_in_ytd: 400, annual_budgeted_income: 12345, annual_budgeted_expenses: 9876, total_cash: 4321,
  ...extra,
});
const lines = (month, over = {}) => [
  { id: `i${month}`, category: 'Test Income', budget_group: 'income', ytd_actual: 1000 * (month - 1), annual_budget: 12345, month_actual: 1000 },
  ...['fixed', 'variable', 'discretionary'].map((g, k) => ({ id: `${g}${month}`, category: g.toUpperCase(), budget_group: g, ytd_actual: (200 + 100 * k) * (month - 1), annual_budget: 3000 + 300 * k, month_actual: 200 + 100 * k, ...(over[g] || {}) })),
  { id: `d${month}`, category: 'Test Watch Row', budget_group: 'variable', group_confirmed: true, bva_detail: true, qb_code: '9001', ytd_actual: 50 * (month - 1), annual_budget: 700, ...(over.detail || {}) },
];
const side = (month, { period = {}, line = {}, distributions, transfers, cash } = {}) => ({
  period: P(month, period),
  lines: lines(month, line),
  distributions: distributions || [{ entity_name: 'Test Entity', q1: 100, q2: 200, q3: month > 7 ? 50 : null, q4: null }],
  transfers: transfers || [{ source: 'Test Bank', purpose: 'Test Savings', amount: 10 }],
  cash: cash || [{ name: 'Test Checking', balance: 4321 }],
});
const run = (cur, prev, ctx) => crossPeriodChecks(cur, prev, ctx);
const codes = (f, sev) => f.filter((x) => !sev || x.severity === sev).map((x) => x.code);

describe('a consistent month passes', () => {
  it('no findings for an ordinary next month', () => {
    const f = run(side(8), side(7));
    expect(codes(f, 'block')).toEqual([]);
    expect(codes(f, 'warn')).toEqual([]);
  });
  it('the first period (no earlier published one) is only a note', () => {
    expect(run(side(8), null)).toEqual([expect.objectContaining({ code: 'no_previous_period', severity: 'info' })]);
  });
});

describe('cutoff alignment', () => {
  it('a cutoff not after the previous one blocks when the previous month was validated', () => {
    const f = run(side(8, { period: { reporting_cutoff_date: '2030-06-30' } }), side(7));
    expect(f).toEqual([expect.objectContaining({ code: 'cutoff_not_after_previous', severity: 'block' })]);
  });
  it('...but only warns after a legacy month (the convention switch)', () => {
    const legacy = side(7, { period: { bva_import_status: undefined, reporting_cutoff_date: undefined, months_elapsed: 7 } });
    const f = run(side(8, { period: { reporting_cutoff_date: '2030-07-31', months_elapsed: 7 } }), legacy);
    expect(f).toEqual([expect.objectContaining({ code: 'cutoff_not_after_previous', severity: 'warn' })]);
  });
  it('a legacy previous month is context only: its figures are not compared', () => {
    const legacy = side(6, { period: { bva_import_status: undefined, reporting_cutoff_date: undefined, months_elapsed: 6, ytd_income: 999999 } });
    const f = run(side(8), legacy);
    expect(codes(f)).toContain('legacy_previous');
    expect(codes(f, 'warn')).toEqual([]);
  });
  it('a skipped month warns, and month vs year-to-date is not checked across the gap', () => {
    const f = run(side(9, { period: { month_income: 1 } }), side(7));
    expect(codes(f, 'warn')).toContain('month_gap');
    expect(codes(f)).not.toContain('month_vs_ytd:income');
  });
  it('year-to-date restarts with the year: no comparison across years', () => {
    const jan = side(2, { period: { year: 2031, reporting_cutoff_date: '2031-01-31', ytd_income: 1 } });
    const f = run(jan, side(12, { period: { reporting_cutoff_date: '2030-12-31' } }));
    expect(codes(f)).toEqual(['new_year']);
  });
  it('a January report carrying December data still belongs to the old year', () => {
    const jan = side(1, { period: { year: 2031, reporting_cutoff_date: '2030-12-31', months_elapsed: 12, ytd_income: 1 } });
    const f = run(jan, side(12, { period: { reporting_cutoff_date: '2030-11-30', ytd_income: 11000 } }));
    expect(codes(f, 'warn')).toContain('ytd_income_decreased');
  });
});

describe('figures that should only grow', () => {
  it.each([
    ['ytd_income', 'ytd_income_decreased'],
    ['ytd_expenses', 'ytd_expenses_decreased'],
    ['distributions_ytd', 'distributions_ytd_decreased'],
    ['savings_in_ytd', 'savings_in_ytd_decreased'],
  ])('%s lower than last month is a warning (no reason needed)', (field, code) => {
    const f = run(side(8, { period: { [field]: 1 } }), side(7));
    expect(codes(f, 'warn')).toContain(code);
  });
  it('a group or income-line year-to-date decrease is a warning', () => {
    const cur = side(8, { line: { variable: { ytd_actual: 1 } } });
    cur.lines[0].ytd_actual = 1;
    const f = run(cur, side(7));
    expect(codes(f, 'warn')).toContain('group_ytd_decreased:variable');
    expect(codes(f, 'warn')).toContain('income_line_decreased:test income');
  });
  it('a difference within a dollar is rounding, not a change', () => {
    const f = run(side(8, { period: { ytd_income: 7000 - 0.99 } }), side(7));
    expect(codes(f)).not.toContain('ytd_income_decreased');
  });
  it('mid-year budget changes are warnings', () => {
    const f = run(side(8, { period: { annual_budgeted_expenses: 9000 }, line: { fixed: { annual_budget: 1 } } }), side(7));
    expect(codes(f, 'warn')).toEqual(expect.arrayContaining(['annual_budget_changed:annual_budgeted_expenses', 'group_budget_changed:fixed']));
  });
});

describe('month vs year-to-date', () => {
  it('this month must equal the change in year-to-date since the previous cutoff', () => {
    const f = run(side(8, { period: { month_expenses: 5 }, line: { fixed: { month_actual: 5 } } }), side(7));
    expect(codes(f, 'warn')).toEqual(expect.arrayContaining(['month_vs_ytd:expenses', 'month_vs_ytd:fixed']));
  });
  it('a missing month column is not a mismatch (never read as $0.00)', () => {
    const f = run(side(8, { period: { source_missing_fields: ['month_income', 'month_expenses'], month_income: 0, month_expenses: 0 } }), side(7));
    expect(codes(f, 'warn')).toEqual([]);
    expect(codes(f, 'info')).toEqual(expect.arrayContaining(['not_comparable:month_income', 'not_comparable:month_expenses']));
  });
});

describe('missing vs explicit zero', () => {
  it('a value listed as missing is not compared (no false "decrease")', () => {
    const f = run(side(8, { period: { source_missing_fields: ['distributions_ytd'], distributions_ytd: 0 } }), side(7));
    expect(codes(f)).not.toContain('distributions_ytd_decreased');
    expect(codes(f, 'info')).toContain('not_comparable:distributions_ytd');
  });
  it('an explicit 0 is a real value: a drop to 0 is a decrease', () => {
    expect(codes(run(side(8, { period: { distributions_ytd: 0 } }), side(7)), 'warn')).toContain('distributions_ytd_decreased');
  });
  it('Savings / Distributions In missing now (present before) only warns -- not required yet', () => {
    const f = run(side(8, { period: { source_missing_fields: ['savings_in_ytd'] } }), side(7));
    expect(f.find((x) => x.code === 'savings_in_ytd_missing')).toMatchObject({ severity: 'warn' });
  });
});

describe('distributions: closed quarters', () => {
  const prev = () => side(8); // data through July: Q1 and Q2 are closed
  it('a closed quarter that changed, or is now blank, is a warning (blank stays missing)', () => {
    const changed = run(side(9, { distributions: [{ entity_name: 'Test Entity', q1: 150, q2: 200, q3: 60 }] }), prev());
    expect(codes(changed, 'warn')).toContain('closed_quarter_changed:test entity:q1');
    const blank = run(side(9, { distributions: [{ entity_name: 'Test Entity', q1: null, q2: 200, q3: 60 }] }), prev());
    expect(codes(blank, 'warn')).toContain('closed_quarter_missing:test entity:q1');
    expect(codes(blank, 'block')).toEqual([]);
  });
  it('the open quarter may change freely', () => {
    const f = run(side(9, { distributions: [{ entity_name: 'Test Entity', q1: 100, q2: 200, q3: 999 }] }), prev());
    expect(codes(f).filter((c) => c.startsWith('closed_quarter'))).toEqual([]);
  });
  it('an entity that disappeared warns', () => {
    expect(codes(run(side(9, { distributions: [] }), prev()), 'warn')).toContain('distribution_entity_removed:test entity');
  });
});

describe('watch-list rows, transfers and cash', () => {
  it('a watch-list row that disappeared, was reused or changed confirmed group is a warning', () => {
    expect(codes(run({ ...side(8), lines: lines(8).filter((l) => !l.bva_detail) }, side(7)), 'warn')).toContain('detail_row_missing:9001');
    expect(codes(run(side(8, { line: { detail: { category: 'Other Row' } } }), side(7)), 'warn')).toContain('detail_code_reused:9001');
    expect(codes(run(side(8, { line: { detail: { budget_group: 'fixed' } } }), side(7)), 'warn')).toContain('detail_group_changed:9001');
  });
  it('an unconfirmed group is not a "change"', () => {
    expect(codes(run(side(8, { line: { detail: { budget_group: 'fixed', group_confirmed: false } } }), side(7)))).not.toContain('detail_group_changed:9001');
  });
  it('transfers and cash accounts that start or end only warn', () => {
    const f = run(side(8, { transfers: [{ source: 'Other', purpose: 'X' }], cash: [] }), side(7));
    expect(codes(f, 'warn')).toEqual(expect.arrayContaining(['transfers_ended', 'transfers_started', 'cash_accounts_changed']));
    expect(codes(f, 'block')).toEqual([]);
  });
});

describe('which version is "previous" (Phase 4 rules)', () => {
  const base = (id, month, extra = {}) => ({ id, label: `M${month}`, month, year: 2030, status: 'final', bva_import_status: 'final', published: true, ...extra });
  it('the current published version: never a superseded, discarded, awaiting-cleanup or open draft version', () => {
    const periods = [
      base('jul-orig', 7, { published: false, superseded: true, superseded_by: 'jul-r' }),
      base('jul-r', 7, { supersedes: 'jul-orig', revision_number: 2 }),
      base('jun', 6), base('jun-x', 6, { published: false, supersedes: 'jun', revision_status: 'discarded', status: 'draft' }),
      base('aug', 8),
    ];
    expect(alignedPrevious(periods, base('aug', 8)).period.id).toBe('jul-r');
    // a published revision whose original still awaits cleanup
    const pending = [base('jul-orig', 7), base('jul-r', 7, { supersedes: 'jul-orig', revision_number: 2 }), base('aug', 8)];
    expect(alignedPrevious(pending, base('aug', 8)).period.id).toBe('jul-r');
    // an open draft revision is never the baseline, but is reported
    const open = [base('jul', 7), base('jul-r', 7, { supersedes: 'jul', revision_number: 2, published: false, status: 'draft', bva_import_status: 'draft' })];
    const r = alignedPrevious(open, base('aug', 8));
    expect(r.period.id).toBe('jul');
    expect(r.openRevision).toBe(true);
  });
  it('a month with nothing published is skipped (a draft is never the baseline)', () => {
    const periods = [base('jun', 6), base('jul', 7, { published: false, status: 'draft', bva_import_status: 'draft' })];
    expect(alignedPrevious(periods, base('aug', 8)).period.id).toBe('jun');
  });
  it('competing published versions of the previous month block', () => {
    const periods = [base('jul-a', 7), base('jul-b', 7)];
    const prev = alignedPrevious(periods, base('aug', 8));
    expect(prev.conflict).toHaveLength(2);
    expect(run(side(8), null, { conflict: prev.conflict })).toEqual([expect.objectContaining({ code: 'previous_month_conflict', severity: 'block' })]);
  });
  it('a revision of a month is compared with the month before it, not with its own original', () => {
    const periods = [base('jun', 6), base('jul', 7), base('jul-r', 7, { supersedes: 'jul', revision_number: 2, published: false, status: 'draft' })];
    expect(alignedPrevious(periods, periods[2]).period.id).toBe('jun');
    expect(alignedNext(periods, base('jun', 6)).period.id).toBe('jul');
  });
});

describe('later months (a revision of an earlier month)', () => {
  it('warns when the published later month no longer follows -- never blocks', () => {
    const f = laterMonthChecks(side(7, { period: { ytd_income: 99999 } }), side(8));
    expect(f).toEqual([expect.objectContaining({ code: 'later_month_behind:ytd_income', severity: 'warn' })]);
    expect(laterMonthChecks(side(7), side(8))).toEqual([]);
  });
});

describe('enforcement in the publish gate', () => {
  const findings = [
    { code: 'ytd_income_decreased', severity: 'warn', message: 'm1' },
    { code: 'previous_month_conflict', severity: 'block', message: 'm2' },
    { code: 'month_gap', severity: 'warn', message: 'm3' },
    { code: 'new_year', severity: 'info', message: 'm4' },
  ];
  it('only block (a conflicting or duplicate period) blocks; no reason clears it; warn/info never block', () => {
    expect(crossPeriodBlockers(findings, {}).map((x) => [x.code, x.overridable])).toEqual([[`${CROSS_PERIOD_PREFIX}previous_month_conflict`, false]]);
    expect(crossPeriodBlockers(findings, { [`${CROSS_PERIOD_PREFIX}previous_month_conflict`]: { reason: 'try' } })).toHaveLength(1);
  });
  it('without findings (null) nothing changes -- existing callers unaffected', () => {
    expect(crossPeriodBlockers(null)).toEqual([]);
  });
  it('a decrease needs no reason at finalize or at publish', () => {
    const period = P(8, { status: 'draft', bva_import_status: 'draft', published: false, bva_parsed_source: {} });
    const warnOnly = findings.filter((f) => f.severity !== 'block');
    expect(recordedOverrides(period, lines(8), {}, 'admin@example.invalid', 't', warnOnly)).toEqual({});
    const finalP = { ...period, status: 'final', bva_import_status: 'final', finalized_at: 'x', checklist: Object.fromEntries(['categories_reviewed', 'classes_reviewed', 'refunds_reviewed', 'income_reviewed', 'cash_confirmed', 'distributions_confirmed', 'budget_report_reviewed'].map((k) => [k, true])) };
    expect(evaluatePublish(finalP, lines(8), warnOnly).blockers.map((b) => b.code)).toEqual([]);
  });
});

describe('cutoffIndex', () => {
  it('uses the cutoff date, else a legacy period\'s elapsed months', () => {
    expect(cutoffIndex({ reporting_cutoff_date: '2030-07-31' })).toBe(2030 * 12 + 6);
    expect(cutoffIndex({ year: 2030, months_elapsed: 7 })).toBe(2030 * 12 + 6);
    expect(cutoffIndex({ year: 2030 })).toBe(null);
  });
});

describe('import screen: the previous period could not be loaded', () => {
  it('blocks finalizing (cannot be overridden) instead of silently skipping the checks', async () => {
    const { validateBva } = await import('./bvaValidation.js');
    const { cleanParsed, SAMPLE_CUTOFF } = await import('./__fixtures__/bvaSample.js');
    const w = validateBva(cleanParsed(), { cutoffDate: SAMPLE_CUTOFF, previousUnavailable: true, overrides: { previous_period_unavailable: { reason: 'skip it' } } })
      .warnings.find((x) => x.code === 'previous_period_unavailable');
    expect(w).toMatchObject({ blocksFinalize: true, overridable: false });
    expect(validateBva(cleanParsed(), { cutoffDate: SAMPLE_CUTOFF }).warnings.some((x) => x.code === 'previous_period_unavailable')).toBe(false);
  });
});
