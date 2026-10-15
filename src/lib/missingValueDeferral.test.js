// Missing figures: the dashboard shows what the workbook contains. A blank stays
// missing -- never $0.00 -- and is highlighted as a warning; it does not block
// finalize or publish and needs no written reason. Only a missing reporting
// cutoff blocks (the report cannot be placed in a month). Fictional data only.
import { describe, it, expect } from 'vitest';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { evaluateFinalize, evaluatePublish, dataWarnings, REQUIRED_PERIOD_FIELDS } from '../../base44/shared/publishGate.ts';
import { checklistStatus, partHashes, confirmationRecord, CHECKLIST_KEYS, buildReview } from '../../base44/shared/checklistCore.ts';
import { publicPeriod } from '../../base44/shared/publicDashboardCore.ts';

function staged() {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'variable']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const period = { id: 'p1', label: 'July 2026', ...plan.periodData, status: 'draft', published: false, bva_import_status: 'draft' };
  const lines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i + 1}`, period_id: 'p1', ...l }));
  return { period, lines };
}
const codes = (r) => r.blockers.map((b) => b.code);
// A fully confirmed checklist, so publish is judged on the data alone.
const confirmed = (period, lines) => checklistStatus({ confirmations: Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, confirmationRecord(k, partHashes({ period, lines }), [], 'a', 't')])), hashes: partHashes({ period, lines }), openBlockers: [], warnings: [] });
const finalized = (p) => ({ ...p, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-05T10:00:00Z' });

describe('a missing total (e.g. Total Cash)', () => {
  const { period: base, lines } = staged();
  const period = { ...base, total_cash: undefined, source_missing_fields: ['total_cash'] };

  it('finalizes and publishes with no written reason', () => {
    expect(evaluateFinalize(period, lines).ok).toBe(true);
    expect(evaluatePublish(finalized(period), lines, null, confirmed(period, lines))).toEqual({ ok: true, blockers: [] });
  });

  it('is highlighted in the review as a workbook gap', () => {
    const r = buildReview({ period, blockers: [], crossFindings: [], crossRan: true, items: [], dataWarnings: dataWarnings(period, lines) });
    expect(r.warnings.map((w) => w.code)).toContain('required_value_missing:total_cash');
    expect(r.causes.find((c) => c.key === 'workbook_gaps').bucket).toBe('warnings');
  });

  it('reaches the client as missing, never $0.00 -- even with a stored 0 listed as missing', () => {
    expect(publicPeriod(finalized(period)).total_cash ?? null).toBe(null);
    expect(publicPeriod(finalized({ ...base, total_cash: 0, source_missing_fields: ['total_cash'] })).total_cash ?? null).toBe(null);
  });

  it('an explicit 0 that is NOT listed as missing is a real value', () => {
    const realZero = { ...base, total_cash: 0 };
    expect(dataWarnings(realZero, lines).map((w) => w.code)).not.toContain('required_value_missing:total_cash');
    expect(publicPeriod(finalized(realZero)).total_cash).toBe(0);
  });

  it('every total behaves the same; only the cutoff blocks', () => {
    for (const f of REQUIRED_PERIOD_FIELDS) {
      const p = { ...base, [f]: undefined, source_missing_fields: [f] };
      if (f === 'reporting_cutoff_date') {
        expect(codes(evaluateFinalize(p, lines)), f).toContain(`required_value_missing:${f}`);
      } else {
        expect(evaluateFinalize(p, lines).ok, f).toBe(true);
        expect(evaluatePublish(finalized(p), lines, null, confirmed(p, lines)).ok, f).toBe(true);
      }
    }
  });
});

describe('a missing summary-line figure', () => {
  it('finalizes and publishes; highlighted', () => {
    const { period, lines: base } = staged();
    const lines = base.map((l) => (!l.bva_detail && l.budget_group === 'variable' ? (({ ytd_actual, ...rest }) => rest)(l) : l));
    const line = lines.find((l) => !l.bva_detail && l.budget_group === 'variable');
    expect(evaluateFinalize(period, lines).ok).toBe(true);
    expect(evaluatePublish(finalized(period), lines, null, confirmed(period, lines)).ok).toBe(true);
    expect(dataWarnings(period, lines).map((w) => w.code)).toContain(`required_line_value_missing:${line.id}:ytd_actual`);
  });
});

describe('a blank in the workbook', () => {
  it('is a warning from the import check (never blocks, needs no reason)', () => {
    const parsed = cleanParsed();
    parsed.cash.accounts[0].balance = null;
    parsed.cash.reportedTotal = null;
    const w = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF }).warnings.find((x) => x.code === 'source_value_missing:cash');
    expect(w).toMatchObject({ blocksFinalize: false });
    expect(w.message).toMatch(/never \$0\.00/);
  });
  it('a stored missing-source-value warning does not block publish', () => {
    const { period: base, lines } = staged();
    const w = { code: 'source_value_missing:cash', message: 'Cash: Test Checking has a blank balance.', blocksFinalize: true, overridable: true };
    const period = { ...base, bva_validation_warnings: [...(base.bva_validation_warnings || []), w] };
    expect(evaluatePublish(finalized(period), lines, null, confirmed(period, lines)).ok).toBe(true);
  });
});
