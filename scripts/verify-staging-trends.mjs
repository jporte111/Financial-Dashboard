// Hosted staging test for Phase 7: the month-over-month trend served by
// publicDashboard (current published versions only; aligned by data month;
// legacy marked; gaps never zero; each point equals its month page).
// STAGING APP ONLY, fictional data. Run from the staging checkout with its
// owner-only .staging.env:  node scripts/verify-staging-crossperiod.mjs
// Each scenario uses its own unused fictional year. A legacy month (no
// validated import) cannot be created through the app any more, so it is
// SIMULATED with an owner-privileged write on the staging app.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@base44/sdk';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';
import { buildBvaDashboard } from '../src/lib/bvaDashboard.js';
import { withPublishExpect } from '../src/lib/__fixtures__/publishExpect.js';

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
  const body = await withPublishExpect(admin.entities, { action, period_id, ...extra });
  for (let i = 0; ; i++) {
    try { const r = await admin.functions.invoke('periodTransition', body); return { status: 200, body: r?.data ?? r }; } catch (e) {
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
    label: `ZZ TEST TR ${month}/${year}`, month, year, reporting_cutoff_date: `${year}-${mm(k)}-28`, months_elapsed: k,
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
  // A finalize that succeeded but whose reply was lost (staging timeouts) is
  // retried and answered "already final": accept it once the record shows it.
  const finalNow = f.status === 409 && codes(f).join() === 'already_final' && (await E.ReportingPeriod.get(pid)).status === 'final';
  if (f.status !== 200 && !finalNow) throw new Error(`finalize ${month}/${year}: ${f.status} ${JSON.stringify(codes(f))}`);
    await confirmChecklist(pid); // checked, transient-only retry
  // Setup only: every confirmation above returned 200; a publish that still
  // reports one as incomplete is a read that has not caught up -- retry it.
  if (publish) { let p = await publishRetry(pid); for (let i = 0; i < 6 && p.status === 409 && codes(p).every((x) => x.startsWith('checklist_incomplete') || x === 'import_incomplete'); i++) { await sleep(4000); p = await publishRetry(pid); } const pubNow = p.status === 409 && codes(p).join() === 'already_published' && (await E.ReportingPeriod.get(pid)).published === true; if (p.status !== 200 && !pubNow) throw new Error(`publish ${month}/${year}: ${p.status} ${JSON.stringify(codes(p))}`); }
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


// ---- fictional months in a year later than any on staging --------------------
// (the public trend shows the latest data year across all published months)
const year = Math.max(...usedYears) + 1;
if (year > 9999) throw new Error('no later year available on staging');
const served = async (period_id) => { for (let i = 0; i < 5; i++) { try { const r = await admin.functions.invoke('publicDashboard', period_id ? { period_id } : {}); return r?.data ?? r; } catch { await sleep(1500 * (i + 1)); } } return null; };
// Legacy months: their own month's data, no cutoff (SIMULATED published with an
// owner-privileged write, as legacy months cannot be created through the app).
async function legacyMonth(m) {
  const data = periodData(year, m, { months_elapsed: m });
  delete data.reporting_cutoff_date;
  const c = await transition('create', null, { data });
  const pid = c.body?.period_id;
  if (!pid) throw new Error(`create legacy ${m}: ${c.status}`);
  await E.BudgetLine.bulkCreate(lineData(m).map((l) => ({ ...l, period_id: pid })));
  await E.Distribution.create({ period_id: pid, entity_name: 'ZZ Entity', q1: 101 });
  await E.RecurringTransfer.create({ period_id: pid, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
  await E.CashAccount.create({ period_id: pid, name: 'ZZ Checking', balance: 4300 + m });
  await visible(pid);
  privileged(`await base44.entities.ReportingPeriod.update('${pid}', { status: 'final', published: true, publication_date: '${year}-${mm(m + 1)}-02' });`);
  return pid;
}
const jun = await legacyMonth(6);
const jul = await legacyMonth(7);
const aug = await makeMonth(year, 8, { period: { printed_totals: true } }); // data through July 28
// September: Total Cash blank in the workbook (no balances either) and a revised expense budget.
const sepLines = lineData(8).map((l) => (l.budget_group === 'variable' ? { ...l, annual_budget: 3752 } : l));
const c9 = await transition('create', null, { data: periodData(year, 9, { printed_totals: true, total_cash: undefined, source_missing_fields: ['total_cash'], annual_budgeted_expenses: 9800 }) });
const sep = c9.body?.period_id;
if (!sep) throw new Error(`create 9: ${c9.status}`);
await E.BudgetLine.bulkCreate(sepLines.map((l) => ({ ...l, period_id: sep })));
await E.Distribution.create({ period_id: sep, entity_name: 'ZZ Entity', q1: 101, q2: 203 });
await E.RecurringTransfer.create({ period_id: sep, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
for (let i = 0; i < 20; i++) { if ((await E.BudgetLine.filter({ period_id: sep })).length >= 4) break; await sleep(500); }
let f9 = await finalizeAfterLag(sep);
for (let i = 0; i < 10 && f9.status === 409 && codes(f9).includes('import_incomplete'); i++) { await sleep(1500); f9 = await transition('finalize', sep); }
if (f9.status !== 200) throw new Error(`finalize 9: ${f9.status} ${codes(f9).join(',')}`);
const p9 = await publishRetry(sep);
if (p9.status !== 200) throw new Error(`publish 9: ${p9.status} ${codes(p9).join(',')}`);
fs.writeFileSync('.trends-scenario.json', JSON.stringify({ year, jun, jul, aug, sep }));

// Wait until the public list shows all four months (reads can lag).
let out;
for (let i = 0; i < 20; i++) { out = await served(); if (out?.trend?.year === year && out.trend.points.length >= 3) break; await sleep(2000); }
const t = out?.trend;
check('the trend is served, for the latest data year', !!t && t.year === year, `${t?.year}`);
check('one point per data month: Jun, Jul, Aug (the August report is the July point)', JSON.stringify(t?.points.map((p) => p.dataMonth)) === JSON.stringify([`Jun ${year}`, `Jul ${year}`, `Aug ${year}`]), t?.points.map((p) => p.dataMonth).join(','));
const pJul = t?.points[1];
check('the BVA August report supersedes the legacy July snapshot, with a note', pJul?.reportId === aug && JSON.stringify(pJul?.supersedes) === JSON.stringify([`ZZ TEST TR 7/${year}`]) && t.explanations.some((e) => /supersedes the earlier legacy/.test(e)));
check('legacy months are marked before BVA reporting', JSON.stringify(t?.points.map((p) => p.beforeBva)) === '[true,false,false]');
const pAug = t?.points[2];
check('a blank Total Cash is a gap (null), never 0; no cash delta across it', pAug?.cash === null && t.cashSinceLast === null && t.explanations.some((e) => /never counted as \$0/.test(e)));
check('the budget revision is one note for the September report', t?.explanations.filter((e) => /revised/.test(e)).length === 1 && t.explanations.some((e) => new RegExp(`revised in the ZZ TEST TR 9/${year} report`).test(e)));

// Every point equals its own month page (the same public payload the client renders).
let equal = 0;
for (const pt of t?.points || []) {
  const d = await served(pt.reportId);
  const vm = buildBvaDashboard({ period: d.period, budgetLines: d.budgetLines, cashAccounts: d.cashAccounts, distributions: d.distributions }, { month: false });
  const g = Object.fromEntries(vm.groups.map((x) => [x.key, x]));
  const ok = pt.income.ytd === vm.snapshot.ytdIncome && pt.expenses.ytd === vm.snapshot.ytdExpenses && pt.expenses.budget === vm.snapshot.annualExpenseBudget && pt.cash === vm.cash.total && pt.distributionsYtd === vm.distributions.total
    && ['fixed', 'variable', 'discretionary'].every((k) => pt.groups[k].ytd === (g[k].ytd.actual ?? null));
  if (ok) equal++;
}
check('every point equals its month page', equal === (t?.points.length || -1), `${equal} of ${t?.points.length}`);

// A published revision replaces its month's point; the replaced version never appears.
const cr = await transition('create_revision', sep, { reason: 'Staging test: trend revision.' });
const rid = cr.body?.period_id;
let cp = cr;
for (let i = 0; i < 30 && !cp.body?.copy?.done; i++) cp = await transition('copy_revision', rid);
for (let i = 0; i < 6 && cp.body?.copy?.done && cp.body?.copy?.verified !== true; i++) { await sleep(2000); cp = await transition('copy_revision', rid); }
check('a revision of September is created and its copy verified', !!rid && cp.body?.copy?.verified === true);
await E.ReportingPeriod.update(rid, { ytd_expenses: 811 * 8 + 50 });
for (let i = 0; i < 20; i++) { if ((await E.ReportingPeriod.get(rid)).ytd_expenses === 811 * 8 + 50) break; await sleep(500); }
let fr = await finalizeAfterLag(rid);
for (let i = 0; i < 10 && fr.status === 409 && codes(fr).includes('import_incomplete'); i++) { await sleep(1500); fr = await transition('finalize', rid); }
const pr = fr.status === 200 ? await publishRetry(rid) : fr;
check('the revision finalizes and publishes', fr.status === 200 && pr.status === 200, `${fr.status}/${pr.status} ${codes(pr).join(',')}`);
let t2;
for (let i = 0; i < 20; i++) { t2 = (await served())?.trend; if (t2?.points?.[2]?.reportId === rid) break; await sleep(2000); }
check('the trend now uses the revision for that month, with its figures', t2?.points?.[2]?.reportId === rid && t2.points[2].expenses.ytd === 811 * 8 + 50 && t2.points.length === 3);
check('the replaced version is not in the trend', !(t2?.points || []).some((p) => p.reportId === sep));

const failed = results.filter((x) => !x).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
