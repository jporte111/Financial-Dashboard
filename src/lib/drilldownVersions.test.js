// Drill-downs and report versions (Phase 4 rules): a superseded, replaced
// (awaiting cleanup), discarded or unpublished draft version never supplies
// transaction rows -- not for its own month, and not to a later month's
// year-to-date. Fictional data only.
import { describe, it, expect } from 'vitest';
import { handleCategoryTransactionsRequest, handlePublicCategoryRequest } from '../../base44/shared/publicDashboardCore.ts';
import { transactionsForCategory } from '../../base44/shared/categoryTransactionsCore.ts';
import { fakeService } from './__fixtures__/fakeService.js';

const ADMIN = { role: 'admin', email: 'admin@example.invalid' };
const P = (id, month, extra = {}) => ({
  id, label: `Month ${month} 2026`, month, year: 2026, status: 'final', bva_import_status: 'final', published: true,
  start_date: `2026-${String(month).padStart(2, '0')}-01`, end_date: `2026-${String(month).padStart(2, '0')}-28`, ...extra,
});
const T = (id, period_id, month, vendor) => ({ id, period_id, date: `2026-${String(month).padStart(2, '0')}-10`, amount: 10, vendor, category: 'Groceries', account_id: 'acct', source: 'import' });

// Every version state at once.
const SEED = () => ({
  ReportingPeriod: [
    // March: current published original + a DISCARDED revision
    P('mar', 3), P('mar-x', 3, { published: false, status: 'draft', bva_import_status: 'draft', supersedes: 'mar', revision_number: 2, revision_status: 'discarded' }),
    // April: current published original + an OPEN draft revision
    P('apr', 4), P('apr-r', 4, { published: false, status: 'draft', bva_import_status: 'draft', supersedes: 'apr', revision_number: 2, revision_status: 'open', copy_status: 'verified' }),
    // May: a published revision whose original still awaits supersede cleanup
    P('may', 5), P('may-r', 5, { supersedes: 'may', revision_number: 2 }),
    // June: a cleanly superseded original + its published revision
    P('jun', 6, { published: false, superseded: true, superseded_by: 'jun-r' }), P('jun-r', 6, { supersedes: 'jun', revision_number: 2 }),
    // July (the month being drilled into): superseded original + current revision
    P('jul', 7, { published: false, superseded: true, superseded_by: 'jul-r' }), P('jul-r', 7, { supersedes: 'jul', revision_number: 2 }),
  ],
  BudgetLine: ['mar', 'mar-x', 'apr', 'apr-r', 'may', 'may-r', 'jun', 'jun-r', 'jul', 'jul-r'].map((pid) => ({ id: `l-${pid}`, period_id: pid, category: 'Groceries', budget_group: 'variable' })),
  Transaction: [
    T('t1', 'mar', 3, 'March CURRENT'), T('t2', 'mar-x', 3, 'March DISCARDED'),
    T('t3', 'apr', 4, 'April CURRENT'), T('t4', 'apr-r', 4, 'April DRAFT'),
    T('t5', 'may', 5, 'May REPLACED'), T('t6', 'may-r', 5, 'May CURRENT'),
    T('t7', 'jun', 6, 'June SUPERSEDED'), T('t8', 'jun-r', 6, 'June CURRENT'),
    T('t9', 'jul', 7, 'July SUPERSEDED'), T('t10', 'jul-r', 7, 'July CURRENT'),
  ],
  Account: [{ id: 'acct', account_name: 'Groceries', source: 'quickbooks' }],
});
const NEVER = /SUPERSEDED|REPLACED|DISCARDED|DRAFT/;
const vendors = (body) => (body.transactions || []).map((t) => t.vendor).sort();
const admin = (db, period_id) => handleCategoryTransactionsRequest(db.base44, { period_id, category: 'Groceries' }, ADMIN);

describe('admin drill-down: year-to-date takes exactly one current version per month', () => {
  it('July (current revision): its own rows plus each earlier month\'s current version only', async () => {
    const db = fakeService(SEED());
    const r = await admin(db, 'jul-r');
    expect(r.status).toBe(200);
    expect(vendors(r.body)).toEqual(['April CURRENT', 'July CURRENT', 'June CURRENT', 'March CURRENT', 'May CURRENT']);
    expect(JSON.stringify(r.body)).not.toMatch(NEVER);
  });

  it('the same with published-only year-to-date', async () => {
    const db = fakeService(SEED());
    const out = await transactionsForCategory(db.base44, db.tables.ReportingPeriod.get('jul-r'), 'Groceries', [], { publishedOnly: true });
    expect(vendors(out)).toEqual(['April CURRENT', 'July CURRENT', 'June CURRENT', 'March CURRENT', 'May CURRENT']);
  });

  it('an open draft revision shows its own month\'s rows (not the original\'s) and only current versions of earlier months', async () => {
    const db = fakeService(SEED());
    const r = await admin(db, 'apr-r');
    expect(vendors(r.body)).toEqual(['April DRAFT', 'March CURRENT']);
  });

  it.each([
    ['a superseded original', 'jul'],
    ['a superseded original of an earlier month', 'jun'],
    ['an original replaced but awaiting supersede cleanup', 'may'],
    ['a discarded revision', 'mar-x'],
  ])('refuses %s: no rows at all', async (_, id) => {
    const db = fakeService(SEED());
    const r = await admin(db, id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('superseded_version');
    expect(r.body.transactions).toBeUndefined();
  });
});

describe('client drill-down: no transaction rows from any version', () => {
  it('the current version answers with no rows', async () => {
    const db = fakeService(SEED());
    const r = await handlePublicCategoryRequest(db.base44, { period_id: 'jul-r', budget_line_id: 'l-jul-r' });
    expect(r.status).toBe(200);
    expect(r.body.transactions).toEqual([]);
    expect(r.body.detail_available).toBe(false);
  });

  it.each(['jul', 'jun', 'may', 'apr-r', 'mar-x'])('version %s is refused (not the month\'s current published version)', async (id) => {
    const db = fakeService(SEED());
    const r = await handlePublicCategoryRequest(db.base44, { period_id: id, budget_line_id: `l-${id}` });
    expect(r.status).toBe(403);
    expect(r.body.transactions).toBeUndefined();
  });

  it('a signed-in non-admin gets the public answer for every version', async () => {
    const db = fakeService(SEED());
    for (const id of ['jul-r', 'jul', 'may', 'apr-r']) {
      const r = await handleCategoryTransactionsRequest(db.base44, { period_id: id, budget_line_id: `l-${id}`, category: 'Groceries' }, { role: 'user' });
      expect(JSON.stringify(r.body)).not.toMatch(/CURRENT|SUPERSEDED|REPLACED|DISCARDED|DRAFT/);
    }
  });
});
