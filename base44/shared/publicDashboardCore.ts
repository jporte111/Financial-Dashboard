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
// Numeric handling is intentionally unchanged here (missing-vs-zero is a
// separate, later change) so this module alters no figure the client sees.

import { transactionsForCategory } from './categoryTransactionsCore.ts';
import { effectiveRecord } from './sourceMissing.ts';

export const isPublishedFinal = (p) => !!p && !!p.published && p.status === 'final';

export const PUBLIC_PERIOD_FIELDS = [
  'id', 'label', 'month', 'year', 'start_date', 'end_date', 'status', 'published', 'months_elapsed',
  'reporting_cutoff_date', 'publication_date', 'last_updated', 'total_cash', 'ytd_income', 'ytd_expenses',
  'month_income', 'month_expenses', 'distributions_ytd', 'savings_in_ytd', 'savings_spend_ytd',
  'annual_budgeted_income', 'annual_budgeted_expenses', 'monthly_income_budget',
];

const numOrNull = (v) => (v != null ? Number(v) : null);

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
  month_actual: Number(l.month_actual || 0),
  ytd_actual: Number(l.ytd_actual || 0),
  annual_budget: Number(l.annual_budget || 0),
  monthly_budget: numOrNull(l.monthly_budget),
  bva_detail: !!l.bva_detail,
  group_confirmed: !!l.group_confirmed,
  drilldown_enabled: l.drilldown_enabled !== false,
});

export const publicCashAccount = (a) => ({
  id: a.id,
  name: a.name,
  balance: Number(a.balance || 0),
  account_type: a.account_type === 'investment' ? 'investment' : 'bank',
  as_of_date: a.as_of_date || null,
  sort_order: Number(a.sort_order || 0),
});

export const publicDistribution = (d) => ({
  id: d.id,
  entity_name: d.entity_name || '',
  q1: Number(d.q1 || 0),
  q2: Number(d.q2 || 0),
  q3: Number(d.q3 || 0),
  q4: Number(d.q4 || 0),
});

export const publicSavingsSpend = (s) => ({ id: s.id, category: s.category, ytd_amount: Number(s.ytd_amount || 0) });

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
  return visible.map((t) => ({ id: t.id, amount: Number(t.amount || 0), source: label(t.source || null), purpose: t.purpose || null }));
}

const EMPTY = { periods: [], period: null, budgetLines: [], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [] };

// Whole publicDashboard response. `svc` is base44.asServiceRole.
export async function buildPublicDashboard(svc, body = {}) {
  const all = await svc.entities.ReportingPeriod.list('-year', 500);
  const published = all.filter(isPublishedFinal).sort((a, b) => b.year - a.year || b.month - a.month);
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

// Drill-down for anonymous visitors (and signed-in non-admins): published and
// final periods only, the line resolved server-side, account names taken from
// the stored line, YTD built from published periods only, public row fields.
export async function handlePublicCategoryRequest(base44, body = {}) {
  const svc = base44.asServiceRole;
  const { period_id } = body;
  if (!period_id) return reply(400, { error: 'period_id required' });
  if (!body.budget_line_id && !body.category) return reply(400, { error: 'budget_line_id or category required' });

  const period = await svc.entities.ReportingPeriod.get(period_id);
  if (!period) return reply(404, { error: 'Period not found' });
  if (!isPublishedFinal(period)) return reply(403, { error: 'Period not published' });

  const line = await resolveLine(svc, period.id, body);
  if (!line || line.drilldown_enabled === false) return reply(404, { error: 'Category not available' });

  const names = Array.isArray(line.qb_account_names) ? line.qb_account_names : [];
  return reply(200, await transactionsForCategory(base44, period, line.category, names, { publishedOnly: true, publicRows: true }));
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
  return reply(200, await transactionsForCategory(base44, period, category, qb_account_names));
}
