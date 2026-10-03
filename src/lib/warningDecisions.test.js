// @vitest-environment jsdom
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/api/base44Client', () => ({ base44: {} }));
vi.mock('./periodTransition', () => ({ periodTransition: (...a) => a }));
vi.mock('./bvaDashboard.js', () => ({ parseBlankQuarters: () => [] }));
import { decisionOptions, MIN_REASON } from './warningDecisions';

const blank = (msg) => ({
  code: 'distribution_quarter_blank',
  resolution: 'unresolved',
  blocksFinalize: false,
  message: msg,
});

describe('warningDecisions', () => {
  it('offers confirm / enter-amounts for a blank distribution quarter warning', () => {
    const w = blank('Blank distribution cells for quarters that have begun: Sample Bank Q1, Sample Bank Q2. They add nothing to Distributions YTD; confirm none was received.');
    expect(decisionOptions(w).map((o) => o.mode)).toEqual(['confirm_zero', 'enter_amounts']);
  });

  it('requires a written reason of at least ten characters', () => {
    expect(MIN_REASON).toBe(10);
  });

  it('offers an override only for overridable finalize blockers', () => {
    expect(decisionOptions({ code: 'cash_total_mismatch', resolution: 'unresolved', blocksFinalize: true, overridable: true }))
      .toEqual([{ mode: 'accept', label: 'Accept with a reason' }]);
    expect(decisionOptions({ code: 'source_value_missing:cash', resolution: 'unresolved', blocksFinalize: true, overridable: false })).toEqual([]);
    expect(decisionOptions({ code: 'cash_total_mismatch', resolution: 'accepted', blocksFinalize: true, overridable: true })).toEqual([]);
  });
});