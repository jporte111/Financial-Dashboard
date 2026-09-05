import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Public (no-login) dashboard data for the client view at /client (and the
// connected custom domain). Anyone can reach this endpoint, so it exposes ONLY:
//   - periods that are published AND final
//   - client-visible fields — internal notes, review flags, validation
//     warnings, workbook provenance and reviewer identity are stripped here and
//     never leave the server.
// The frontend feeds the returned records straight into buildBvaDashboard
// (the same view-model builder the logged-in Dashboard uses), so every figure
// the client sees is computed by the identical, single roll-up engine.

const publicPeriod = (p) => ({
  id: p.id,
  label: p.label,
  month: p.month,
  year: p.year,
  start_date: p.start_date || null,
  end_date: p.end_date || null,
  status: p.status,
  published: !!p.published,
  months_elapsed: p.months_elapsed != null ? Number(p.months_elapsed) : null,
  reporting_cutoff_date: p.reporting_cutoff_date || null,
  publication_date: p.publication_date || null,
  last_updated: p.last_updated || null,
  total_cash: p.total_cash != null ? Number(p.total_cash) : null,
  ytd_income: p.ytd_income != null ? Number(p.ytd_income) : null,
  ytd_expenses: p.ytd_expenses != null ? Number(p.ytd_expenses) : null,
  month_income: p.month_income != null ? Number(p.month_income) : null,
  month_expenses: p.month_expenses != null ? Number(p.month_expenses) : null,
  distributions_ytd: p.distributions_ytd != null ? Number(p.distributions_ytd) : null,
  savings_in_ytd: p.savings_in_ytd != null ? Number(p.savings_in_ytd) : null,
  savings_spend_ytd: p.savings_spend_ytd != null ? Number(p.savings_spend_ytd) : null,
  annual_budgeted_income: p.annual_budgeted_income != null ? Number(p.annual_budgeted_income) : null,
  annual_budgeted_expenses: p.annual_budgeted_expenses != null ? Number(p.annual_budgeted_expenses) : null,
  monthly_income_budget: p.monthly_income_budget != null ? Number(p.monthly_income_budget) : null,
});

const publicBudgetLine = (l) => ({
  id: l.id,
  category: l.category,
  qb_code: l.qb_code || null,
  qb_account_names: Array.isArray(l.qb_account_names) ? l.qb_account_names : [],
  budget_group: l.budget_group,
  month_actual: Number(l.month_actual || 0),
  ytd_actual: Number(l.ytd_actual || 0),
  annual_budget: Number(l.annual_budget || 0),
  monthly_budget: l.monthly_budget != null ? Number(l.monthly_budget) : null,
  bva_detail: !!l.bva_detail,
  group_confirmed: !!l.group_confirmed,
  drilldown_enabled: l.drilldown_enabled !== false,
});

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    let body = {};
    try { body = await req.json(); } catch { body = {}; }

    const all = await svc.entities.ReportingPeriod.list('-year', 500);
    const published = all
      .filter((p) => p.published && p.status === 'final')
      .sort((a, b) => b.year - a.year || b.month - a.month);

    if (!published.length) {
      return Response.json({ periods: [], period: null, budgetLines: [], cashAccounts: [], distributions: [], transfers: [], savingsSpends: [] });
    }

    // Requested period is honored only when it is published; anything else
    // falls back to the most recent published period.
    const period = (body.period_id && published.find((p) => p.id === body.period_id)) || published[0];

    const [budgetLines, cashAccounts, distributions, transfers, savingsSpends] = await Promise.all([
      svc.entities.BudgetLine.filter({ period_id: period.id }, undefined, 5000),
      svc.entities.CashAccount.filter({ period_id: period.id }, 'sort_order', 500),
      svc.entities.Distribution.filter({ period_id: period.id }, undefined, 500),
      svc.entities.RecurringTransfer.filter({ period_id: period.id }, undefined, 500),
      svc.entities.SavingsSpend.filter({ period_id: period.id }, undefined, 500),
    ]);

    return Response.json({
      periods: published.map(publicPeriod),
      period: publicPeriod(period),
      budgetLines: budgetLines.map(publicBudgetLine),
      cashAccounts: cashAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        balance: Number(a.balance || 0),
        account_type: a.account_type === 'investment' ? 'investment' : 'bank',
        as_of_date: a.as_of_date || null,
        sort_order: Number(a.sort_order || 0),
      })),
      distributions: distributions.map((d) => ({
        id: d.id,
        entity_name: d.entity_name || '',
        q1: Number(d.q1 || 0),
        q2: Number(d.q2 || 0),
        q3: Number(d.q3 || 0),
        q4: Number(d.q4 || 0),
      })),
      // Client-visible transfers only — the visible_to_client flag is applied
      // here, at the source, so hidden internal transfers never leave the server.
      transfers: transfers
        .filter((t) => t.visible_to_client !== false)
        .map((t) => ({ id: t.id, amount: Number(t.amount || 0), source: t.source || null, purpose: t.purpose || null })),
      savingsSpends: savingsSpends.map((s) => ({ id: s.id, category: s.category, ytd_amount: Number(s.ytd_amount || 0) })),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}