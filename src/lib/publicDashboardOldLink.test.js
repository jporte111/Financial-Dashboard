// Blocker 12: a request for an old (replaced) version of a month serves THAT
// month's current published version -- not the latest month. Unknown ids and
// months with nothing published keep the fallback to the latest month. Only
// versions in the visible month list are ever served (one version per month;
// drafts and unpublished versions stay hidden). Fictional data only.
import { describe, it, expect } from 'vitest';
import { buildPublicDashboard } from '../../base44/shared/publicDashboardCore.ts';
import { fakeService } from './__fixtures__/fakeService.js';

const P = (id, month, extra = {}) => ({ id, label: `Month ${month} 2030`, month, year: 2030, status: 'final', bva_import_status: 'final', published: true, ...extra });
const DRAFT = { published: false, status: 'draft', bva_import_status: 'draft' };
// Each version carries one budget line naming it, so the served rows can be traced.
function seed(periods) {
  return {
    ReportingPeriod: periods,
    BudgetLine: periods.map((p) => ({ id: `line-${p.id}`, period_id: p.id, category: `Line of ${p.id}`, budget_group: 'fixed', ytd_actual: 1, annual_budget: 2 })),
    CashAccount: [], Distribution: [], RecurringTransfer: [], SavingsSpend: [],
  };
}
const serve = async (periods, period_id) => buildPublicDashboard(fakeService(seed(periods)).base44.asServiceRole, period_id === undefined ? {} : { period_id });
const BASE = [P('jun', 6), P('aug', 8)]; // August is the latest month

// Every version state, for July.
const STATES = {
  superseded: [P('jul', 7, { published: false, superseded: true, superseded_by: 'jul-r' }), P('jul-r', 7, { supersedes: 'jul', revision_number: 2 })],
  awaitingCleanup: [P('jul', 7), P('jul-r', 7, { supersedes: 'jul', revision_number: 2 })],
  chain: [
    P('jul', 7, { published: false, superseded: true, superseded_by: 'jul-r2' }),
    P('jul-r2', 7, { supersedes: 'jul', revision_number: 2, published: false, superseded: true, superseded_by: 'jul-r3' }),
    P('jul-r3', 7, { supersedes: 'jul-r2', revision_number: 3 }),
  ],
  discarded: [P('jul', 7), P('jul-x', 7, { ...DRAFT, supersedes: 'jul', revision_number: 2, revision_status: 'discarded' })],
  openDraft: [P('jul', 7), P('jul-d', 7, { ...DRAFT, supersedes: 'jul', revision_number: 2, revision_status: 'open', copy_status: 'verified' })],
  draftOnlyMonth: [P('jul', 7, { ...DRAFT })],
  competing: [P('jul-a', 7, { supersedes: 'jul-o', revision_number: 2 }), P('jul-b', 7, { supersedes: 'jul-o', revision_number: 2 }), P('jul-o', 7, { published: false, superseded: true, superseded_by: 'jul-a' })],
};

describe('an old link resolves to the same month\'s current version', () => {
  it.each([
    ['a superseded original (clean supersede)', 'superseded', 'jul', 'jul-r'],
    ['an original awaiting supersede cleanup', 'awaitingCleanup', 'jul', 'jul-r'],
    ['the original in a revision chain', 'chain', 'jul', 'jul-r3'],
    ['a superseded middle revision in a chain', 'chain', 'jul-r2', 'jul-r3'],
    ['a discarded revision', 'discarded', 'jul-x', 'jul'],
    ['an open draft revision (never served itself)', 'openDraft', 'jul-d', 'jul'],
  ])('%s', async (_, state, requested, expected) => {
    const out = await serve([...BASE, ...STATES[state]], requested);
    expect(out.period.id).toBe(expected);
    expect(out.period.month).toBe(7);
    // the rows are the served version's, never the requested old version's
    expect(out.budgetLines.map((l) => l.category)).toEqual([`Line of ${expected}`]);
  });
});

describe('unchanged behaviour', () => {
  it('a month with only a draft: the latest month (the draft stays hidden)', async () => {
    const out = await serve([...BASE, ...STATES.draftOnlyMonth], 'jul');
    expect(out.period.id).toBe('aug');
    expect(out.periods.map((p) => p.id)).not.toContain('jul');
  });
  it('an unknown id, and no id: the latest month', async () => {
    expect((await serve([...BASE, ...STATES.superseded], 'nope')).period.id).toBe('aug');
    expect((await serve([...BASE, ...STATES.superseded])).period.id).toBe('aug');
    expect((await serve([...BASE, ...STATES.superseded], '')).period.id).toBe('aug');
  });
  it('a current id: itself', async () => {
    for (const id of ['jun', 'aug', 'jul-r']) expect((await serve([...BASE, ...STATES.superseded], id)).period.id).toBe(id);
  });
  it('competing published versions of a month: the one the month list shows', async () => {
    const out = await serve([...BASE, ...STATES.competing], 'jul-o');
    const listed = out.periods.filter((p) => p.month === 7).map((p) => p.id);
    expect(listed).toHaveLength(1); // one version per month in the list
    expect(out.period.id).toBe(listed[0]);
    for (const id of ['jul-a', 'jul-b']) expect([listed[0], id]).toContain((await serve([...BASE, ...STATES.competing], id)).period.id);
  });
  it('the month list itself does not depend on the requested id', async () => {
    const periods = [...BASE, ...STATES.chain];
    const lists = await Promise.all(['jul', 'jul-r2', 'jul-r3', 'aug', 'nope', undefined].map(async (id) => JSON.stringify((await serve(periods, id)).periods)));
    expect(new Set(lists).size).toBe(1);
  });
});

describe('the served version always belongs to the visible month list', () => {
  it('for every seeded state and every requestable id (one version per month; no draft, discarded or superseded version served)', async () => {
    for (const [state, versions] of Object.entries(STATES)) {
      const periods = [...BASE, ...versions];
      for (const id of [...periods.map((p) => p.id), 'nope', undefined]) {
        const out = await serve(periods, id);
        const listed = out.periods.map((p) => p.id);
        expect(listed, `${state}/${id}`).toContain(out.period.id);
        expect(new Set(out.periods.map((p) => `${p.year}-${p.month}`)).size, state).toBe(listed.length);
        const v = periods.find((p) => p.id === out.period.id);
        expect(v.published && !v.superseded && v.revision_status !== 'discarded', `${state}/${id}`).toBe(true);
        expect(out.budgetLines.every((l) => l.category === `Line of ${out.period.id}`), `${state}/${id}`).toBe(true);
      }
    }
  });
});
