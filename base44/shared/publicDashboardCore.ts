// Server-side shaping for everything anonymous visitors can see.
//
// The client and bookkeeper open the published dashboard without logging in,
// so the backend functions (which read with the service role and therefore
// bypass entity access rules) are the ONLY path by which financial data leaves
// the server for a non-admin. Every rule that keeps unpublished or internal
// data private is enforced here, on the server:
//   - only periods that are published AND final are ever served;
//   - every record is rebuilt from an explicit allow-list of fields, so new or
//     internal fields (bva_parsed_source, validation warnings, overrides,
//     reviewer identity, checklists, notes, qb_account_names, ...) can never
//     leak by default;
//   - bank account numbers are masked out of public transfer labels;
//   - drill-downs resolve the budget line on the server and use its stored
//     account names, never names supplied by the caller.
//
// Missing vs zero: a missing figure is served as null (unknown) — never as a
// fabricated 0. A stored 0 (an explicit, confirmed zero) is served as 0.

import { transactionsForCategory } from './categoryTransactionsCore.ts';
import { effectiveRecord } from './sourceMissing.ts';
import { currentPublished, isCurrentPublished, monthState, isSuperseded, isDiscarded } from './periodVersions.ts';

export const isPublishedFinal = (p) => !!p && !!p.published && p.status === 'final';

export const PUBLIC_PERIOD_FIELDS = [
  'id', 'label', 'month', 'year', 'start_date', 'end_date', 'status', 'published', 'months_elapsed',
  'reporting_cutoff_date', 'publication_date', 'last_updated', 'total_cash', 'ytd_income', 'ytd_expenses',
  'month_income', 'month_expenses', 'distributions_ytd', 'savings_in_ytd', 'savings_spend_ytd',
  'annual_budgeted_income', 'annual_budgeted_expenses', 'monthly_income_budget',
];

// null / blank / non-numeric -> null (unknown); a stored 0 stays 0.
const numOrNull = (v) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || !Number.isFinite(Number(v)) ? null : Number(v);

// A field listed in source_missing_fields is served as missing (null), never
// as the stale number behind it. The list itself is not served.
export const publicPeriod = (raw) => publicPeriodFields(effectiveRecord(raw));
const publicPeriodFields = (p) => ({
  id: p.id,
  label: p.label,
  month: p.month,
  year: p.year,
  start_date: p.start_date || null,
  end_date: p.end_date || null,
  status: p.status,
  published: !!p.published,
  months_elapsed: numOrNull(p.months_elapsed),
  reporting_cutoff_date: p.reporting_cutoff_date || null,
  publication_date: p.publication_date || null,
  last_updated: p.last_updated || null,
  total_cash: numOrNull(p.total_cash),
  ytd_income: numOrNull(p.ytd_income),
  ytd_expenses: numOrNull(p.ytd_expenses),
  month_income: numOrNull(p.month_income),
  month_expenses: numOrNull(p.month_expenses),
  distributions_ytd: numOrNull(p.distributions_ytd),
  savings_in_ytd: numOrNull(p.savings_in_ytd),
  savings_spend_ytd: numOrNull(p.savings_spend_ytd),
  annual_budgeted_income: numOrNull(p.annual_budgeted_income),
  annual_budgeted_expenses: numOrNull(p.annual_budgeted_expenses),
  monthly_income_budget: numOrNull(p.monthly_income_budget),
});

// qb_account_names is deliberately absent: drill-downs now resolve account
// names on the server from the stored line (see handlePublicCategoryRequest).
export const publicBudgetLine = (l) => ({
  id: l.id,
  category: l.category,
  qb_code: l.qb_code || null,
  budget_group: l.budget_group,
  month_actual: numOrNull(l.month_actual),
  ytd_actual: numOrNull(l.ytd_actual),
  annual_budget: numOrNull(l.annual_budget),
  monthly_budget: numOrNull(l.monthly_budget),
  bva_detail: !!l.bva_detail,
  group_confirmed: !!l.group_confirmed,
  drilldown_enabled: l.drilldown_enabled !== false,
});

export const publicCashAccount = (a) => ({
  id: a.id,
  name: a.name,
  balance: numOrNull(a.balance),
  account_type: a.account_type === 'investment' ? 'investment' : 'bank',
  as_of_date: a.as_of_date || null,
  sort_order: Number(a.sort_order || 0),
});

export const publicDistribution = (d) => ({
  id: d.id,
  entity_name: d.entity_name || '',
  q1: numOrNull(d.q1),
  q2: numOrNull(d.q2),
  q3: numOrNull(d.q3),
  q4: numOrNull(d.q4),
});

export const publicSavingsSpend = (s) => ({ id: s.id, category: s.category, ytd_amount: numOrNull(s.ytd_amount) });

// Any run of 3+ digits in a transfer's source label is treated as an account
// number and replaced with "••••". If two different labels become identical
// after masking, each gets a stable letter (ordered by the original label) so
// the client can still tell the accounts apart.
const ACCOUNT_DIGITS = /\d{3,}/g;
export const maskAccountNumbers = (label) => (label == null ? null : String(label).replace(ACCOUNT_DIGITS, '••••'));

export function maskTransferSources(sources) {
  const originals = [...new Set(sources.filter((s) => s != null).map(String))].sort();
  const byMasked = new Map();
  for (const o of originals) {
    const m = maskAccountNumbers(o);
    byMasked.set(m, [...(byMasked.get(m) || []), o]);
  }
  const out = new Map();
  for (const [masked, group] of byMasked) {
    group.forEach((o, i) => out.set(o, group.length > 1 ? `${masked} (${String.fromCharCode(65 + i)})` : masked));
  }
  return (s) => (s == null ? null : out.get(String(s)));
}

export function publicTransfers(transfers) {
  const visible = transfers.filter((t) => t.visible_to_client !== false);
  const label = maskTransferSources(visible.map((t) => t.source));
  return visible.map((t) => ({ id: t.id, amount: numOrNull(t.amount), source: label(t.source || null), purpose: t.purpose || null }));
}

const EMPTY = { periods: [], period: null, budgetLines: [], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [] };

// Whole publicDashboard response. `svc` is base44.asServiceRole.
export async function buildPublicDashboard(svc, body = {}) {
  const all = await svc.entities.ReportingPeriod.list('-year', 500);
  // One report per month: the current published version (draft revisions,
  // superseded and discarded versions are never served -- periodVersions.ts).
  const published = currentPublished(all);
  if (!published.length) return EMPTY;

  // A requested period is honored only when it is published; anything else
  // falls back to the most recent published period.
  const period = (body.period_id && published.find((p) => p.id === body.period_id)) || published[0];

  const [budgetLines, cashAccounts, distributions, transfers, savingsSpends] = await Promise.all([
    svc.entities.BudgetLine.filter({ period_id: period.id }, undefined, 5000),
    svc.entities.CashAccount.filter({ period_id: period.id }, 'sort_order', 500),
    svc.entities.Distribution.filter({ period_id: period.id }, undefined, 500),
    svc.entities.RecurringTransfer.filter({ period_id: period.id }, undefined, 500),
    svc.entities.SavingsSpend.filter({ period_id: period.id }, undefined, 500),
  ]);

  return {
    periods: published.map(publicPeriod),
    period: publicPeriod(period),
    budgetLines: budgetLines.map(publicBudgetLine),
    cashAccounts: cashAccounts.map(publicCashAccount),
    distributions: distributions.map(publicDistribution),
    transfers: publicTransfers(transfers),
    savingsSpends: savingsSpends.map(publicSavingsSpend),
  };
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Find the budget line a drill-down asks for, on the server. Prefer the line
// id; fall back to an exact (case-insensitive) category match within the same
// period for older clients.
export async function resolveLine(svc, periodId, { budget_line_id, category } = {}) {
  const lines = await svc.entities.BudgetLine.filter({ period_id: periodId }, undefined, 5000);
  if (budget_line_id) return lines.find((l) => l.id === budget_line_id) || null;
  if (category) return lines.find((l) => norm(l.category) === norm(category)) || null;
  return null;
}

const reply = (status, body) => ({ status, body });

// Drill-down for anonymous visitors (and signed-in non-admins).
//
// Transaction fields a client may receive: an explicit allowlist. No
// transaction-detail source is approved for clients yet, and detail will be
// offered only to authenticated client users -- never through this anonymous
// endpoint -- so the allowlist is EMPTY: the response carries no transaction
// rows and this handler does not read transactions at all. Adding a field
// needs the owner's approval of an authoritative export and of the field.
export const PUBLIC_TRANSACTION_FIELDS: string[] = [];
// Never client-visible, whatever is approved later.
export const NEVER_CLIENT_TRANSACTION_FIELDS = [
  'id', 'period_id', 'internal_notes', 'review_status', 'review_flags', 'reviewed_by',
  'qb_transaction_id', 'qb_account', 'account_id', 'full_account_path', 'copied_from', 'source', 'treatment',
];
export const PUBLIC_DRILLDOWN_KEYS = ['period_id', 'category', 'detail_available', 'transactions'];

// Published and final periods only, and only the month's current version
// (draft revisions and replaced versions are refused); the line is resolved
// on the server.
export async function handlePublicCategoryRequest(base44, body = {}) {
  const svc = base44.asServiceRole;
  const { period_id } = body;
  if (!period_id) return reply(400, { error: 'period_id required' });
  if (!body.budget_line_id && !body.category) return reply(400, { error: 'budget_line_id or category required' });

  const period = await svc.entities.ReportingPeriod.get(period_id);
  if (!period) return reply(404, { error: 'Period not found' });
  if (!isPublishedFinal(period)) return reply(403, { error: 'Period not published' });
  // Only the month's current version: a version just replaced by a published
  // revision (still awaiting cleanup) is not served.
  const sameMonth = await svc.entities.ReportingPeriod.filter({ month: period.month, year: period.year }, undefined, 200);
  if (!isCurrentPublished(Array.isArray(sameMonth) ? sameMonth : [], period)) return reply(403, { error: 'Period not published' });

  const line = await resolveLine(svc, period.id, body);
  if (!line || line.drilldown_enabled === false) return reply(404, { error: 'Category not available' });

  // PUBLIC_TRANSACTION_FIELDS is empty: no rows, and no transaction reads.
  return reply(200, { period_id: period.id, category: line.category, detail_available: false, transactions: [] });
}

// Signed-in drill-down: admins keep full access to any period (including
// drafts under review); every other signed-in user gets exactly the public
// rules above.
export async function handleCategoryTransactionsRequest(base44, body = {}, user) {
  if (!user) return reply(401, { error: 'Unauthorized' });
  if (user.role !== 'admin') return handlePublicCategoryRequest(base44, body);

  const { period_id, category, qb_account_names } = body;
  if (!period_id) return reply(400, { error: 'period_id required' });
  if (!category) return reply(400, { error: 'category required' });
  const period = await base44.asServiceRole.entities.ReportingPeriod.get(period_id);
  if (!period) return reply(404, { error: 'Period not found' });
  // A replaced (superseded, or awaiting supersede cleanup) or discarded version
  // never supplies transaction rows -- not even to an admin.
  const versions = await base44.asServiceRole.entities.ReportingPeriod.filter({ month: period.month, year: period.year }, undefined, 200);
  const state = monthState(Array.isArray(versions) ? versions : []);
  if (isSuperseded(period) || isDiscarded(period) || state.pendingCleanup.some((v) => v.id === period.id)) {
    return reply(409, { error: 'This version was replaced by a newer one; open the current version.', code: 'superseded_version' });
  }
  return reply(200, await transactionsForCategory(base44, period, category, qb_account_names));
}
