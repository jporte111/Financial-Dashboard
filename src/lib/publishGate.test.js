// The authoritative finalize / publish rules (base44/shared/publishGate.ts).
// Periods are built from the fictional BVA fixtures through the real import
// plan, so the rules are exercised on realistic records. All data is fictional.
import { describe, it, expect } from 'vitest';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { workbookLikeParsed, cleanParsed, distributionsGapOnlyParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import {
  evaluateFinalize,
  evaluatePublish,
  recordedOverrides,
  isMaterialUnassignedDetail,
  PUBLISH_CHECKLIST,
  REQUIRED_PERIOD_FIELDS,
  dataWarnings,
} from '../../base44/shared/publishGate.ts';

// A draft period as it exists right after a BVA import (state fields come from
// schema defaults), with ids on its lines. Detail groups are confirmed unless
// `unassigned` is set.
function staged(parsedFactory = cleanParsed, { unassigned = false } = {}) {
  const parsed = parsedFactory();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = unassigned
    ? {}
    : Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'variable']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const period = { id: 'p1', label: 'July 2026', ...plan.periodData, status: 'draft', published: false, bva_import_status: 'draft' };
  const lines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i + 1}`, period_id: 'p1', ...l }));
  return { period, lines, validation };
}

const codes = (r) => r.blockers.map((b) => b.code);
const fullChecklist = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));
const finalized = (p, extra = {}) => ({ ...p, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-05T10:00:00Z', ...extra });

describe('finalize: a clean, fully classified import passes', () => {
  it('clean workbook', () => {
    const { period, lines } = staged(cleanParsed);
    expect(evaluateFinalize(period, lines)).toEqual({ ok: true, blockers: [] });
  });

  it('distributions-total correction alone does not block', () => {
    const { period, lines } = staged(distributionsGapOnlyParsed);
    expect(evaluateFinalize(period, lines).ok).toBe(true);
  });
});

describe('finalize: workbook discrepancies are warnings, not blockers', () => {
  const { period, lines } = staged(workbookLikeParsed);
  it('a cash total that does not add up does not block and needs no reason', () => {
    expect(codes(evaluateFinalize(period, lines))).not.toContain('open_reconciliation:cash_total_mismatch');
    expect(dataWarnings(period, lines).map((w) => w.code)).not.toContain('open_reconciliation:cash_total_mismatch');
  });
  it('an import stored under the earlier rules (blocksFinalize true) is judged by these rules', () => {
    const old = { ...period, bva_validation_warnings: [{ code: 'cash_total_mismatch', blocksFinalize: true, overridable: true, message: 'm' }] };
    expect(evaluateFinalize(old, lines).ok).toBe(true);
  });
  it('a structural finding stored with the import still blocks, and no reason clears it', () => {
    const bad = { ...period, bva_validation_warnings: [{ code: 'duplicate_section_conflict:cash', blocksFinalize: true, overridable: false, message: 'two cash blocks differ' }] };
    const r = evaluateFinalize(bad, lines, { 'open_reconciliation:duplicate_section_conflict:cash': { reason: 'try' } });
    expect(r.blockers.find((x) => x.code === 'open_reconciliation:duplicate_section_conflict:cash')).toMatchObject({ overridable: false });
  });
});

describe('finalize: missing values are shown as missing and highlighted, never blocking', () => {
  it.each(REQUIRED_PERIOD_FIELDS.filter((f) => f !== 'reporting_cutoff_date'))('missing %s does not block; it is a warning', (f) => {
    const { period, lines } = staged();
    for (const blank of [null, undefined, '']) {
      const p = { ...period, [f]: blank };
      expect(evaluateFinalize(p, lines).ok).toBe(true);
      expect(dataWarnings(p, lines).map((w) => w.code)).toContain(`required_value_missing:${f}`);
    }
  });

  it('a value listed as missing is missing even if a 0 is stored (never $0.00)', () => {
    const { period, lines } = staged();
    const p = { ...period, total_cash: 0, source_missing_fields: ['total_cash'] };
    expect(dataWarnings(p, lines).map((w) => w.code)).toContain('required_value_missing:total_cash');
  });

  it('a missing cutoff date blocks: the report cannot be placed in a month', () => {
    const { period, lines } = staged();
    const code = 'required_value_missing:reporting_cutoff_date';
    const r = evaluateFinalize({ ...period, reporting_cutoff_date: '' }, lines, { [code]: { reason: 'please' } });
    expect(codes(r)).toContain(code);
    expect(r.blockers.find((b) => b.code === code).overridable).toBe(false);
  });

  it('a real zero is a value, not missing', () => {
    const { period, lines } = staged();
    const p = { ...period, distributions_ytd: 0, total_cash: 0 };
    expect(evaluateFinalize(p, lines).ok).toBe(true);
    expect(dataWarnings(p, lines)).toEqual([]);
  });

  it('optional month totals may stay blank without blocking', () => {
    const { period, lines } = staged();
    expect(evaluateFinalize({ ...period, month_income: null, month_expenses: null }, lines).ok).toBe(true);
  });

  it('a summary line with a missing YTD or budget is a warning', () => {
    const { period, lines } = staged();
    const bad = lines.map((l) => (l.budget_group === 'fixed' && !l.bva_detail ? { ...l, ytd_actual: null } : l));
    expect(evaluateFinalize(period, bad).ok).toBe(true);
    expect(dataWarnings(period, bad).some((w) => w.code.startsWith('required_line_value_missing:') && w.code.endsWith(':ytd_actual'))).toBe(true);
  });

  it('an incomplete import (missing expense group or income) blocks', () => {
    const { period, lines } = staged();
    expect(codes(evaluateFinalize(period, lines.filter((l) => l.budget_group !== 'discretionary')))).toContain('import_incomplete');
    expect(codes(evaluateFinalize(period, lines.filter((l) => l.budget_group !== 'income')))).toContain('import_incomplete');
  });
});

describe('finalize: pace must come from the confirmed cutoff', () => {
  it('months_elapsed inconsistent with the cutoff blocks', () => {
    const { period, lines } = staged();
    expect(codes(evaluateFinalize({ ...period, months_elapsed: 1 }, lines))).toContain('pace_inconsistent');
  });
  it('an unparseable cutoff blocks', () => {
    const { period, lines } = staged();
    expect(codes(evaluateFinalize({ ...period, reporting_cutoff_date: 'not-a-date' }, lines))).toContain('cutoff_invalid');
  });
});

describe('finalize: unassigned DETAIL rows that affect reporting', () => {
  it('material unassigned rows are shown as Unassigned and highlighted, not blocking', () => {
    const { period, lines } = staged(cleanParsed, { unassigned: true });
    const material = lines.filter(isMaterialUnassignedDetail);
    expect(material.length).toBeGreaterThan(0);
    expect(evaluateFinalize(period, lines).ok).toBe(true);
    const w = dataWarnings(period, lines).map((x) => x.code);
    for (const l of material) expect(w).toContain(`detail_unassigned:${l.id}`);
  });

  it('an unassigned row with no figures (blank or zero) does not block', () => {
    const { period, lines } = staged(cleanParsed);
    const extra = [
      { id: 'x1', bva_detail: true, budget_group: 'unassigned', group_confirmed: false, ytd_actual: 0, annual_budget: 0, month_actual: null, category: 'Idle' },
      { id: 'x2', bva_detail: true, budget_group: 'unassigned', group_confirmed: false, ytd_actual: null, annual_budget: null, month_actual: null, category: 'Blank' },
    ];
    expect(evaluateFinalize(period, [...lines, ...extra]).ok).toBe(true);
  });
});

describe('finalize: state preconditions', () => {
  const { period, lines } = staged();
  it('refuses a published period', () => {
    expect(codes(evaluateFinalize({ ...period, published: true }, lines))).toContain('published_read_only');
  });
  it('refuses an already-final period', () => {
    expect(codes(evaluateFinalize(finalized(period), lines))).toContain('already_final');
  });
  it('refuses a period without a validated BVA import (legacy or manual)', () => {
    expect(codes(evaluateFinalize({ ...period, bva_import_status: undefined }, lines))).toContain('no_validated_import');
    expect(codes(evaluateFinalize({ ...period, bva_parsed_source: undefined }, lines))).toContain('no_validated_import');
  });
  it('a missing period is refused', () => {
    expect(codes(evaluateFinalize(null, []))).toEqual(['period_not_found']);
  });
});

describe('publish: only a finalized, still-valid, reviewed period', () => {
  const { period, lines } = staged(workbookLikeParsed);
  const overrides = { 'open_reconciliation:cash_total_mismatch': { reason: 'confirmed', by: 'a', at: 't' } };
  const allRecon = Object.fromEntries(
    (period.bva_validation_warnings || []).filter((w) => w.blocksFinalize).map((w) => [`open_reconciliation:${w.code}`, { reason: 'confirmed', by: 'a', at: 't' }])
  );
  const exclusions = Object.fromEntries(lines.filter(isMaterialUnassignedDetail).map((l) => [`detail_unassigned:${l.id}`, { reason: 'x' }]));

  it('a draft cannot be published', () => {
    expect(codes(evaluatePublish({ ...period, checklist: fullChecklist }, lines))).toContain('not_final');
  });

  it('status "final" set without finalization metadata is not enough', () => {
    expect(codes(evaluatePublish({ ...period, status: 'final', checklist: fullChecklist }, lines))).toContain('not_final');
  });

  it('every checklist item must be confirmed', () => {
    const r = evaluatePublish(finalized(period, { bva_overrides: { ...allRecon, ...exclusions } }), lines);
    expect(codes(r).filter((c) => c.startsWith('checklist_incomplete:'))).toHaveLength(PUBLISH_CHECKLIST.length);
  });

  it('passes with finalization, recorded overrides and a complete checklist', () => {
    const p = finalized(period, { bva_overrides: { ...allRecon, ...exclusions, ...overrides }, checklist: fullChecklist });
    expect(evaluatePublish(p, lines)).toEqual({ ok: true, blockers: [] });
  });

  it('re-checks the data at publish time: a missing total publishes (shown as missing); a lost cutoff blocks', () => {
    const p = finalized(period, { checklist: fullChecklist, total_cash: null });
    expect(evaluatePublish(p, lines).ok).toBe(true);
    expect(codes(evaluatePublish({ ...p, reporting_cutoff_date: '' }, lines))).toContain('required_value_missing:reporting_cutoff_date');
  });
  it('publishes with no written reasons at all', () => {
    expect(evaluatePublish(finalized(period, { checklist: fullChecklist }), lines)).toEqual({ ok: true, blockers: [] });
  });

  it('an already-published period is not re-published', () => {
    expect(codes(evaluatePublish({ ...finalized(period), published: true }, lines))).toContain('already_published');
  });
});

describe('existing published records are never re-judged', () => {
  // Only transitions evaluate the rules. A legacy published period (no BVA
  // import metadata) simply stays published; the rules just explain what a
  // re-publication after reopening would require.
  it('a legacy published period reports why it could not be finalized/published again', () => {
    const legacy = { id: 'old', label: 'March 2026', status: 'final', published: true, month: 3, year: 2026 };
    expect(codes(evaluateFinalize(legacy, []))).toContain('published_read_only');
    expect(codes(evaluatePublish(legacy, []))).toEqual(expect.arrayContaining(['already_published', 'not_final']));
  });
});

describe('recordedOverrides', () => {
  const { period, lines } = staged(workbookLikeParsed);
  it('records nothing new (no finding needs a reason); reasons recorded earlier are kept', () => {
    expect(recordedOverrides(period, lines, { 'open_reconciliation:cash_total_mismatch': { reason: 'x' } }, 'a', 't')).toEqual({});
    const earlier = { 'open_reconciliation:cash_total_mismatch': { reason: 'kept', by: 'a', at: 't' } };
    expect(recordedOverrides({ ...period, bva_overrides: earlier }, lines, {}, 'b', 'u')).toEqual(earlier);
  });
});

describe('state initialization and cleared values', () => {
  it('a period without server-initialized state can never be finalized or published', () => {
    const { period, lines } = staged();
    for (const k of ['status', 'published']) {
      const p = { ...period };
      delete p[k];
      expect(evaluateFinalize(p, lines).blockers.map((b) => b.code)).toEqual(['state_uninitialized']);
      expect(evaluatePublish(p, lines).blockers.map((b) => b.code)).toEqual(['state_uninitialized']);
    }
  });

  it("finalized_at cleared to '' means not finalized", () => {
    const { period, lines } = staged();
    const p = { ...period, status: 'final', bva_import_status: 'final', finalized_at: '', checklist: fullChecklist };
    expect(evaluatePublish(p, lines).blockers.map((b) => b.code)).toContain('not_final');
  });
});