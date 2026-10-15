// Missing figures (item 1 of the October cleanup): a written reason may let a
// period be FINALIZED with a figure still blank ("leave blank for now, correct
// later"), but nothing missing may be PUBLISHED, and a missing figure is never
// read as $0.00. Fictional data only.
import { describe, it, expect } from 'vitest';
import { planBvaImport } from './bvaImport.js';
import { validateBva } from './bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from './__fixtures__/bvaSample.js';
import { evaluateFinalize, evaluatePublish, recordedOverrides, REQUIRED_PERIOD_FIELDS } from '../../base44/shared/publishGate.ts';
import { checklistStatus, partHashes, confirmationRecord, CHECKLIST_KEYS } from '../../base44/shared/checklistCore.ts';

function staged() {
  const parsed = cleanParsed();
  const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'variable']));
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year: 2026, cutoffDate: SAMPLE_CUTOFF }, groupMap });
  const period = { id: 'p1', label: 'July 2026', ...plan.periodData, status: 'draft', published: false, bva_import_status: 'draft' };
  const lines = plan.budgetLines.toCreate.map((l, i) => ({ id: `l${i + 1}`, period_id: 'p1', ...l }));
  return { period, lines };
}
const reason = { reason: 'Bookkeeper will send the missing balance; leaving blank for now.' };
const codes = (r) => r.blockers.map((b) => b.code);
// A fully confirmed checklist, so publish is judged on the data alone.
const confirmed = (period, lines) => checklistStatus({ confirmations: Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, confirmationRecord(k, partHashes({ period, lines }), [], 'a', 't')])), hashes: partHashes({ period, lines }), openBlockers: [], warnings: [] });
const finalized = (p, overrides) => ({ ...p, status: 'final', bva_import_status: 'final', finalized_at: '2026-08-05T10:00:00Z', bva_overrides: overrides });

describe('a missing required total (e.g. Total Cash)', () => {
  const { period: base, lines } = staged();
  const period = { ...base, total_cash: undefined, source_missing_fields: ['total_cash'] };

  it('blocks finalize until a written reason defers it', () => {
    expect(codes(evaluateFinalize(period, lines))).toContain('required_value_missing:total_cash');
    expect(codes(evaluateFinalize(period, lines, { 'required_value_missing:total_cash': reason }))).not.toContain('required_value_missing:total_cash');
  });

  it('can NEVER be published, even after the deferral was recorded at finalize', () => {
    const rec = recordedOverrides(period, lines, { 'required_value_missing:total_cash': reason }, 'admin', '2026-08-05');
    expect(rec['required_value_missing:total_cash']).toBeTruthy();
    const pub = evaluatePublish(finalized(period, rec), lines, null, confirmed(period, lines));
    const b = pub.blockers.find((x) => x.code === 'required_value_missing:total_cash');
    expect(b).toBeTruthy();
    expect(b.overridable).toBe(false);
    expect(b.message).toMatch(/cannot be published/);
  });

  it('a stored 0 listed as missing is still missing (never $0.00)', () => {
    const zeroButMissing = { ...base, total_cash: 0, source_missing_fields: ['total_cash'] };
    expect(codes(evaluatePublish(finalized(zeroButMissing, {}), lines, null, confirmed(zeroButMissing, lines)))).toContain('required_value_missing:total_cash');
  });

  it('an explicit 0 that is NOT listed as missing is a real value and publishes', () => {
    const realZero = { ...base, total_cash: 0 };
    expect(codes(evaluatePublish(finalized(realZero, {}), lines, null, confirmed(realZero, lines)))).not.toContain('required_value_missing:total_cash');
  });

  it('every required total behaves the same; the cutoff can never be deferred', () => {
    for (const f of REQUIRED_PERIOD_FIELDS) {
      const p = { ...base, [f]: undefined, source_missing_fields: [f] };
      const fin = evaluateFinalize(p, lines, { [`required_value_missing:${f}`]: reason });
      if (f === 'reporting_cutoff_date') expect(codes(fin), f).toContain(`required_value_missing:${f}`);
      else expect(codes(fin), f).not.toContain(`required_value_missing:${f}`);
      const pub = evaluatePublish(finalized(p, recordedOverrides(p, lines, { [`required_value_missing:${f}`]: reason }, 'a', 't')), lines, null, confirmed(p, lines));
      expect(pub.blockers.find((x) => x.code === `required_value_missing:${f}`)?.overridable, f).toBe(false);
    }
  });
});

describe('a missing summary-line figure', () => {
  it('may be deferred at finalize, never published', () => {
    const { period, lines: base } = staged();
    const lines = base.map((l) => (!l.bva_detail && l.budget_group === 'variable' ? (({ ytd_actual, ...rest }) => rest)(l) : l));
    const line = lines.find((l) => !l.bva_detail && l.budget_group === 'variable');
    const code = `required_line_value_missing:${line.id}:ytd_actual`;
    expect(codes(evaluateFinalize(period, lines))).toContain(code);
    expect(codes(evaluateFinalize(period, lines, { [code]: reason }))).not.toContain(code);
    const rec = recordedOverrides(period, lines, { [code]: reason }, 'a', 't');
    const pub = evaluatePublish(finalized(period, rec), lines, null, confirmed(period, lines));
    expect(pub.blockers.find((x) => x.code === code)?.overridable).toBe(false);
  });
});

describe('a deferred missing-source-value warning', () => {
  it('still blocks publish after it was accepted at finalize (marked overridden)', () => {
    const { period: base, lines } = staged();
    const w = { code: 'source_value_missing:cash', message: 'Cash: Test Checking has a blank balance.', blocksFinalize: false, overridden: true, overridable: true };
    const period = { ...base, bva_validation_warnings: [...(base.bva_validation_warnings || []), w] };
    const pub = evaluatePublish(finalized(period, { 'open_reconciliation:source_value_missing:cash': { reason: 'later', by: 'a', at: 't' } }), lines, null, confirmed(period, lines));
    const b = pub.blockers.find((x) => x.code === 'open_reconciliation:source_value_missing:cash');
    expect(b?.overridable).toBe(false);
  });
});
