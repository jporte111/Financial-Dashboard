// Month-over-month trend (Phase 7). Pure: builds the trend from the months the
// caller passes -- which must be the CURRENT PUBLISHED version of each month
// (periodVersions.currentPublished), so drafts, superseded and discarded
// versions never appear. Each point is exactly what that month's own page
// shows (monthFigures.ts). Year-to-date only; no monthly figures are derived.
//
//   - Points are aligned by the month the DATA covers (the reporting cutoff;
//     a legacy month without one covers its elapsed months), not by the report
//     name: a report titled August with data through July 31 is a July point.
//   - When two published reports cover the same data month, the LATER report
//     is shown and a note says it supersedes the earlier snapshot.
//   - Year-to-date figures restart each year: only the latest data year is
//     shown.
//   - A missing figure is null (a gap), never 0; percentages need both parts.
//   - Months not validated through a BVA import are marked "before BVA
//     reporting".
//   - An annual budget that differs from the previous point that had one is
//     noted as revised (one note per report; not across the switch to BVA
//     reporting, which is a change of method).

import { monthFigures, EXPENSE_GROUPS } from './monthFigures.ts';
import { cutoffIndex } from './crossPeriod.ts';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUP_LABEL: Record<string, string> = { fixed: 'Fixed', variable: 'Variable', discretionary: 'Discretionary' };
const ymLabel = (idx: number) => `${MONTH_SHORT[idx % 12]} ${Math.floor(idx / 12)}`;
const cents = (v: any) => (v == null ? null : Math.round(Number(v) * 100));
const ratio = (a: any, b: any) => (a == null || b == null || Number(b) === 0 ? null : Number(a) / Number(b));
const differs = (a: any, b: any) => a != null && b != null && cents(a) !== cents(b);

// entries: [{ id, label, month, year, legacy, period, lines, cashAccounts, distributions }]
// where `period` has missing fields already applied (public payload shape).
export function buildTrend(entries: any[]) {
  const rows = (entries || []).map((e) => {
    const p = e.period;
    const idx = cutoffIndex(p) ?? (Number.isInteger(Number(p.year)) && Number(p.month) >= 1 ? Number(p.year) * 12 + Number(p.month) - 1 : null);
    return { e, idx, reportOrder: Number(e.year) * 12 + Number(e.month), f: monthFigures({ period: p, lines: e.lines || [], cashAccounts: e.cashAccounts || [], distributions: e.distributions || [] }) };
  }).filter((r) => r.idx != null);
  if (!rows.length) return { year: null, points: [], explanations: [], cashSinceLast: null };

  // One point per data month: the later report wins.
  const byIdx = new Map<number, any[]>();
  for (const r of rows) byIdx.set(r.idx!, [...(byIdx.get(r.idx!) || []), r]);
  const year = Math.floor(Math.max(...byIdx.keys()) / 12);
  const explanations: string[] = [];
  const chosen = [...byIdx.entries()].filter(([idx]) => Math.floor(idx / 12) === year).sort((a, b) => a[0] - b[0]).map(([idx, list]) => {
    const sorted = [...list].sort((a, b) => b.reportOrder - a.reportOrder);
    const [win, ...older] = sorted;
    for (const o of older) {
      explanations.push(`${ymLabel(idx)} data is shown from the ${win.e.label} report${win.e.legacy ? '' : ' (BVA)'}; it supersedes the earlier ${o.e.legacy ? 'legacy ' : ''}${o.e.label} snapshot.`);
    }
    return { idx, r: win, supersedes: older.map((o) => o.e.label) };
  });

  const points = chosen.map(({ idx, r, supersedes }) => {
    const f = r.f;
    const groups = Object.fromEntries(EXPENSE_GROUPS.map((g) => [g, { ytd: f.groups[g].ytd, budget: f.groups[g].budget, pctUsed: ratio(f.groups[g].ytd, f.groups[g].budget) }]));
    const hasBudget = f.expenses.budget != null;
    return {
      dataMonth: ymLabel(idx),
      dataMonthIndex: idx,
      reportId: r.e.id,
      reportLabel: r.e.label,
      beforeBva: !!r.e.legacy,
      supersedes,
      income: { ytd: f.income.ytd, budget: f.income.budget, pctReceived: ratio(f.income.ytd, f.income.budget) },
      expenses: { ytd: f.expenses.ytd, budget: f.expenses.budget, pctUsed: ratio(f.expenses.ytd, f.expenses.budget) },
      // Expected pace only means something against an annual budget.
      expectedPacePct: hasBudget ? f.pacePct : null,
      groups,
      distributionsYtd: f.distributions.ytd,
      cash: f.cash.total,
      cashPartial: f.cash.partial,
    };
  });

  // Budget revisions, against the previous point that carried a budget -- one
  // note per report. Budgets are not compared across the switch from
  // "before BVA reporting" to BVA reporting: that is a change of method, not
  // a revision.
  const lastBudget: Record<string, any> = {};
  let lastBeforeBva: boolean | null = null;
  for (const pt of points) {
    if (lastBeforeBva !== null && lastBeforeBva !== pt.beforeBva) for (const k of Object.keys(lastBudget)) delete lastBudget[k];
    lastBeforeBva = pt.beforeBva;
    const revised: string[] = [];
    const check = (key: string, label: string, value: any) => {
      if (value == null) return;
      if (differs(lastBudget[key], value)) revised.push(label);
      lastBudget[key] = value;
    };
    check('expenses', 'expenses', pt.expenses.budget);
    check('income', 'income', pt.income.budget);
    for (const g of EXPENSE_GROUPS) check(g, GROUP_LABEL[g], pt.groups[g].budget);
    if (revised.length) explanations.push(`Annual budget revised in the ${pt.reportLabel} report (${pt.dataMonth} data): ${revised.join(', ')}.`);
  }
  if (points.some((p) => p.beforeBva)) explanations.push('Months marked "before BVA reporting" were not validated through a BVA workbook import.');
  if (points.some((p) => p.expenses.budget == null)) explanations.push('No budget or pace is shown for a month without an annual budget.');
  const anyGap = points.some((p) => [p.income.ytd, p.expenses.ytd, p.distributionsYtd, p.cash, ...EXPENSE_GROUPS.map((g) => p.groups[g].ytd)].some((v) => v == null));
  if (anyGap) explanations.push('— means the figure is not in that month\'s workbook. It is left as a gap, never counted as $0.');

  // Cash since the previous report (both balances known).
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const cashSinceLast = last && prev && last.cash != null && prev.cash != null && !last.cashPartial && !prev.cashPartial
    ? { amount: Math.round((last.cash - prev.cash) * 100) / 100, current: last.cash, sinceReport: prev.reportLabel, sinceDataMonth: prev.dataMonth, toReport: last.reportLabel }
    : null;

  return { year, points, explanations, cashSinceLast };
}
