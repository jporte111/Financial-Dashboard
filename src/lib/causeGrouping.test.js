// Grouped review (item 6 of the October cleanup): findings are read once per root
// cause, one written reason may cover every overridable member of a cause, and
// grouping changes no rule -- a hard blocker is never accepted through its group.
// Fictional data only.
import { describe, it, expect } from 'vitest';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { evaluateFinalize } from '../../base44/shared/publishGate.ts';
import { buildReview, groupByCause, causeOf, CATALOGUE } from '../../base44/shared/checklistCore.ts';

function staged(extra = {}) {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'variable']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const period = { id: 'p1', label: 'July 2026', ...plan.periodData, status: 'draft', published: false, bva_import_status: 'draft', ...extra };
  const lines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i + 1}`, period_id: 'p1', ...l }));
  return { period, lines };
}
const f = (severity, code) => ({ severity, code, message: `Fictional finding ${code}.` });

// An October-like month: three month-vs-year-to-date mismatches (one upstream
// cause), watch-list rows that differ, a revised budget, and a closed quarter
// left blank (a hard blocker, grouped with the workbook gaps).
const OCTOBER_LIKE = [
  f('override', 'month_vs_ytd:income'), f('override', 'month_vs_ytd:expenses'), f('override', 'month_vs_ytd:variable'),
  f('override', 'detail_group_changed:6001'), f('override', 'detail_group_changed:6002'), f('warn', 'detail_row_missing:6003'),
  f('override', 'annual_budget_changed'), f('override', 'group_budget_changed:variable'),
  f('block', 'closed_quarter_missing:alpha:q2'),
  f('warn', 'transfers_ended'),
  f('info', 'new_year'),
];
const review = (period, lines, findings, overrides = {}) => buildReview({
  period, blockers: evaluateFinalize(period, lines, overrides, findings).blockers, crossFindings: findings, crossRan: true, items: [], previousLabel: 'June 2026',
});
const byKey = (r) => Object.fromEntries(r.causes.map((c) => [c.key, c]));

describe('findings grouped by root cause', () => {
  const { period, lines } = staged();
  const r = review(period, lines, OCTOBER_LIKE);
  const c = byKey(r);

  it('every finding appears in exactly one cause', () => {
    const flat = [...r.blockers, ...r.needsReview.filter((e) => e.kind === 'reason'), ...r.warnings, ...r.notes].map((e) => e.code).sort();
    expect(r.causes.flatMap((x) => x.members.map((m) => m.code)).sort()).toEqual(flat);
  });

  it('several month-vs-year-to-date mismatches are shown once, as the previous month looking incomplete', () => {
    expect(c.month_vs_ytd).toBeUndefined();
    const up = c.previous_month_incomplete;
    expect(up.members).toHaveLength(3);
    expect(up.title).toBe("June 2026's published figures look incomplete");
    expect(up.explanation).toMatch(/income, expenses, Variable/);
    expect(up.acceptable).toHaveLength(3);
  });

  it('a single month-vs-year-to-date mismatch stays a finding of its own', () => {
    const one = byKey(review(period, lines, [f('override', 'month_vs_ytd:income')]));
    expect(one.month_vs_ytd.members).toHaveLength(1);
    expect(one.previous_month_incomplete).toBeUndefined();
  });

  it('watch-list differences and the budget revision are one cause each', () => {
    expect(c.watch_list.members.map((m) => m.code)).toEqual(expect.arrayContaining(['cross_period:detail_group_changed:6001', 'cross_period:detail_group_changed:6002', 'detail_row_missing:6003']));
    expect(c.watch_list.acceptable).toEqual(['cross_period:detail_group_changed:6001', 'cross_period:detail_group_changed:6002']);
    expect(c.budget_revision.members).toHaveLength(2);
  });

  it('workbook gaps are one bookkeeper action; the hard blocker in it stays hard', () => {
    const gaps = c.workbook_gaps;
    expect(gaps.action).toMatch(/bookkeeper/);
    expect(gaps.action).toMatch(/never read as \$0\.00/);
    expect(gaps.bucket).toBe('blockers');
    expect(gaps.counts.blockers).toBe(1);
    expect(gaps.acceptable).not.toContain('cross_period:closed_quarter_missing:alpha:q2');
  });

  it('causes with a hard blocker come first', () => {
    expect(r.causes[0].bucket).toBe('blockers');
    const order = r.causes.map((x) => ['blockers', 'needsReview', 'warnings', 'notes'].indexOf(x.bucket));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('one reason for a group is exactly the same as a reason for each member', () => {
  const { period, lines } = staged();
  const reason = { reason: 'Fictional: confirmed with the bookkeeper.', by: 'admin@example.invalid', at: '2026-08-05' };
  const r = review(period, lines, OCTOBER_LIKE);
  const all = r.causes.flatMap((c) => c.acceptable);
  const groupOverrides = Object.fromEntries(all.map((code) => [code, reason]));

  it('accepting every group clears every overridable finding and nothing else', () => {
    const after = evaluateFinalize(period, lines, groupOverrides, OCTOBER_LIKE).blockers;
    expect(after.every((b) => b.overridable === false)).toBe(true);
    expect(after.map((b) => b.code)).toContain('cross_period:closed_quarter_missing:alpha:q2');
  });

  it('the same reasons given one by one produce the identical result', () => {
    const one = {};
    for (const code of all) one[code] = { ...reason };
    expect(evaluateFinalize(period, lines, one, OCTOBER_LIKE)).toEqual(evaluateFinalize(period, lines, groupOverrides, OCTOBER_LIKE));
  });

  it('a reason recorded against a hard blocker changes nothing', () => {
    const hard = 'cross_period:closed_quarter_missing:alpha:q2';
    const before = evaluateFinalize(period, lines, groupOverrides, OCTOBER_LIKE);
    const forced = evaluateFinalize(period, lines, { ...groupOverrides, [hard]: reason }, OCTOBER_LIKE);
    expect(forced).toEqual(before);
    expect(forced.ok).toBe(false);
  });

  it('a missing required total accepted through its group defers finalize only; it is never zero', () => {
    const { period: p, lines: l } = staged({ total_cash: undefined, source_missing_fields: ['total_cash'] });
    const rr = review(p, l, []);
    const gaps = byKey(rr).workbook_gaps;
    expect(gaps.acceptable).toContain('required_value_missing:total_cash');
    const ok = evaluateFinalize(p, l, Object.fromEntries(gaps.acceptable.map((code) => [code, reason])), []);
    expect(ok.blockers.map((b) => b.code)).not.toContain('required_value_missing:total_cash');
  });
});

describe('every catalogued code belongs to a cause', () => {
  it('none falls through to the catch-all except the state and import-structure codes', () => {
    const loose = Object.keys(CATALOGUE).filter((k) => causeOf(k).startsWith('other:'));
    // These are refusals or structural import findings that are their own cause.
    expect(loose.every((k) => !/^(month_vs_ytd|detail_|transfers_|closed_quarter|distribution|required_|source_value|annual_budget|group_budget)/.test(k))).toBe(true);
  });
  it('grouping an empty list yields no causes', () => {
    expect(groupByCause([])).toEqual([]);
  });
});
