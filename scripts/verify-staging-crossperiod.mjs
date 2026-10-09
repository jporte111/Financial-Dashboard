// Phase 6 hosted staging test: cross-period checks at check / finalize / publish.
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

// ---- fictional months -----------------------------------------------------
const usedYears = new Set((await E.ReportingPeriod.list('-year', 1000)).map((p) => p.year));
const freshYear = () => { let y; do y = 3000 + Math.floor(Math.random() * 6000); while (usedYears.has(y)); usedYears.add(y); return y; };
const mm = (m) => String(m).padStart(2, '0');
// Data through the previous month end (report-month convention); figures grow steadily.
function periodData(year, month, over = {}) {
  const k = month - 1;
  return {
    label: `ZZ TEST XP ${month}/${year}`, month, year, reporting_cutoff_date: `${year}-${mm(k)}-28`, months_elapsed: k,
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
  await E.ReportingPeriod.update(pid, { checklist: Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true])) });
  if (publish) { const p = await transition('publish', pid); if (p.status !== 200) throw new Error(`publish ${month}/${year}: ${p.status} ${JSON.stringify(codes(p))}`); }
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
const scenarioYears = {};

// ---- A. a consistent month -------------------------------------------------
{
  const y = (scenarioYears.A = freshYear());
  await makeMonth(y, 5); const jun = await makeMonth(y, 6);
  const jul = await makeMonth(y, 7, { finalize: false });
  const chk = await transition('check', jul);
  check('A1 check compares with the previous published month', chk.body?.cross_period?.previous?.id === jun);
  const f = await transition('finalize', jul);
  check('A2 a consistent month finalizes (no cross-period blockers)', f.status === 200, `HTTP ${f.status} ${xcodes(f).join(',')}`);
  await E.ReportingPeriod.update(jul, { checklist: Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true])) });
  check('A3 ...and publishes', (await transition('publish', jul)).status === 200);
  const pubChk = await transition('check', jul);
  check('A4 a published period is never re-judged (no cross-period evaluation)', pubChk.body?.cross_period === null);
}

// ---- B. a year-to-date decrease needs a written reason ---------------------
{
  const y = (scenarioYears.B = freshYear());
  await makeMonth(y, 5); await makeMonth(y, 6);
  const jul = await makeMonth(y, 7, { finalize: false, period: { ytd_income: 1013 * 4, month_income: -1013 } });
  const f1 = await transition('finalize', jul);
  const blk = (f1.body?.blockers || []).find((b) => b.code === 'cross_period:ytd_income_decreased');
  check('B1 finalize refused: total income year-to-date decreased', f1.status === 409 && !!blk && blk.overridable === true, `HTTP ${f1.status} ${xcodes(f1).join(',')}`);
  check('B2 nothing was written by the refusal', (await E.ReportingPeriod.get(jul)).status === 'draft');
  const f2 = await transition('finalize', jul, { overrides: reason(xcodes(f1)) });
  const stored = await E.ReportingPeriod.get(jul);
  check('B3 accepted with a written reason: finalizes, reason recorded with who/when', f2.status === 200 && !!stored.bva_overrides?.['cross_period:ytd_income_decreased']?.by, `HTTP ${f2.status}`);
  await E.ReportingPeriod.update(jul, { checklist: Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true])) });
  const p = await transition('publish', jul);
  check('B4 the reason given at finalize satisfies publish', p.status === 200, `HTTP ${p.status} ${xcodes(p).join(',')}`);
}

// ---- C. closed distribution quarters ---------------------------------------
{
  const y = (scenarioYears.C = freshYear());
  await makeMonth(y, 7); await makeMonth(y, 8, { dist: { q1: 101, q2: 203, q3: 11 } });
  const sep = await makeMonth(y, 9, { finalize: false, dist: { q1: 999, q2: 203, q3: 23 } });
  const f1 = await transition('finalize', sep);
  check('C1 a changed closed quarter needs a reason', f1.status === 409 && xcodes(f1).includes('cross_period:closed_quarter_changed:zz entity:q1'), xcodes(f1).join(','));
  const d = (await E.Distribution.filter({ period_id: sep }))[0];
  await E.Distribution.delete(d.id);
  await E.Distribution.create({ period_id: sep, entity_name: 'ZZ Entity', q2: 203, q3: 23 }); // Q1 now blank (omitted)
  const f2 = await transition('finalize', sep, { overrides: reason(['cross_period:closed_quarter_missing:zz entity:q1', 'cross_period:closed_quarter_changed:zz entity:q1']) });
  const b = (f2.body?.blockers || []).find((x) => x.code === 'cross_period:closed_quarter_missing:zz entity:q1');
  check('C2 a closed quarter now blank blocks and cannot be overridden (blank is not $0.00)', f2.status === 409 && !!b && b.overridable === false, xcodes(f2).join(','));
  const d2 = (await E.Distribution.filter({ period_id: sep }))[0];
  await E.Distribution.update(d2.id, { q1: 101 });
  check('C3 restored: finalizes; the open quarter may change freely', (await transition('finalize', sep)).status === 200);
}

// ---- D. missing month column is not a mismatch -----------------------------
{
  const y = (scenarioYears.D = freshYear());
  await makeMonth(y, 5);
  const data = periodData(y, 6, { source_missing_fields: ['month_income', 'month_expenses'] });
  delete data.month_income; delete data.month_expenses;
  const c = await transition('create', null, { data });
  const jun = c.body.period_id;
  await E.BudgetLine.bulkCreate(lineData(5).map((l) => ({ ...l, period_id: jun })));
  await E.Distribution.create({ period_id: jun, entity_name: 'ZZ Entity', q1: 101 });
  await E.RecurringTransfer.create({ period_id: jun, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
  await E.CashAccount.create({ period_id: jun, name: 'ZZ Checking', balance: 4409 });
  await visible(jun);
  const chk = await transition('check', jun);
  check('D1 a missing month column is a note, not a mismatch', findings(chk, 'info').includes('not_comparable:month_income') && !findings(chk).some((x) => x.startsWith('month_vs_ytd:income')), findings(chk).join(','));
  const f = await finalizeAfterLag(jun);
  check('D2 ...and finalizes', f.status === 200, `HTTP ${f.status} ${codes(f).join(',')}`);
}

// ---- E. legacy -> validated (the convention switch) -------------------------
{
  const y = (scenarioYears.E = freshYear());
  const data = periodData(y, 7); delete data.reporting_cutoff_date; data.months_elapsed = 7; // a legacy July with its own month's data
  const c = await transition('create', null, { data });
  const legacy = c.body.period_id;
  privileged(`await base44.entities.ReportingPeriod.update('${legacy}', { status: 'final', published: true, publication_date: '${y}-08-02' });`);
  const aug = await makeMonth(y, 8, { finalize: false, period: { reporting_cutoff_date: `${y}-07-31`, months_elapsed: 7 } });
  const f1 = await transition('finalize', aug);
  const b = (f1.body?.blockers || []).find((x) => x.code === 'cross_period:cutoff_not_after_previous');
  check('E1 same cutoff as a legacy month: needs a written reason (overridable)', f1.status === 409 && !!b && b.overridable === true, xcodes(f1).join(','));
  const chk = await transition('check', aug);
  check('E2 a legacy previous month is not compared figure by figure', !findings(chk).some((x) => /decreased|budget_changed|month_vs_ytd/.test(x)), findings(chk).join(','));
  check('E3 accepted with a reason: finalizes', (await transition('finalize', aug, { overrides: reason(xcodes(f1)) })).status === 200);
}

// ---- F. revising a month after a later month is published (Phase 4) ---------
{
  const y = (scenarioYears.F = freshYear());
  const jun = await makeMonth(y, 6); const jul = await makeMonth(y, 7); await makeMonth(y, 8);
  const r = await transition('create_revision', jul, { reason: 'Fictional staging test: cross-period revision.' });
  const rid = r.body?.period_id;
  for (let i = 0; i < 10 && (await E.ReportingPeriod.get(rid)).copy_status !== 'verified'; i++) await transition('copy_revision', rid);
  // the corrected July: income grows by more (month figure consistent with June)
  await E.ReportingPeriod.update(rid, { ytd_income: 1013 * 5 + 9001, month_income: 9001 });
  const chk = await transition('check', rid);
  check('F1 a revision is compared with the month before it (not its own original)', chk.body?.cross_period?.previous?.id === jun, chk.body?.cross_period?.previous?.id);
  check('F2 the later published month that no longer follows is a WARNING', findings(chk, 'warn').includes('later_month_behind:ytd_income'), findings(chk, 'warn').join(','));
  const f = await transition('finalize', rid);
  check('F3 ...which does not block finalize', f.status === 200, `HTTP ${f.status} ${xcodes(f).join(',')}`);
  await E.ReportingPeriod.update(rid, { checklist: Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true])) });
  const p = await transition('publish', rid);
  check('F4 ...or publish; the revision replaces the original (Phase 4 unchanged)', p.status === 200 && p.body?.replaced === jul && !p.body?.supersede_pending, `HTTP ${p.status}`);
  const orig = await E.ReportingPeriod.get(jul);
  check('F5 the original is superseded and unpublished', orig.superseded === true && orig.published === false);
  const aug2 = await transition('create_revision', (await E.ReportingPeriod.filter({ year: y, month: 8 }))[0].id, { reason: 'Fictional staging test: baseline after a revision.' });
  const a2 = aug2.body?.period_id;
  for (let i = 0; i < 10 && (await E.ReportingPeriod.get(a2)).copy_status !== 'verified'; i++) await transition('copy_revision', a2);
  const chk2 = await transition('check', a2);
  check('F6 the next month now compares with the published revision, never the superseded original', chk2.body?.cross_period?.previous?.id === rid, chk2.body?.cross_period?.previous?.id);
  await transition('discard_revision', a2);
}

const failed = results.filter((x) => !x).length;
fs.writeFileSync('.crossperiod-scenario.json', JSON.stringify(scenarioYears));
log(`\n${results.length - failed} passed, ${failed} failed; fictional years used: ${Object.keys(scenarioYears).length}`);
