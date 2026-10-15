// October cleanup hosted staging test: the grouped review (item 6) and missing
// figures (item 1) on the hosted backend.
// STAGING APP ONLY, fictional data. Run from the staging checkout with its
// owner-only .staging.env:  node scripts/verify-staging-crossperiod.mjs
// Each scenario uses its own unused fictional year. A legacy month (no
// validated import) cannot be created through the app any more, so it is
// SIMULATED with an owner-privileged write on the staging app.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@base44/sdk';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';

const STAGING = '6ac5040ff86172a58191d35a';
const PRODUCTION = '6a80ccf1dac2259ae9870f29';
const env = Object.fromEntries(fs.readFileSync('.staging.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const link = fs.readFileSync('base44/.app.jsonc', 'utf8');
if (env.STAGING_APP_ID !== STAGING || !link.includes(STAGING) || link.includes(PRODUCTION)) { console.log('Refusing: not linked to the staging app.'); process.exit(2); }
console.error = () => {};
const log = console.log;
const admin = createClient({ appId: STAGING, token: env.STAGING_TOKEN, requiresAuth: false });
const E = admin.entities;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const privileged = (code) => execFileSync('npx', ['base44', 'exec', '--privileged'], { input: `if (Deno.env.get('BASE44_APP_ID') !== '${STAGING}') throw new Error('not staging');\n${code}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

async function transition(action, period_id, extra = {}) {
  for (let i = 0; ; i++) {
    try { const r = await admin.functions.invoke('periodTransition', { action, period_id, ...extra }); return { status: 200, body: r?.data ?? r }; } catch (e) {
      const status = e?.response?.status ?? e?.status; const body = e?.response?.data ?? e?.data ?? {};
      if ((status === undefined || status === 429 || status >= 500) && i < 4) { await sleep(1000 * (i + 1)); continue; }
      return { status, body };
    }
  }
}
const codes = (r) => (r.body?.blockers || []).map((b) => b.code);
const xcodes = (r) => codes(r).filter((c) => c.startsWith('cross_period:'));
const findings = (r, sev) => (r.body?.cross_period?.findings || []).filter((f) => !sev || f.severity === sev).map((f) => f.code);

// Confirm every checklist item through the server, checking each reply (the
// same rule in every hosted suite): retry only TRANSIENT refusals -- checks that
// could not run (Base44 rate limits), a change not verified as saved, or lines
// the server cannot see yet right after finalize (read lag). Anything else fails.
const transientRefusal = (r) => r.status === 409 && (r.body?.blockers || []).some((b) => b.code === 'checklist_not_saved' || /could not run|could not be evaluated|Budget lines are incomplete/.test(b.message || ''));
async function confirmItem(pid, item) {
  let r = await transition('confirm_checklist', pid, { item });
  for (let i = 0; i < 6 && transientRefusal(r); i++) { await sleep(3700); r = await transition('confirm_checklist', pid, { item }); }
  return r;
}
async function confirmChecklist(pid) {
  for (const item of PUBLISH_CHECKLIST.map(([k]) => k)) {
    const r = await confirmItem(pid, item);
    if (r.status !== 200) throw new Error(`confirm ${item} on ${pid}: ${r.status} ${JSON.stringify(r.body?.blockers || r.body)}`);
  }
}
// A publish refused only because the cross-period checks could not run (Base44
// rate limits -- fail closed) is retried; anything else is returned as is.
async function publishRetry(pid) {
  let p = await transition('publish', pid);
  for (let i = 0; i < 4 && p.status === 409 && (p.body?.blockers || []).some((b) => b.code === 'cross_period:checks_unavailable' || /could not run|could not be evaluated/.test(b.message || '')); i++) { await sleep(6100); p = await transition('publish', pid); }
  return p;
}
// A check taken while the checks could not run (Base44 rate limits) carries no
// comparison by design (fail closed): repeat it until one ran (as the 6c suite does).
async function checkRan(pid) {
  let r;
  for (let i = 0; i < 6; i++) {
    r = await transition('check', pid);
    const ran = r.status === 200 && !r.body?.cross_period?.unavailable && !r.body?.checklist?.unavailable;
    if (ran || r.body?.cross_period === null) return r;
    await sleep(5300);
  }
  return r;
}
// ---- fictional months -----------------------------------------------------
const usedYears = new Set((await E.ReportingPeriod.list('-year', 1000)).map((p) => p.year));
const freshYear = () => { let y; do y = 3000 + Math.floor(Math.random() * 6000); while (usedYears.has(y)); usedYears.add(y); return y; };
const mm = (m) => String(m).padStart(2, '0');
// Data through the previous month end (report-month convention); figures grow steadily.
function periodData(year, month, over = {}) {
  const k = month - 1;
  return {
    label: `ZZ TEST GR ${month}/${year}`, month, year, reporting_cutoff_date: `${year}-${mm(k)}-28`, months_elapsed: k,
    ytd_income: 1013 * k, ytd_expenses: 811 * k, month_income: 1013, month_expenses: 811, distributions_ytd: 307, total_cash: 4409,
    annual_budgeted_income: 12157, annual_budgeted_expenses: 9733, bva_parsed_source: { fictional: true }, bva_validation_warnings: [], ...over,
  };
}
const lineData = (k) => [
  { category: 'ZZ Income', budget_group: 'income', ytd_actual: 1013 * k, annual_budget: 12157, month_actual: 1013 },
  { category: 'FIXED', budget_group: 'fixed', ytd_actual: 211 * k, annual_budget: 2533, month_actual: 211 },
  { category: 'VARIABLE', budget_group: 'variable', ytd_actual: 307 * k, annual_budget: 3685, month_actual: 307 },
  { category: 'DISCRETIONARY', budget_group: 'discretionary', ytd_actual: 293 * k, annual_budget: 3515, month_actual: 293 },
];
async function makeMonth(year, month, { period = {}, dist = { q1: 101, q2: 203 }, publish = true, finalize = true } = {}) {
  const c = await transition('create', null, { data: periodData(year, month, period) });
  const pid = c.body?.period_id;
  if (!pid) throw new Error(`create ${month}/${year}: ${c.status} ${JSON.stringify(c.body)}`);
  await E.BudgetLine.bulkCreate(lineData(month - 1).map((l) => ({ ...l, period_id: pid })));
  await E.Distribution.create({ period_id: pid, entity_name: 'ZZ Entity', ...dist });
  await E.RecurringTransfer.create({ period_id: pid, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
  await E.CashAccount.create({ period_id: pid, name: 'ZZ Checking', balance: 4409 });
  await visible(pid);
  if (!finalize) return pid;
  const f = await finalizeAfterLag(pid);
  if (f.status !== 200) throw new Error(`finalize ${month}/${year}: ${f.status} ${JSON.stringify(codes(f))}`);
    await confirmChecklist(pid); // checked, transient-only retry
  // Setup only: every confirmation above returned 200; a publish that still
  // reports one as incomplete is a read that has not caught up -- retry it.
  if (publish) { let p = await publishRetry(pid); for (let i = 0; i < 6 && p.status === 409 && codes(p).every((x) => x.startsWith('checklist_incomplete') || x === 'import_incomplete'); i++) { await sleep(4000); p = await publishRetry(pid); } if (p.status !== 200) throw new Error(`publish ${month}/${year}: ${p.status} ${JSON.stringify(codes(p))}`); }
  return pid;
}
// Base44 reads can lag just-created rows: wait until the month's lines and
// child rows are all visible before evaluating it.
async function visible(pid, lines = 4) {
  for (let i = 0; i < 20; i++) {
    const [l, d, t, c] = await Promise.all([E.BudgetLine.filter({ period_id: pid }), E.Distribution.filter({ period_id: pid }), E.RecurringTransfer.filter({ period_id: pid }), E.CashAccount.filter({ period_id: pid })]);
    if (l.length >= lines && d.length && t.length && c.length) return;
    await sleep(500);
  }
  throw new Error('rows not visible');
}
// The function's service-role reads can lag the rows just created (seen on
// hosted Base44): retry while the only refusal is that the lines are not yet visible.
async function finalizeAfterLag(pid, extra = {}) {
  let f = await transition('finalize', pid, extra);
  for (let i = 0; i < 10 && f.status === 409 && codes(f).length === 1 && codes(f)[0] === 'import_incomplete'; i++) { await sleep(1500); f = await transition('finalize', pid, extra); }
  return f;
}
const reason = (list) => Object.fromEntries(list.map((c) => [c, { reason: 'Fictional staging test: accepted deliberately.' }]));

// ---- an October-like month after a clean previous month --------------------
// Fictional: three month-vs-year-to-date mismatches (one upstream cause), a
// revised budget, Total Cash left blank (deferrable at finalize, never
// publishable) and a closed distribution quarter left blank (a hard blocker).
const year = freshYear();
const prevId = await makeMonth(year, 9);
const k = 9;
const lines = lineData(k).map((l) => (l.budget_group === 'income' ? { ...l, month_actual: 1500 } : l.budget_group === 'variable' ? { ...l, month_actual: 400, annual_budget: 3752 } : l));
const c = await transition('create', null, { data: periodData(year, 10, {
  month_income: 1500, month_expenses: 904, annual_budgeted_expenses: 9800, total_cash: undefined, source_missing_fields: ['total_cash'],
}) });
const pid = c.body?.period_id;
if (!pid) throw new Error(`create 10/${year}: ${c.status} ${JSON.stringify(c.body)}`);
await E.BudgetLine.bulkCreate(lines.map((l) => ({ ...l, period_id: pid })));
const dist = await E.Distribution.create({ period_id: pid, entity_name: 'ZZ Entity', q2: 203, q3: 5 });
await E.RecurringTransfer.create({ period_id: pid, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
await E.CashAccount.create({ period_id: pid, name: 'ZZ Checking', balance: 4409 });
await visible(pid);
fs.writeFileSync('.grouped-scenario.json', JSON.stringify({ year, prevId, pid }));

const r = await checkRan(pid);
const causes = r.body?.review?.causes;
check('the server returns the review grouped by cause', Array.isArray(causes) && causes.length > 0, `${causes?.length} causes`);
const by = Object.fromEntries((causes || []).map((x) => [x.key, x]));
const up = by.previous_month_incomplete;
check('several month-vs-YTD mismatches are ONE upstream cause naming the previous month', !!up && up.members.length === 3 && up.title.includes(`9/${year}`) && !by.month_vs_ytd, up ? `${up.members.length} members` : 'missing');
const gaps = by.workbook_gaps;
check('workbook gaps are one cause with a bookkeeper action', !!gaps && /bookkeeper/.test(gaps.action));
check('the blank closed quarter in it stays a hard blocker (not acceptable by reason)', !!gaps && gaps.bucket === 'blockers' && gaps.members.some((m) => m.kind === 'blocker' && m.code.includes('closed_quarter_missing')) && !gaps.acceptable.some((x) => x.includes('closed_quarter_missing')));
check('the blank Total Cash may be deferred at finalize (acceptable by reason)', !!gaps && gaps.acceptable.includes('required_value_missing:total_cash'));
check('the budget revision is one cause', !!by.budget_revision && by.budget_revision.members.length >= 2, by.budget_revision ? `${by.budget_revision.members.length} members` : 'missing');
const flat = (causes || []).flatMap((x) => x.members.map((m) => m.code));
check('every finding appears in exactly one cause', new Set(flat).size === flat.length);

// One reason per cause, saved as one override per overridable member.
// The function's reads can lag just-created lines (import_incomplete): retry
// while that refusal is present, whatever else is refused alongside it.
const finalizeSettled = async (extra) => {
  let r = await finalizeAfterLag(pid, extra);
  for (let i = 0; i < 10 && r.status === 409 && codes(r).includes('import_incomplete'); i++) { await sleep(1500); r = await transition('finalize', pid, extra); }
  return r;
};
const group = reason((causes || []).flatMap((x) => x.acceptable));
let f = await finalizeSettled({ overrides: group });
check('with every group accepted, finalize is refused ONLY by the hard blocker', f.status === 409 && codes(f).length > 0 && codes(f).every((x) => x.includes('closed_quarter_missing')), codes(f).join(','));
f = await finalizeSettled({ overrides: { ...group, ...reason(codes(f)) } });
check('a reason given for the hard blocker changes nothing', f.status === 409 && codes(f).every((x) => x.includes('closed_quarter_missing')));
await E.Distribution.update(dist.id, { q1: 101 });
for (let i = 0; i < 20; i++) { const d = await E.Distribution.filter({ period_id: pid }); if (d[0]?.q1 === 101) break; await sleep(500); }
f = await finalizeAfterLag(pid, { overrides: group });
for (let i = 0; i < 6 && f.status === 409 && codes(f).some((x) => x.includes('closed_quarter_missing') || x.includes('checks_unavailable')); i++) { await sleep(3000); f = await finalizeAfterLag(pid, { overrides: group }); }
check('once the workbook gap is fixed, the same group reasons finalize (Total Cash deferred)', f.status === 200, `${f.status} ${codes(f).join(',')}`);
const p = await publishRetry(pid);
const tc = (p.body?.blockers || []).find((b) => b.code === 'required_value_missing:total_cash');
check('publish is refused: the deferred Total Cash is a non-overridable blocker', p.status === 409 && !!tc && tc.overridable === false, `${p.status}`);
const after = await E.ReportingPeriod.get(pid);
check('the month stays unpublished; Total Cash is still missing, never $0.00', !after.published && (after.total_cash === undefined || after.total_cash === null) && (after.source_missing_fields || []).includes('total_cash'));

const failed = results.filter((x) => !x).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
