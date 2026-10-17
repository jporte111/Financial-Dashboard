// What changed between the report clients see now (or the draft being
// updated) and an uploaded workbook -- the updated-BVA workflow.
//
// Headline figures go through the same calculation the month page uses
// (base44/shared/monthFigures.ts), so "before" is what the page shows today
// and "after" is what it will show. Lines, cash accounts, distributions and
// transfers are compared figure by figure. A missing value is null (shown as
// "—"), never 0; missing -> value and value -> missing are changes.
import { monthFigures } from '../../base44/shared/monthFigures.ts';
import { effectiveRecord } from '../../base44/shared/sourceMissing.ts';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const same = (a, b) => num(a) === num(b);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const GROUP = { fixed: 'Fixed', variable: 'Variable', discretionary: 'Discretionary', income: 'Income', savings: 'Savings', unassigned: 'Unassigned' };

// Stable keys, as the importer matches rows (bvaImport.js lineKey).
const lineKey = (l) => (l.bva_detail ? `d:${norm(l.qb_code) || norm(l.category)}` : l.budget_group === 'income' ? `i:${norm(l.qb_code) || norm(l.category)}` : `g:${l.budget_group}`);
const lineName = (l) => `${l.qb_code ? `${l.qb_code} ` : ''}${l.category}`;

function compareRows(before, after, keyOf, nameOf, fields) {
  const b = new Map((before || []).map((r) => [keyOf(r), r]));
  const a = new Map((after || []).map((r) => [keyOf(r), r]));
  const changed = [];
  for (const [k, ar] of a) {
    const br = b.get(k);
    if (!br) continue;
    for (const [f, label, kind] of fields) {
      const x = br[f], y = ar[f];
      const differs = kind === 'text' ? norm(x) !== norm(y) : !same(x, y);
      if (differs) changed.push({ name: nameOf(ar), field: label, before: kind === 'text' ? (x || null) : num(x), after: kind === 'text' ? (y || null) : num(y), kind });
    }
  }
  return {
    changed,
    added: [...a.keys()].filter((k) => !b.has(k)).map((k) => nameOf(a.get(k))),
    removed: [...b.keys()].filter((k) => !a.has(k)).map((k) => nameOf(b.get(k))),
    compared: [...a.keys()].filter((k) => b.has(k)).length,
  };
}

// before / after: { period, lines, cashAccounts, distributions, transfers }
export function changeSummary(before, after) {
  const fb = monthFigures({ period: effectiveRecord(before.period || {}), lines: before.lines || [], cashAccounts: before.cashAccounts || [], distributions: before.distributions || [] });
  const fa = monthFigures({ period: effectiveRecord(after.period || {}), lines: after.lines || [], cashAccounts: after.cashAccounts || [], distributions: after.distributions || [] });
  const headline = [
    ['Total Cash', fb.cash.total, fa.cash.total],
    ['YTD income', fb.income.ytd, fa.income.ytd],
    ['Annual income budget', fb.income.budget, fa.income.budget],
    ['YTD expenses', fb.expenses.ytd, fa.expenses.ytd],
    ['Annual expense budget', fb.expenses.budget, fa.expenses.budget],
    ['Fixed YTD', fb.groups.fixed.ytd, fa.groups.fixed.ytd],
    ['Variable YTD', fb.groups.variable.ytd, fa.groups.variable.ytd],
    ['Discretionary YTD', fb.groups.discretionary.ytd, fa.groups.discretionary.ytd],
    ['Distributions YTD', fb.distributions.ytd, fa.distributions.ytd],
  ].map(([label, b, a]) => ({ label, before: num(b), after: num(a), changed: !same(b, a) }));

  const lines = compareRows(before.lines, after.lines, lineKey, lineName, [
    ['ytd_actual', 'year to date'], ['annual_budget', 'annual budget'], ['month_actual', 'this month'], ['budget_group', 'group', 'text'],
  ]);
  for (const c of lines.changed) if (c.field === 'group') { c.before = GROUP[c.before] || c.before; c.after = GROUP[c.after] || c.after; }
  const cash = compareRows(before.cashAccounts, after.cashAccounts, (r) => norm(r.name), (r) => r.name, [['balance', 'balance']]);
  const distributions = compareRows(before.distributions, after.distributions, (r) => norm(r.entity_name), (r) => r.entity_name, [
    ['q1', 'Q1'], ['q2', 'Q2'], ['q3', 'Q3'], ['q4', 'Q4'], ['workbook_ytd', 'printed YTD'],
  ]);
  const transfers = compareRows(before.transfers, after.transfers, (r) => `${norm(r.source)}|${norm(r.purpose)}`, (r) => r.purpose || r.source || 'Transfer', [['amount', 'amount']]);
  const cutoffBefore = before.period?.reporting_cutoff_date || null, cutoffAfter = after.period?.reporting_cutoff_date || null;
  const cutoff = (cutoffBefore || null) !== (cutoffAfter || null) ? { before: cutoffBefore, after: cutoffAfter } : null;

  const sections = { lines, cash, distributions, transfers };
  const rowChanges = Object.values(sections).reduce((n, s) => n + s.changed.length + s.added.length + s.removed.length, 0);
  const headlineChanges = headline.filter((h) => h.changed).length;
  const totalChanges = rowChanges + headlineChanges + (cutoff ? 1 : 0);
  const unchanged = Object.values(sections).reduce((n, s) => n + s.compared, 0) - new Set(Object.values(sections).flatMap((s) => s.changed.map((c) => c.name))).size;
  return { headline, ...sections, cutoff, totalChanges, headlineChanges, unchanged, identical: totalChanges === 0 };
}

// The "after" side from an import plan (what the import will write).
export function planRecords(plan) {
  return {
    period: plan.periodData,
    lines: plan.budgetLines.toCreate.concat(plan.budgetLines.toUpdate.map((u) => u.data)),
    cashAccounts: plan.cashAccounts.toCreate.concat(plan.cashAccounts.toUpdate.map((u) => u.data)),
    distributions: plan.distributions.toCreate.concat(plan.distributions.toUpdate.map((u) => u.data)),
    transfers: plan.transfers.toCreate.concat(plan.transfers.toUpdate.map((u) => u.data)),
  };
}

// Manual corrections recorded on the version being replaced or updated that
// are NOT carried to a newly uploaded workbook (only confirmed watch-list
// classifications are). Savings entries are not workbook figures; the
// version's savings values stay as they are.
export function previousCorrections(corrections) {
  const list = Array.isArray(corrections) ? corrections : [];
  return {
    notApplied: list.filter((c) => c && c.kind !== 'group' && c.kind !== 'savings'),
    savingsKept: list.filter((c) => c && c.kind === 'savings'),
    groupsCarried: list.filter((c) => c && c.kind === 'group'),
  };
}
