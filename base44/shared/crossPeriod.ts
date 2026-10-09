// Cross-period checks: compare a period with the version clients see for the
// month before it (and, for information, the month after it). Pure functions;
// the periodTransition backend loads the records and enforces the result at
// check / finalize / publish (see periodTransitionCore.ts). Nothing here writes.
//
// Each finding has a severity:
//   block     must be fixed; cannot be overridden
//   override  blocks finalize / publish until accepted with a written reason
//   warn      shown for review; never blocks
//   info      context (why a comparison was not made)
//
// Rules that keep these checks honest:
//   - The previous period is the CURRENT PUBLISHED version of the latest
//     earlier month (periodVersions.monthState): never a superseded version,
//     one awaiting supersede cleanup, a discarded revision or an open draft.
//   - Periods are aligned by their data cutoff, not by calendar month: a
//     report month may carry the previous month's data.
//   - Year-to-date figures restart each year (by cutoff year); legacy periods
//     (no validated BVA import) are context only.
//   - A missing value is never read as $0.00 (sourceMissing.effectiveRecord):
//     a comparison with a missing side is not made, and says so. An explicit
//     0 is a real value.
//   - Codes carry no amounts, so an accepted reason stays attached to the same
//     finding between finalize and publish.

import { effectiveRecord } from './sourceMissing.ts';
import { monthState, isPublishedFinal } from './periodVersions.ts';

export const CROSS_PERIOD_PREFIX = 'cross_period:';
export const EXPENSE_GROUPS = ['fixed', 'variable', 'discretionary'];
// Differences of at most a dollar are rounding, not a change.
export const TOLERANCE_CENTS = 100;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const cents = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const norm = (s: any) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const monthIndex = (p: any) => Number(p?.year) * 12 + Number(p?.month) - 1;
const pct = (now: number, before: number) => (before ? `${Math.abs(((now - before) / before) * 100).toFixed(1)}%` : 'n/a');
const ymLabel = (idx: number) => `${MONTHS[((idx % 12) + 12) % 12]} ${Math.floor(idx / 12)}`;
const lineGroup = (l: any) => String(l?.budget_group || '').toLowerCase();

// The month index of the last month a period's data covers. A validated
// period carries reporting_cutoff_date; a legacy one only months_elapsed
// (months of the report year).
export function cutoffIndex(p: any): number | null {
  const d = typeof p?.reporting_cutoff_date === 'string' ? p.reporting_cutoff_date.match(/^(\d{4})-(\d{2})-\d{2}/) : null;
  if (d) return Number(d[1]) * 12 + Number(d[2]) - 1;
  const e = Number(p?.months_elapsed);
  if (Number.isInteger(e) && e >= 1 && e <= 12 && Number.isInteger(Number(p?.year))) return Number(p.year) * 12 + e - 1;
  return null;
}
export const isValidated = (p: any) => p?.bva_import_status === 'final';

// The version clients see for the latest month before `period`, and whether
// that month has an open revision or competing published versions.
export function alignedPrevious(periods: any[], period: any) {
  return neighbour(periods, period, -1);
}
// The version clients see for the earliest month after `period`.
export function alignedNext(periods: any[], period: any) {
  return neighbour(periods, period, 1);
}
function neighbour(periods: any[], period: any, dir: -1 | 1) {
  const here = monthIndex(period);
  const months = new Map<number, any[]>();
  for (const p of periods || []) {
    const i = monthIndex(p);
    if (!Number.isFinite(i) || (dir < 0 ? i >= here : i <= here)) continue;
    months.set(i, [...(months.get(i) || []), p]);
  }
  const order = [...months.keys()].sort((a, b) => (dir < 0 ? b - a : a - b));
  for (const i of order) {
    const st = monthState(months.get(i) as any[]);
    if (st.conflict) return { period: null, conflict: st.conflict, openRevision: false, monthIndex: i };
    if (st.current && isPublishedFinal(st.current)) return { period: st.current, conflict: null, openRevision: st.openRevisions.length > 0, monthIndex: i };
  }
  return { period: null, conflict: null, openRevision: false, monthIndex: null };
}

type Side = { period: any; lines?: any[]; distributions?: any[]; transfers?: any[]; cash?: any[] };
type Finding = { code: string; severity: 'block' | 'override' | 'warn' | 'info'; message: string };

// Compare `cur` with `prev` (the aligned previous version, or null).
// ctx: { conflict?, openRevision? } from alignedPrevious.
export function crossPeriodChecks(cur: Side, prev: Side | null, ctx: any = {}): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, message: string) => out.push({ code, severity, message });

  if (ctx.conflict) {
    add('block', 'previous_month_conflict', 'The month before this one has more than one published version. Resolve that first (Review & Publish → Versions).');
    return out;
  }
  if (!prev || !prev.period) {
    add('info', 'no_previous_period', 'No earlier published period to compare with.');
    return out;
  }
  const p = effectiveRecord(prev.period);
  const c = effectiveRecord(cur.period);
  const prevLabel = p.label || 'The previous period';
  if (ctx.openRevision) add('warn', 'previous_has_open_revision', `${prevLabel} has an open draft revision; this comparison uses the version clients see now.`);

  const ci = cutoffIndex(c);
  const pi = cutoffIndex(p);
  if (ci === null || pi === null) {
    add('info', 'cutoff_not_comparable', 'The data cutoff of this period or the previous one is not known; cross-period checks were not run.');
    return out;
  }
  if (ci <= pi) {
    add(isValidated(p) ? 'block' : 'override', 'cutoff_not_after_previous',
      `This period's data runs through ${ymLabel(ci)}, but ${prevLabel} already reports through ${ymLabel(pi)}.`);
    return out;
  }
  if (ci - pi > 1) add('warn', 'month_gap', `${ci - pi - 1} month(s) of data between ${prevLabel} (through ${ymLabel(pi)}) and this period (through ${ymLabel(ci)}) are not reported by any published period.`);
  if (Math.floor(ci / 12) !== Math.floor(pi / 12)) {
    add('info', 'new_year', 'Year-to-date figures restart this year; they are not compared with the previous year.');
    return out;
  }
  if (!isValidated(p)) {
    add('info', 'legacy_previous', `${prevLabel} was not validated through a BVA import; its figures are not compared.`);
    return out;
  }
  const adjacent = ci - pi === 1;

  // ---- Period totals ----------------------------------------------------
  const compare = (field: string, label: string, onDecrease: Finding['severity']) => {
    const a = cents(p[field]), b = cents(c[field]);
    if (a === null || b === null) {
      if (a !== null && b === null && field === 'savings_in_ytd') add('warn', 'savings_in_ytd_missing', `Savings / Distributions In is missing; ${prevLabel} had it.`);
      else add('info', `not_comparable:${field}`, `${label} is missing ${a === null ? `in ${prevLabel}` : 'in this period'}; not compared.`);
      return;
    }
    if (a - b > TOLERANCE_CENTS) add(onDecrease, `${field}_decreased`, `${label} is lower than in ${prevLabel} (by ${pct(b, a)}).`);
  };
  compare('ytd_income', 'Total income year-to-date', 'override');
  compare('ytd_expenses', 'Total expenses year-to-date', 'override');
  compare('distributions_ytd', 'Distributions YTD', 'override');
  compare('savings_in_ytd', 'Savings / Distributions In', 'override');
  for (const [field, label] of [['annual_budgeted_income', 'Annual income budget'], ['annual_budgeted_expenses', 'Annual expense budget']]) {
    const a = cents(p[field]), b = cents(c[field]);
    if (a !== null && b !== null && Math.abs(a - b) > TOLERANCE_CENTS) add('override', `annual_budget_changed:${field}`, `${label} differs from ${prevLabel} (by ${pct(b, a)}).`);
  }
  if (adjacent) {
    for (const [mf, yf, label] of [['month_income', 'ytd_income', 'income'], ['month_expenses', 'ytd_expenses', 'expenses']]) {
      const m = cents(c[mf]), y1 = cents(c[yf]), y0 = cents(p[yf]);
      if (m === null || y1 === null || y0 === null) { add('info', `not_comparable:${mf}`, `This month's ${label} or a year-to-date figure is missing; month vs year-to-date not checked.`); continue; }
      if (Math.abs(m - (y1 - y0)) > TOLERANCE_CENTS) add('override', `month_vs_ytd:${label}`, `This month's ${label} does not equal the change in year-to-date ${label} since ${prevLabel}.`);
    }
  }

  // ---- Expense groups and income lines (summary lines) --------------------
  const summaries = (side: Side) => (side.lines || []).filter((l) => !l.bva_detail);
  const pS = summaries(prev), cS = summaries(cur);
  for (const g of EXPENSE_GROUPS) {
    const a = pS.find((l) => lineGroup(l) === g), b = cS.find((l) => lineGroup(l) === g);
    if (!a || !b) continue; // a missing group is blocked by the publish gate itself
    const ay = cents(a.ytd_actual), by = cents(b.ytd_actual);
    if (ay !== null && by !== null && ay - by > TOLERANCE_CENTS) add('override', `group_ytd_decreased:${g}`, `${g[0].toUpperCase()}${g.slice(1)} year-to-date is lower than in ${prevLabel} (by ${pct(by, ay)}).`);
    const ab = cents(a.annual_budget), bb = cents(b.annual_budget);
    if (ab !== null && bb !== null && Math.abs(ab - bb) > TOLERANCE_CENTS) add('override', `group_budget_changed:${g}`, `The ${g} annual budget differs from ${prevLabel} (by ${pct(bb, ab)}).`);
    if (adjacent) {
      const m = cents(b.month_actual);
      if (m !== null && ay !== null && by !== null && Math.abs(m - (by - ay)) > TOLERANCE_CENTS) add('override', `month_vs_ytd:${g}`, `This month's ${g} figure does not equal the change in ${g} year-to-date since ${prevLabel}.`);
    }
  }
  const key = (l: any) => `${lineGroup(l)}:${norm(l.category)}`;
  for (const b of cS.filter((l) => lineGroup(l) === 'income')) {
    const a = pS.find((l) => key(l) === key(b));
    const ay = cents(a?.ytd_actual), by = cents(b.ytd_actual);
    if (ay !== null && by !== null && ay - by > TOLERANCE_CENTS) add('warn', `income_line_decreased:${norm(b.category)}`, `"${b.category}" year-to-date is lower than in ${prevLabel} (by ${pct(by, ay)}).`);
  }
  const gone = pS.filter((a) => !cS.some((b) => key(b) === key(a)));
  const added = cS.filter((b) => !pS.some((a) => key(a) === key(b)));
  if (gone.length) add('warn', 'lines_removed', `Lines in ${prevLabel} but not in this period: ${gone.map((l) => l.category).join(', ')}.`);
  if (added.length) add('warn', 'lines_added', `Lines new in this period: ${added.map((l) => l.category).join(', ')}.`);

  // ---- Watch-list (DETAIL) rows, keyed by account code ---------------------
  const detail = (side: Side) => new Map((side.lines || []).filter((l) => l.bva_detail && l.qb_code).map((l) => [norm(l.qb_code), l]));
  const pD = detail(prev), cD = detail(cur);
  for (const [code, a] of pD) {
    const b = cD.get(code);
    if (!b) { add('override', `detail_row_missing:${code}`, `Watch-list row ${code} "${a.category}" from ${prevLabel} is missing.`); continue; }
    if (norm(a.category) !== norm(b.category)) add('override', `detail_code_reused:${code}`, `Watch-list code ${code} was "${a.category}" in ${prevLabel} and is "${b.category}" now.`);
    if (a.group_confirmed && b.group_confirmed && lineGroup(a) && lineGroup(b) && lineGroup(a) !== lineGroup(b)) {
      add('override', `detail_group_changed:${code}`, `Watch-list row ${code} "${b.category}" moved from ${lineGroup(a)} to ${lineGroup(b)}.`);
    }
    const ay = cents(a.ytd_actual), by = cents(b.ytd_actual);
    if (ay !== null && by !== null && ay - by > TOLERANCE_CENTS) add('warn', `detail_ytd_decreased:${code}`, `Watch-list row ${code} "${b.category}" year-to-date is lower than in ${prevLabel} (by ${pct(by, ay)}).`);
  }

  // ---- Distributions: closed quarters do not change ------------------------
  const closedThrough = Math.floor(((pi % 12) + 1) / 3); // quarters fully inside the previous cutoff
  const dist = (side: Side) => new Map((side.distributions || []).map((d) => [norm(d.entity_name), d]));
  const pDist = dist(prev), cDist = dist(cur);
  for (const [name, a] of pDist) {
    const b = cDist.get(name);
    if (!b) { add('warn', `distribution_entity_removed:${name}`, `Distribution entity "${a.entity_name}" from ${prevLabel} is not in this period.`); continue; }
    for (let q = 1; q <= closedThrough; q++) {
      const av = cents(a[`q${q}`]), bv = cents(b[`q${q}`]);
      if (av === null) continue;
      if (bv === null) add('block', `closed_quarter_missing:${name}:q${q}`, `"${a.entity_name}" Q${q} (a closed quarter) is blank; ${prevLabel} had a value. A blank is not $0.00.`);
      else if (Math.abs(av - bv) > TOLERANCE_CENTS) add('override', `closed_quarter_changed:${name}:q${q}`, `"${a.entity_name}" Q${q} (a closed quarter) differs from ${prevLabel}.`);
    }
  }

  // ---- Recurring transfers and cash accounts (review only) -----------------
  const tKey = (t: any) => `${norm(t.source)}|${norm(t.purpose)}`;
  const pT = new Set((prev.transfers || []).map(tKey)), cT = new Set((cur.transfers || []).map(tKey));
  const ended = [...pT].filter((k) => !cT.has(k)).length, started = [...cT].filter((k) => !pT.has(k)).length;
  if (ended) add('warn', 'transfers_ended', `${ended} recurring transfer(s) in ${prevLabel} are not in this period.`);
  if (started) add('warn', 'transfers_started', `${started} recurring transfer(s) are new in this period.`);
  const pC = new Set((prev.cash || []).map((x) => norm(x.name))), cC = new Set((cur.cash || []).map((x) => norm(x.name)));
  const cGone = [...pC].filter((k) => !cC.has(k)).length, cNew = [...cC].filter((k) => !pC.has(k)).length;
  if (cGone || cNew) add('warn', 'cash_accounts_changed', `Cash accounts changed since ${prevLabel}: ${cGone} removed, ${cNew} added.`);
  return out;
}

// For a period being finalized or published while a LATER month is already
// published (typically a revision): the later month's figures should still
// follow from this one. Warnings only -- later months are never changed here.
export function laterMonthChecks(cur: Side, next: Side | null): Finding[] {
  if (!next || !next.period) return [];
  const n = effectiveRecord(next.period), c = effectiveRecord(cur.period);
  const ni = cutoffIndex(n), ci = cutoffIndex(c);
  const label = n.label || 'A later period';
  const out: Finding[] = [];
  if (ni === null || ci === null || !isValidated(n)) return out;
  if (ni <= ci) return [{ code: 'later_month_cutoff', severity: 'warn', message: `${label} reports data through ${ymLabel(ni)}, not after this period (through ${ymLabel(ci)}).` }];
  if (Math.floor(ni / 12) !== Math.floor(ci / 12)) return out;
  for (const [field, l] of [['ytd_income', 'total income year-to-date'], ['ytd_expenses', 'total expenses year-to-date'], ['distributions_ytd', 'Distributions YTD']]) {
    const a = cents(c[field]), b = cents(n[field]);
    if (a !== null && b !== null && a - b > TOLERANCE_CENTS) out.push({ code: `later_month_behind:${field}`, severity: 'warn', message: `${label} (published) reports lower ${l} than this version; it may need a revision too.` });
  }
  return out;
}

// The finding that stands in for every check when the records needed could
// not be loaded: fail closed.
export const UNAVAILABLE: Finding = {
  code: 'checks_unavailable',
  severity: 'block',
  message: 'Cross-period checks could not run because an earlier period could not be loaded. Nothing was changed. Try again in a moment.',
};
