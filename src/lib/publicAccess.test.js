// Security regression tests for what anonymous (no-login) visitors can see.
// The public functions read with the service role, which bypasses entity
// access rules, so these tests pin the server-side rules that keep unpublished
// and internal data private. EVERY name and number here is FICTIONAL.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_TRANSACTION_FIELDS,
  NEVER_CLIENT_TRANSACTION_FIELDS,
  PUBLIC_DRILLDOWN_KEYS,
  PUBLIC_PERIOD_FIELDS,
  buildPublicDashboard,
  handlePublicCategoryRequest,
  handleCategoryTransactionsRequest,
  maskAccountNumbers,
  publicTransfers,
} from '../../base44/shared/publicDashboardCore.ts';

const INTERNAL = {
  bva_parsed_source: { cash: { accounts: [{ name: 'Internal Only', balance: 1 }] } },
  bva_validation_warnings: [{ code: 'x' }],
  bva_overrides: { x: { reason: 'r' } },
  imported_by: 'admin@example.invalid',
  reviewed_by: 'Reviewer',
  checklist: { a: true },
  notes: 'internal note',
  source_filename: 'workbook.xlsx',
  finalized_by: 'admin@example.invalid',
  qb_account_names: ['Secret Ledger Name'],
};
const FORBIDDEN_KEYS = Object.keys(INTERNAL);

const PUBLISHED = { id: 'p-aug', label: 'August 2026', month: 8, year: 2026, status: 'final', published: true, start_date: '2026-08-01', end_date: '2026-08-31', total_cash: 1000, months_elapsed: 8, ...INTERNAL };
const OLDER = { id: 'p-jun', label: 'June 2026', month: 6, year: 2026, status: 'final', published: true, start_date: '2026-06-01', end_date: '2026-06-30', ...INTERNAL };
const DRAFT_JUL = { id: 'p-jul', label: 'July 2026', month: 7, year: 2026, status: 'draft', published: false, start_date: '2026-07-01', end_date: '2026-07-31', ...INTERNAL };
const FINAL_UNPUBLISHED = { id: 'p-may', label: 'May 2026', month: 5, year: 2026, status: 'final', published: false, ...INTERNAL };
const DRAFT_SEP = { id: 'p-sep', label: 'September 2026', month: 9, year: 2026, status: 'draft', published: false, ...INTERNAL };

const rows = {
  BudgetLine: [
    { id: 'l1', period_id: 'p-aug', category: 'Groceries', qb_code: '6100', budget_group: 'variable', ytd_actual: 50, annual_budget: 100, month_actual: 5, drilldown_enabled: true, qb_account_names: ['Food Ledger'], internal_note: 'x' },
    { id: 'l2', period_id: 'p-aug', category: 'Hidden Thing', budget_group: 'fixed', drilldown_enabled: false, qb_account_names: ['Other Ledger'] },
    { id: 'l3', period_id: 'p-sep', category: 'Groceries', budget_group: 'variable', qb_account_names: ['Food Ledger'] },
    { id: 'l4', period_id: 'p-jul', category: 'Groceries', budget_group: 'variable', qb_account_names: ['Food Ledger'] },
  ],
  CashAccount: [
    { id: 'c1', period_id: 'p-aug', name: 'Harbor Checking', balance: 700, account_type: 'bank', sort_order: 1, internal: 'x' },
    { id: 'c2', period_id: 'p-sep', name: 'Draft Only Account', balance: 9 },
  ],
  Distribution: [{ id: 'd1', period_id: 'p-aug', entity_name: 'Maple Holdings', q1: 1, q2: 2, q3: 3, q4: 0, note: 'x' }],
  RecurringTransfer: [
    { id: 't1', period_id: 'p-aug', amount: 100, source: 'Harbor Bank 7788', purpose: 'Tax Savings', visible_to_client: true },
    { id: 't2', period_id: 'p-aug', amount: 200, source: 'Harbor Bank 9911', purpose: 'Home Upkeep', visible_to_client: true },
    { id: 't3', period_id: 'p-aug', amount: 300, source: 'Lakeside Card', purpose: 'Internal Sweep', visible_to_client: false },
  ],
  SavingsSpend: [{ id: 's1', period_id: 'p-aug', category: 'Roof', ytd_amount: 10, approver: 'x' }],
  Account: [
    { id: 'a-food', account_name: 'Food Ledger', source: 'quickbooks' },
    { id: 'a-other', account_name: 'Other Ledger', source: 'quickbooks' },
  ],
  Transaction: [
    { id: 'x1', period_id: 'p-aug', account_id: 'a-food', date: '2026-08-10', vendor: 'Corner Market', description: 'weekly', amount: 12, full_account_path: '6100 Food', source: 'import', internal: 'x' },
    { id: 'x2', period_id: 'p-jul', account_id: 'a-food', date: '2026-07-10', vendor: 'Draft Month Shop', description: 'draft', amount: 99, source: 'import' },
    { id: 'x3', period_id: 'p-jun', account_id: 'a-food', date: '2026-06-10', vendor: 'June Market', description: 'june', amount: 7, source: 'import' },
    { id: 'x4', period_id: 'p-aug', account_id: 'a-other', date: '2026-08-11', vendor: 'Other Vendor', description: 'other', amount: 50, source: 'import' },
    { id: 'x5', period_id: 'p-aug', account_id: 'a-food', date: '2026-08-12', vendor: 'QB Vendor', amount: 1, source: 'quickbooks' },
  ],
};

function fakeBase44(periods) {
  const match = (row, q) => Object.entries(q).every(([k, v]) => row[k] === v);
  const entity = (name) => ({
    list: async () => (name === 'ReportingPeriod' ? periods : rows[name] || []),
    filter: async (q = {}) => (name === 'ReportingPeriod' ? periods : rows[name] || []).filter((r) => match(r, q)),
    get: async (id) => (name === 'ReportingPeriod' ? periods.find((p) => p.id === id) : null) || null,
  });
  const entities = new Proxy({}, { get: (_, n) => entity(n) });
  return { asServiceRole: { entities } };
}

const ALL = [PUBLISHED, OLDER, DRAFT_JUL, FINAL_UNPUBLISHED, DRAFT_SEP];
const keysDeep = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keysDeep(v)]) : []);

describe('publicDashboard: published + final only, server-side', () => {
  it('lists only published and final periods', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, {});
    expect(out.periods.map((p) => p.id)).toEqual(['p-aug', 'p-jun']);
    expect(out.period.id).toBe('p-aug');
  });

  it.each(['p-jul', 'p-may', 'p-sep', 'no-such-id'])('ignores a request for non-published period %s', async (id) => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, { period_id: id });
    expect(out.period.id).toBe('p-aug');
    expect(JSON.stringify(out)).not.toContain('Draft Only Account');
  });

  it('serves a requested published period', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, { period_id: 'p-jun' });
    expect(out.period.id).toBe('p-jun');
  });

  it('returns nothing when no period is published', async () => {
    const out = await buildPublicDashboard(fakeBase44([DRAFT_JUL, FINAL_UNPUBLISHED]).asServiceRole, {});
    expect(out).toEqual({ periods: [], period: null, budgetLines: [], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [], trend: null });
  });
});

describe('publicDashboard: explicit field allow-lists', () => {
  it('never returns internal fields, anywhere in the response', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, {});
    const keys = new Set(keysDeep(out));
    for (const k of [...FORBIDDEN_KEYS, 'internal', 'internal_note', 'note', 'approver', 'visible_to_client', 'period_id']) {
      expect(keys.has(k), k).toBe(false);
    }
    expect(JSON.stringify(out)).not.toMatch(/Internal Only|Secret Ledger Name|internal note|Internal Sweep/);
  });

  it('returns exactly the allow-listed keys per record type', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, {});
    expect(Object.keys(out.period).sort()).toEqual([...PUBLIC_PERIOD_FIELDS].sort());
    expect(Object.keys(out.budgetLines[0]).sort()).toEqual(
      ['id', 'category', 'qb_code', 'budget_group', 'month_actual', 'ytd_actual', 'annual_budget', 'monthly_budget', 'bva_detail', 'group_confirmed', 'drilldown_enabled'].sort()
    );
    expect(Object.keys(out.cashAccounts[0]).sort()).toEqual(['id', 'name', 'balance', 'account_type', 'as_of_date', 'sort_order'].sort());
    expect(Object.keys(out.distributions[0]).sort()).toEqual(['id', 'entity_name', 'q1', 'q2', 'q3', 'q4', 'workbook_ytd'].sort());
    expect(Object.keys(out.transfers[0]).sort()).toEqual(['id', 'amount', 'source', 'purpose'].sort());
    expect(Object.keys(out.savingsSpends[0]).sort()).toEqual(['id', 'category', 'ytd_amount'].sort());
    expect(Object.keys(out.trend).sort()).toEqual(['cashSinceLast', 'explanations', 'points', 'year']);
    expect(Object.keys(out.trend.points[0]).sort()).toEqual(['beforeBva', 'cash', 'cashPartial', 'dataMonth', 'dataMonthIndex', 'distributionsYtd', 'expectedPacePct', 'expenses', 'groups', 'income', 'reportId', 'reportLabel', 'supersedes']);
  });

  it('keeps every figure the client sees unchanged', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, {});
    expect(out.budgetLines[0]).toMatchObject({ category: 'Groceries', ytd_actual: 50, annual_budget: 100, month_actual: 5 });
    expect(out.cashAccounts[0]).toMatchObject({ name: 'Harbor Checking', balance: 700, account_type: 'bank' });
    expect(out.distributions[0]).toMatchObject({ entity_name: 'Maple Holdings', q1: 1, q2: 2, q3: 3, q4: 0 });
    expect(out.period.total_cash).toBe(1000);
  });
});

describe('public transfer labels: account numbers masked, accounts still distinguishable', () => {
  it('masks runs of 3+ digits', () => {
    expect(maskAccountNumbers('Harbor Bank 7788')).toBe('Harbor Bank ••••');
    expect(maskAccountNumbers('Acct x1234 / 5678')).toBe('Acct x•••• / ••••');
    expect(maskAccountNumbers('Lakeside Card')).toBe('Lakeside Card');
    expect(maskAccountNumbers(null)).toBe(null);
  });

  it('hides client-hidden transfers, masks numbers and keeps accounts apart', async () => {
    const out = await buildPublicDashboard(fakeBase44(ALL).asServiceRole, {});
    expect(out.transfers.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(out.transfers.map((t) => t.source)).toEqual(['Harbor Bank •••• (A)', 'Harbor Bank •••• (B)']);
    for (const t of out.transfers) expect(t.source).not.toMatch(/\d{3,}/);
    expect(out.transfers.map((t) => [t.amount, t.purpose])).toEqual([[100, 'Tax Savings'], [200, 'Home Upkeep']]);
  });

  it('labels are stable regardless of transfer order', () => {
    const a = publicTransfers([{ id: 1, source: 'Bank 2222', amount: 1 }, { id: 2, source: 'Bank 1111', amount: 1 }]);
    const b = publicTransfers([{ id: 2, source: 'Bank 1111', amount: 1 }, { id: 1, source: 'Bank 2222', amount: 1 }]);
    expect(a.find((t) => t.id === 1).source).toBe(b.find((t) => t.id === 1).source);
    expect(a.find((t) => t.id === 1).source).toBe('Bank •••• (B)');
  });
});

describe('publicCategoryTransactions: server-side publication and line checks', () => {
  const call = (body) => handlePublicCategoryRequest(fakeBase44(ALL), body);

  it('answers a published line with no transaction rows and only the allowlisted keys', async () => {
    const { status, body } = await call({ period_id: 'p-aug', budget_line_id: 'l1' });
    expect(status).toBe(200);
    expect(body).toEqual({ period_id: 'p-aug', category: 'Groceries', detail_available: false, transactions: [] });
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_DRILLDOWN_KEYS].sort());
    expect(JSON.stringify(body)).not.toMatch(/Corner Market|June Market|6100 Food|import/);
  });

  it('does not read transactions at all', async () => {
    const reads = [];
    const base = fakeBase44(ALL);
    const spy = { asServiceRole: { entities: new Proxy({}, { get: (_, n) => { reads.push(String(n)); return base.asServiceRole.entities[n]; } }) } };
    await handlePublicCategoryRequest(spy, { period_id: 'p-aug', budget_line_id: 'l1' });
    expect(reads).not.toContain('Transaction');
    expect(reads).not.toContain('Account');
  });

  it('the client field allowlist is empty and can never include internal fields', () => {
    expect(PUBLIC_TRANSACTION_FIELDS).toEqual([]); // no client fields approved yet
    expect(PUBLIC_TRANSACTION_FIELDS.filter((f) => NEVER_CLIENT_TRANSACTION_FIELDS.includes(f))).toEqual([]);
    for (const f of ['internal_notes', 'review_status', 'review_flags', 'reviewed_by', 'qb_transaction_id', 'qb_account', 'account_id', 'full_account_path', 'copied_from', 'source', 'treatment', 'id']) {
      expect(NEVER_CLIENT_TRANSACTION_FIELDS).toContain(f);
    }
  });

  it('builds YTD from published periods only (a draft month never leaks)', async () => {
    const { body } = await call({ period_id: 'p-aug', budget_line_id: 'l1' });
    expect(JSON.stringify(body)).not.toContain('Draft Month Shop');
  });

  it('never returns QuickBooks-sourced transactions', async () => {
    const { body } = await call({ period_id: 'p-aug', budget_line_id: 'l1' });
    expect(JSON.stringify(body)).not.toContain('QB Vendor');
  });

  it('ignores caller-supplied account names', async () => {
    const { body } = await call({ period_id: 'p-aug', budget_line_id: 'l1', qb_account_names: ['Other Ledger'] });
    expect(JSON.stringify(body)).not.toContain('Other Vendor');
  });

  it.each([
    ['an unpublished period', { period_id: 'p-jul', category: 'Groceries' }, 403],
    ['a final-but-unpublished period', { period_id: 'p-may', category: 'Groceries' }, 403],
    ['a draft period', { period_id: 'p-sep', budget_line_id: 'l3' }, 403],
    ['a missing period', { period_id: 'nope', category: 'Groceries' }, 404],
    ['a line from another period', { period_id: 'p-aug', budget_line_id: 'l3' }, 404],
    ['a line with drill-down disabled', { period_id: 'p-aug', budget_line_id: 'l2' }, 404],
    ['an unknown category', { period_id: 'p-aug', category: 'Nope' }, 404],
    ['no period', { category: 'Groceries' }, 400],
    ['no line or category', { period_id: 'p-aug' }, 400],
  ])('refuses %s', async (_, body, status) => {
    const res = await call(body);
    expect(res.status).toBe(status);
    expect(res.body.transactions).toBeUndefined();
  });

  it('still accepts a category name (older clients)', async () => {
    const { status } = await call({ period_id: 'p-aug', category: 'groceries' });
    expect(status).toBe(200);
  });
});

describe('categoryTransactions (signed in): admins full access, others public rules', () => {
  const call = (body, user) => handleCategoryTransactionsRequest(fakeBase44(ALL), body, user);

  it('rejects anonymous callers', async () => {
    expect((await call({ period_id: 'p-aug', category: 'Groceries' }, null)).status).toBe(401);
  });

  it('gives a signed-in non-admin exactly the public answer: no transaction rows', async () => {
    expect((await call({ period_id: 'p-jul', category: 'Groceries' }, { role: 'user' })).status).toBe(403);
    const ok = await call({ period_id: 'p-aug', budget_line_id: 'l1', qb_account_names: ['Other Ledger'] }, { role: 'user' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ detail_available: false, transactions: [] });
    expect(JSON.stringify(ok.body)).not.toMatch(/Other Vendor|Draft Month Shop|Corner Market/);
  });

  it('lets an admin open a draft period with full rows, as before', async () => {
    const res = await call({ period_id: 'p-jul', category: 'Groceries', qb_account_names: ['Food Ledger'] }, { role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.transactions[0]).toHaveProperty('source');
  });
});

describe('structural: anonymous-facing code never reads entities directly', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const clientFiles = [
    'src/pages/ClientView.jsx',
    'src/lib/usePublicDashboard.js',
    ...fs.readdirSync(path.join(ROOT, 'src/components/client')).filter((f) => /\.jsx?$/.test(f)).map((f) => `src/components/client/${f}`),
  ];

  it.each(clientFiles)('%s does not use base44.entities', (f) => {
    expect(read(f)).not.toMatch(/base44\s*\.\s*(asServiceRole\s*\.\s*)?entities\b/);
  });

  it.each(['publicDashboard', 'publicCategoryTransactions', 'categoryTransactions'])(
    '%s delegates to the tested shared handler',
    (fn) => {
      const text = read(`base44/functions/${fn}/entry.ts`);
      expect(text).toMatch(/from '\.\.\/\.\.\/shared\/publicDashboardCore\.ts'/);
      expect(text).not.toMatch(/\.entities\./);
    }
  );

  it('the client drill-down no longer sends account names', () => {
    const text = read('src/components/client/ClientDrilldown.jsx');
    expect(text).not.toMatch(/qb_account_names/);
    expect(text).toMatch(/budget_line_id:\s*line\.id/);
  });
});