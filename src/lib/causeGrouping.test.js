// Grouped review: findings are read once per root cause. The dashboard shows
// what the workbook contains, so missing and unusual values are WARNINGS (no
// written reason, never blocking); only structural problems block. Fictional
// data only.
import { describe, it, expect } from 'vitest';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { evaluateFinalize, dataWarnings } from '../../base44/shared/publishGate.ts';
import { buildReview, groupByCause, causeOf, CATALOGUE } from '../../base44/shared/checklistCore.ts';
import { HARD_VALIDATION_FAMILIES } from '../../base44/shared/hardRules.ts';

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
// cause), watch-list rows that differ, a revised budget, a closed quarter left
// blank, a blank Total Cash.
const OCTOBER_LIKE = [
  f('warn', 'month_vs_ytd:income'), f('warn', 'month_vs_ytd:expenses'), f('warn', 'month_vs_ytd:variable'),
  f('warn', 'detail_group_changed:6001'), f('warn', 'detail_group_changed:6002'), f('warn', 'detail_row_missing:6003'),
  f('warn', 'annual_budget_changed'), f('warn', 'group_budget_changed:variable'),
  f('warn', 'closed_quarter_missing:alpha:q2'),
  f('warn', 'transfers_ended'),
  f('info', 'new_year'),
];
const review = (period, lines, findings) => buildReview({
  period, blockers: evaluateFinalize(period, lines, {}, findings).blockers, crossFindings: findings, crossRan: true, items: [], previousLabel: 'June 2026', dataWarnings: dataWarnings(period, lines),
});
const byKey = (r) => Object.fromEntries(r.causes.map((c) => [c.key, c]));

describe('an October-like month', () => {
  const { period, lines } = staged({ total_cash: undefined, source_missing_fields: ['total_cash'] });
  const r = review(period, lines, OCTOBER_LIKE);
  const c = byKey(r);

  it('finalizes with no written reason; nothing blocks', () => {
    expect(evaluateFinalize(period, lines, {}, OCTOBER_LIKE)).toEqual({ ok: true, blockers: [] });
    expect(r.blockers).toEqual([]);
    expect(r.causes.every((x) => x.bucket === 'warnings' || x.bucket === 'notes')).toBe(true);
    expect(r.causes.every((x) => x.acceptable.length === 0)).toBe(true);
  });

  it('every finding appears in exactly one cause', () => {
    const flat = [...r.blockers, ...r.warnings, ...r.notes].map((e) => e.code).sort();
    expect(r.causes.flatMap((x) => x.members.map((m) => m.code)).sort()).toEqual(flat);
  });

  it('several month-vs-year-to-date mismatches are shown once, as the previous month looking incomplete', () => {
    expect(c.month_vs_ytd).toBeUndefined();
    const up = c.previous_month_incomplete;
    expect(up.members).toHaveLength(3);
    expect(up.title).toBe("June 2026's published figures look incomplete");
    expect(up.explanation).toMatch(/income, expenses, Variable/);
    expect(up.action).toMatch(/nothing is required to publish/);
  });

  it('a single month-vs-year-to-date mismatch stays a finding of its own', () => {
    const one = byKey(review(period, lines, [f('warn', 'month_vs_ytd:income')]));
    expect(one.month_vs_ytd.members).toHaveLength(1);
    expect(one.previous_month_incomplete).toBeUndefined();
  });

  it('watch-list differences and the budget revision are one cause each', () => {
    expect(c.watch_list.members.map((m) => m.code)).toEqual(expect.arrayContaining(['detail_group_changed:6001', 'detail_group_changed:6002', 'detail_row_missing:6003']));
    expect(c.budget_revision.members).toHaveLength(2);
  });

  it('workbook gaps (blank Total Cash, blank closed quarter) are one bookkeeper list; never $0.00; not blocking', () => {
    const gaps = c.workbook_gaps;
    expect(gaps.members.map((m) => m.code)).toEqual(expect.arrayContaining(['required_value_missing:total_cash', 'closed_quarter_missing:alpha:q2']));
    expect(gaps.bucket).toBe('warnings');
    expect(gaps.action).toMatch(/bookkeeper/);
    expect(gaps.action).toMatch(/never \$0\.00/);
  });
});

describe('structural problems still block, and group first', () => {
  it('a conflicting previous month and a duplicate section are blockers; no reason clears them', () => {
    const { period: base, lines } = staged();
    const period = { ...base, bva_validation_warnings: [{ code: 'duplicate_section_conflict:cash', blocksFinalize: true, overridable: false, message: 'Two cash blocks differ.' }] };
    const findings = [f('block', 'previous_month_conflict'), f('warn', 'ytd_income_decreased')];
    const fin = evaluateFinalize(period, lines, { 'cross_period:previous_month_conflict': { reason: 'x' } }, findings);
    expect(fin.blockers.map((b) => b.code).sort()).toEqual(['cross_period:previous_month_conflict', 'open_reconciliation:duplicate_section_conflict:cash']);
    const r = review(period, lines, findings);
    expect(r.causes[0].bucket).toBe('blockers');
    expect(r.causes.filter((x) => x.bucket === 'blockers').flatMap((x) => x.members.map((m) => m.code)).sort()).toEqual(['cross_period:previous_month_conflict', 'open_reconciliation:duplicate_section_conflict:cash']);
  });
});

describe('every catalogued code belongs to a cause', () => {
  it('none of the financial findings falls through to the catch-all', () => {
    const loose = Object.keys(CATALOGUE).filter((k) => causeOf(k).startsWith('other:'));
    expect(loose.every((k) => !/^(month_vs_ytd|detail_|transfers_|closed_quarter|distribution|required_|source_value|annual_budget|group_budget)/.test(k))).toBe(true);
  });
  it('every structural family has plain language', () => {
    for (const k of HARD_VALIDATION_FAMILIES) expect(CATALOGUE[k], k).toBeTruthy();
  });
  it('grouping an empty list yields no causes', () => {
    expect(groupByCause([])).toEqual([]);
  });
});
