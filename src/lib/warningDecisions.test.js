// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every server call and entity write is recorded, in order.
const calls = vi.hoisted(() => []);
const state = vi.hoisted(() => ({ distributions: [] }));
vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: { me: async () => ({ email: 'admin@example.invalid' }) },
    entities: {
      ReportingPeriod: { update: async (id, data) => { calls.push(['ReportingPeriod.update', id, data]); } },
      Distribution: {
        filter: async () => state.distributions,
        update: async (id, data) => { calls.push(['Distribution.update', id, data]); },
        create: async (data) => { calls.push(['Distribution.create', data]); },
      },
    },
  },
}));
vi.mock('./periodTransition', () => ({
  periodTransition: async (action, periodId, extra = {}) => {
    calls.push(['periodTransition', action, periodId, extra]);
    return { ok: true };
  },
}));
import { decisionOptions, decisionBlockedReason, applyWarningDecision, MIN_REASON } from './warningDecisions';

const MESSAGE = 'Blank distribution cells for quarters that have begun: Alpha Q1, Alpha Q2. They add nothing to Distributions YTD; confirm none was received.';
const blank = (msg = MESSAGE) => ({ code: 'distribution_quarter_blank', resolution: 'unresolved', blocksFinalize: false, message: msg });
const draft = (extra = {}) => ({
  id: 'p9',
  label: 'September 2026',
  status: 'draft',
  published: false,
  bva_import_status: 'draft',
  bva_parsed_source: { distributions: { entities: [{ name: 'Beta' }, { name: 'Alpha' }] } },
  bva_corrections: [{ id: 'old', kind: 'override', target: 'title_month_mismatch', reason: 'Titled by report month', by: 'x', at: 't' }],
  ...extra,
});
const REASON = 'Confirmed with the client: none received.';

beforeEach(() => {
  calls.length = 0;
  state.distributions = [{ id: 'd1', entity_name: 'Alpha', q1: null, q2: null }];
});

describe('decision options', () => {
  it('offers confirm / enter-amounts for a blank distribution quarter warning', () => {
    expect(decisionOptions(blank()).map((o) => o.mode)).toEqual(['confirm_zero', 'enter_amounts']);
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

describe('published and final reports require the deliberate administrative reopen', () => {
  it('a published period is refused before anything is written — no reopen, no publish, no confirmation sent', async () => {
    const period = draft({ status: 'final', published: true, bva_import_status: 'final' });
    expect(decisionBlockedReason(period)).toMatch(/published.*Review & Publish/);
    await expect(applyWarningDecision({ period, warning: blank(), mode: 'confirm_zero', reason: REASON })).rejects.toThrow(/published/);
    expect(calls).toEqual([]);
  });

  it('a final (unpublished) period is refused the same way', async () => {
    const period = draft({ status: 'final', bva_import_status: 'final' });
    await expect(applyWarningDecision({ period, warning: blank(), mode: 'confirm_zero', reason: REASON })).rejects.toThrow(/final and read-only/);
    expect(calls).toEqual([]);
  });

  it('the module never reopens, publishes or supplies a typed confirmation', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'warningDecisions.js'), 'utf8');
    expect(src).not.toMatch(/periodTransition\(\s*['"](reopen|publish|invalidate|set_stage)['"]/);
    expect(src).not.toMatch(/confirm\s*:/);
  });
});

describe('draft decisions keep an audit record', () => {
  it('confirm-none: audit records first (merged), then the explicit zeros, then finalize only', async () => {
    await applyWarningDecision({ period: draft(), warning: blank(), mode: 'confirm_zero', reason: REASON });
    expect(calls.map((c) => c[0] + (c[0] === 'periodTransition' ? `:${c[1]}` : ''))).toEqual([
      'ReportingPeriod.update',
      'Distribution.update',
      'Distribution.update',
      'periodTransition:finalize',
    ]);
    const saved = calls[0][2].bva_corrections;
    expect(saved.find((c) => c.id === 'old')).toBeTruthy(); // existing history preserved
    const zeros = saved.filter((c) => c.kind === 'zero_confirm');
    expect(zeros.map((c) => [c.target, c.path, c.original_value, c.value])).toEqual([
      ['Alpha Q1', 'distributions.entities.1.q1', null, 0],
      ['Alpha Q2', 'distributions.entities.1.q2', null, 0],
    ]);
    expect(zeros.every((c) => c.reason === REASON && c.by === 'admin@example.invalid' && c.at)).toBe(true);
    expect(calls.slice(1, 3).map((c) => c[2])).toEqual([{ q1: 0 }, { q2: 0 }]);
  });

  it('entered amounts are recorded as source corrections with their values', async () => {
    await applyWarningDecision({ period: draft(), warning: blank(), mode: 'enter_amounts', reason: REASON, amounts: { 'Alpha:q1': '125', 'Alpha:q2': '0' } });
    const saved = calls[0][2].bva_corrections.filter((c) => c.kind === 'source');
    expect(saved.map((c) => [c.target, c.value])).toEqual([['Alpha Q1', 125], ['Alpha Q2', 0]]);
  });

  it('a missing entered amount is refused before anything is written', async () => {
    await expect(applyWarningDecision({ period: draft(), warning: blank(), mode: 'enter_amounts', reason: REASON, amounts: { 'Alpha:q1': '125' } })).rejects.toThrow(/Alpha Q2/);
    expect(calls).toEqual([]);
  });

  it('accepting an exception records an override correction and passes the reason to finalize', async () => {
    const warning = { code: 'cash_total_mismatch', resolution: 'unresolved', blocksFinalize: true, overridable: true, message: 'm' };
    await applyWarningDecision({ period: draft(), warning, mode: 'accept', reason: REASON });
    expect(calls[0][2].bva_corrections.find((c) => c.kind === 'override' && c.target === 'cash_total_mismatch').reason).toBe(REASON);
    expect(calls[1]).toEqual(['periodTransition', 'finalize', 'p9', { overrides: { 'open_reconciliation:cash_total_mismatch': { reason: REASON } } }]);
    expect(calls).toHaveLength(2);
  });
});
