// The checklist (base44/shared/checklistCore.ts). Fictional data only.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  CHECKLIST_ITEMS, CHECKLIST_KEYS, PARTS, CATALOGUE, partHashes, checklistStatus, confirmationRecord, warningCodes, buildReview, explain, itemMessage,
} from '../../base44/shared/checklistCore.ts';
import { PUBLISH_CHECKLIST } from '../../base44/shared/publishGate.ts';

const period = (extra = {}) => ({
  id: 'p', label: 'Month 8 2030', month: 8, year: 2030, reporting_cutoff_date: '2030-07-31', months_elapsed: 7,
  ytd_income: 7091, month_income: 1013, annual_budgeted_income: 12157, ytd_expenses: 5677, month_expenses: 811, annual_budgeted_expenses: 9733,
  total_cash: 4409, distributions_ytd: 307, savings_in_ytd: 411, bva_parsed_source: {}, bva_overrides: {}, bva_validation_warnings: [], ...extra,
});
const records = (over = {}) => ({
  period: period(over.period),
  lines: over.lines || [
    { id: 'l1', category: 'Test Income', budget_group: 'income', ytd_actual: 7091, annual_budget: 12157, month_actual: 1013 },
    { id: 'l2', category: 'FIXED', budget_group: 'fixed', ytd_actual: 1477, annual_budget: 2533, month_actual: 211 },
    { id: 'l3', category: 'VARIABLE', budget_group: 'variable', ytd_actual: 2149, annual_budget: 3685, month_actual: 307 },
    { id: 'l4', category: 'DISCRETIONARY', budget_group: 'discretionary', ytd_actual: 2051, annual_budget: 3515, month_actual: 293 },
    { id: 'l5', category: 'Test Row', budget_group: 'variable', group_confirmed: true, bva_detail: true, qb_code: '9001', ytd_actual: 353, annual_budget: 709 },
  ],
  cash: over.cash || [{ id: 'c1', name: 'Test Checking', balance: 3991, account_type: 'bank' }, { id: 'c2', name: 'Test Savings', balance: 409, account_type: 'bank' }],
  distributions: over.distributions || [{ id: 'd1', entity_name: 'Test Entity', q1: 101, q2: 206 }],
  transfers: over.transfers || [{ id: 't1', source: 'Test Bank', purpose: 'Test Savings', amount: 17 }],
  savings: over.savings || [{ id: 's1', category: 'Test Repair', ytd_amount: 12 }],
});
const changedParts = (a, b) => Object.keys(PARTS).filter((k) => a[k] !== b[k]);
const confirmAll = (rec, warnings = []) => Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, confirmationRecord(k, partHashes(rec), warnings, 'admin@example.invalid', '2030-08-05T00:00:00Z')]));
const states = (confs, rec, { openBlockers = [], warnings = [] } = {}) => Object.fromEntries(checklistStatus({ confirmations: confs, hashes: partHashes(rec), openBlockers, warnings }).map((s) => [s.key, s.state]));
const staleKeys = (st) => Object.keys(st).filter((k) => st[k] !== 'confirmed').sort();

describe('the seven existing items', () => {
  it('keep their keys, names and order', () => {
    expect(CHECKLIST_ITEMS.map((i) => [i.key, i.label])).toEqual(PUBLISH_CHECKLIST.map(([k, l]) => [k, l]));
  });
});

describe('only the item whose data changed goes stale', () => {
  const base = records();
  const confs = confirmAll(base);
  it.each([
    ['a cash balance', { cash: [{ id: 'c1', name: 'Test Checking', balance: 3992, account_type: 'bank' }, { id: 'c2', name: 'Test Savings', balance: 409, account_type: 'bank' }] }, ['cash_accounts'], ['budget_report_reviewed', 'cash_confirmed']],
    ['Total Cash', { period: { total_cash: 4410 } }, ['total_cash'], ['budget_report_reviewed', 'cash_confirmed']],
    ['a closed distribution quarter', { distributions: [{ id: 'd1', entity_name: 'Test Entity', q1: 102, q2: 206 }] }, ['distributions'], ['budget_report_reviewed', 'distributions_confirmed']],
    ['Savings / Distributions In', { period: { savings_in_ytd: 412 } }, ['distribution_totals'], ['budget_report_reviewed', 'distributions_confirmed']],
    ['the income budget', { period: { annual_budgeted_income: 12158 } }, ['income_totals'], ['budget_report_reviewed', 'income_reviewed']],
    ['a watch-list row group', { lines: records().lines.map((l) => (l.id === 'l5' ? { ...l, budget_group: 'fixed' } : l)) }, ['line_groups'], ['budget_report_reviewed', 'classes_reviewed']],
    ['a recurring transfer', { transfers: [{ id: 't1', source: 'Test Bank', purpose: 'Test Savings', amount: 18 }] }, ['transfers'], ['budget_report_reviewed']],
    ['the cutoff', { period: { reporting_cutoff_date: '2030-06-30', months_elapsed: 6 } }, ['cutoff'], ['budget_report_reviewed']],
  ])('%s', (_, over, parts, items) => {
    const rec = records(over);
    expect(changedParts(partHashes(base), partHashes(rec))).toEqual(parts);
    expect(staleKeys(states(confs, rec))).toEqual(items);
  });
  it('a group year-to-date figure: refunds, budget report (and nothing about cash or distributions)', () => {
    const rec = records({ lines: records().lines.map((l) => (l.id === 'l3' ? { ...l, ytd_actual: 2150 } : l)) });
    expect(staleKeys(states(confs, rec))).toEqual(['budget_report_reviewed', 'refunds_reviewed']);
  });
});

describe('an identical re-import resets nothing', () => {
  it('new record ids, other order, timestamps and copied_from do not matter', () => {
    const a = records();
    const b = records({
      lines: [...records().lines].reverse().map((l, i) => ({ ...l, id: `new${i}`, created_date: '2031-01-01', updated_date: '2031-01-02', copied_from: 'x' })),
      cash: [...records().cash].reverse().map((c, i) => ({ ...c, id: `nc${i}`, created_date: '2031-01-01' })),
      distributions: records().distributions.map((d) => ({ ...d, id: 'nd' })),
    });
    b.period = { ...b.period, updated_date: '2031-01-02', last_updated: '2031-01-02', finalized_at: 'y' };
    expect(partHashes(b)).toEqual(partHashes(a));
  });
  it('a re-finalize recording the same reasons (new who/when) is not a change', () => {
    const a = records({ period: { bva_overrides: { 'cross_period:ytd_income_decreased': { reason: 'Refund.', by: 'a', at: '1' } } } });
    const b = records({ period: { bva_overrides: { 'cross_period:ytd_income_decreased': { reason: 'Refund.', by: 'b', at: '2' } } } });
    expect(partHashes(b)).toEqual(partHashes(a));
  });
  it('an exclusion is matched by line name, not by the (re-created) line id', () => {
    const lines = (id) => records().lines.map((l) => (l.id === 'l5' ? { ...l, id } : l));
    const a = { ...records({ lines: lines('l5') }), period: period({ bva_overrides: { 'detail_unassigned:l5': { reason: 'Excluded.' } } }) };
    const b = { ...records({ lines: lines('l9') }), period: period({ bva_overrides: { 'detail_unassigned:l9': { reason: 'Excluded.' } } }) };
    expect(partHashes(b)).toEqual(partHashes(a));
  });
});

describe('missing is not $0.00', () => {
  it('a value becoming missing, or missing becoming 0, is a change', () => {
    const zero = records({ period: { distributions_ytd: 0 } });
    const missing = records({ period: { distributions_ytd: 0, source_missing_fields: ['distributions_ytd'] } });
    expect(partHashes(missing).distribution_totals).not.toBe(partHashes(zero).distribution_totals);
    const lineBlank = records({ lines: records().lines.map((l) => (l.id === 'l2' ? (({ month_actual, ...rest }) => rest)(l) : l)) });
    const lineZero = records({ lines: records().lines.map((l) => (l.id === 'l2' ? { ...l, month_actual: 0 } : l)) });
    expect(partHashes(lineBlank).expense_lines).not.toBe(partHashes(lineZero).expense_lines);
  });
});

describe('warnings and blockers', () => {
  const rec = records();
  it('a new LINKED warning makes the linked items stale (and the whole report); others stay confirmed', () => {
    const confs = confirmAll(rec, []);
    expect(staleKeys(states(confs, rec, { warnings: ['cross_period:cash_accounts_changed'.replace('cross_period:', '')] }))).toEqual(['budget_report_reviewed', 'cash_confirmed']);
  });
  it('a warning already seen at confirmation does not', () => {
    const confs = confirmAll(rec, ['cash_accounts_changed']);
    expect(staleKeys(states(confs, rec, { warnings: ['cash_accounts_changed'] }))).toEqual([]);
  });
  it('a linked open blocker blocks the item (state codes never do)', () => {
    const st = states({}, rec, { openBlockers: [{ code: 'open_reconciliation:cash_total_mismatch', overridable: true }, { code: 'not_final' }, { code: 'checklist_incomplete:x' }] });
    expect(st.cash_confirmed).toBe('blocked');
    expect(st.budget_report_reviewed).toBe('blocked');
    expect(st.income_reviewed).toBe('unconfirmed');
  });
  it('a confirmation stores only its own parts and its linked warnings', () => {
    const c = confirmationRecord('cash_confirmed', partHashes(rec), ['cash_accounts_changed', 'month_gap'], 'a', 't');
    expect(Object.keys(c.parts).sort()).toEqual(['cash_accounts', 'total_cash']);
    expect(c.warnings).toEqual(['cash_accounts_changed']);
  });
  it('warningCodes: non-blocking validation warnings and cross-period warnings, by code', () => {
    const p = period({ bva_validation_warnings: [{ code: 'pace_proxy_divergence', blocksFinalize: false }, { code: 'cash_total_mismatch', blocksFinalize: true }, { code: 'x', blocksFinalize: false, overridden: true }] });
    expect(warningCodes(p, [{ code: 'month_gap', severity: 'warn' }, { code: 'new_year', severity: 'info' }])).toEqual(['month_gap', 'pace_proxy_divergence']);
  });
  it('the reason an item is stale is spelled out', () => {
    const s = checklistStatus({ confirmations: confirmAll(rec), hashes: partHashes(records({ period: { total_cash: 1 } })), openBlockers: [], warnings: ['cash_accounts_changed'] }).find((x) => x.key === 'cash_confirmed');
    expect(itemMessage(s)).toBe('Cash balances confirmed: needs confirming again -- Total Cash changed; new warning: Cash accounts were added or removed since admin@example.invalid confirmed on 2030-08-05.');
  });
});

describe('four groups', () => {
  it('blockers / needs review / warnings / completed never overlap, and nothing is dropped', () => {
    const items = checklistStatus({ confirmations: { income_reviewed: confirmationRecord('income_reviewed', partHashes(records()), [], 'a', 't') }, hashes: partHashes(records()), openBlockers: [], warnings: [] });
    const r = buildReview({
      period: period({ bva_validation_warnings: [{ code: 'pace_proxy_divergence', blocksFinalize: false, message: 'm' }], bva_overrides: { 'cross_period:month_gap': { reason: 'ok', by: 'a', at: 't' } } }),
      blockers: [{ code: 'cross_period:closed_quarter_missing:x:q1', overridable: false, message: 'Q1 blank' }, { code: 'cross_period:ytd_income_decreased', overridable: true, message: 'down' }, { code: 'not_final', overridable: false }],
      crossFindings: [{ code: 'transfers_ended', severity: 'warn', message: 'w' }, { code: 'new_year', severity: 'info', message: 'n' }],
      crossRan: true, items,
    });
    expect(r.blockers.map((e) => e.code)).toEqual(['cross_period:closed_quarter_missing:x:q1']);
    expect(r.needsReview.filter((e) => e.kind === 'reason').map((e) => e.code)).toEqual(['cross_period:ytd_income_decreased']);
    expect(r.needsReview.filter((e) => e.kind === 'checklist')).toHaveLength(6);
    expect(r.warnings.map((e) => e.code).sort()).toEqual(['pace_proxy_divergence', 'transfers_ended']);
    expect(r.notes.map((e) => e.code)).toEqual(['new_year']);
    expect(r.completed.some((e) => e.code === 'checklist:income_reviewed')).toBe(true);
    expect(r.completed.some((e) => e.kind === 'accepted' && /Reason: "ok"/.test(e.problem))).toBe(true);
    expect(r.completed.some((e) => e.title === 'Closed distribution quarters are unchanged')).toBe(false); // it failed
    expect(r.completed.some((e) => e.title === 'Cash accounts add up to Total Cash')).toBe(true);
    for (const e of [...r.blockers, ...r.needsReview, ...r.warnings]) expect(e.action).toBeTruthy();
  });
  it('a check that did not run is never listed as passed', () => {
    const r = buildReview({ period: period({ bva_parsed_source: undefined }), blockers: [], crossFindings: [], crossRan: false, items: [] });
    expect(r.completed.filter((e) => e.kind === 'passed')).toEqual([]);
  });
});

describe('plain language for every code the system can produce', () => {
  const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  const found = new Set();
  const add = (s) => { const f = s.split(/[:$]/)[0]; if (f && !f.startsWith('{')) found.add(f); };
  for (const f of ['base44/shared/publishGate.ts', 'base44/shared/crossPeriod.ts', 'src/lib/bvaValidation.js', 'src/lib/bvaParser.js', 'base44/shared/periodTransitionCore.ts']) {
    const s = src(f);
    for (const m of s.matchAll(/code: ['`]([a-z_][a-z_:${}.]*)/g)) add(m[1]);
    for (const m of s.matchAll(/blocker\(\s*['`]([a-z_][a-z_:${}.]*)/g)) add(m[1]);
    for (const m of s.matchAll(/add\('(?:block|override|warn|info)', ['`]([a-z_][a-z_:${}.]*)/g)) add(m[1]);
    for (const m of s.matchAll(/pushWarn\(\s*['`]([a-z_][a-z_:${}.]*)/g)) add(m[1]);
  }
  // codes built from a field name
  for (const f of ['ytd_income_decreased', 'ytd_expenses_decreased', 'distributions_ytd_decreased', 'savings_in_ytd_decreased']) found.add(f);
  const transitionOnly = new Set(['period_exists', 'initialization_failed', 'revision_discarded', 'superseded_read_only', 'source_not_final', 'revision_copy_unverified', 'not_a_published_revision', 'replaced_by_other', 'replaced_by_newer', 'stale_revision', 'source_missing', 'newer_version_published', 'not_final_or_published', 'reopen_reason_required', 'reopen_confirmation_required', 'locked', 'open_revision_exists', 'schema_out_of_date', 'concurrent_revision', 'revision_exists', 'conflict_unresolved', 'schema_out_of_date']);
  it.each([...found].filter((c) => !transitionOnly.has(c)).sort())('%s has a plain-language entry', (code) => {
    expect(CATALOGUE[code], `no catalogue entry for ${code}`).toBeTruthy();
    expect(explain(code).action.length).toBeGreaterThan(5);
  });
  it('found the codes (sanity)', () => expect(found.size).toBeGreaterThan(60));
});

describe('missing elapsed months', () => {
  it('a missing months_elapsed is not 0', () => {
    expect(partHashes(records({ period: { months_elapsed: null } })).cutoff).not.toBe(partHashes(records({ period: { months_elapsed: 0 } })).cutoff);
  });
});
