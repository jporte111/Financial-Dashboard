// Phase 5a hosted staging test: drill-down responses and report versions.
// STAGING APP ONLY, fictional data. Run from the staging checkout with its
// owner-only .staging.env:
//   node scripts/verify-staging-drilldown.mjs seed              build the version scenario (once)
//   node scripts/verify-staging-drilldown.mjs fingerprint <tag> hash every drill-down / dashboard response
//   node scripts/verify-staging-drilldown.mjs check             the 5a checks against the scenario
// States that cannot be produced from outside a function (an original
// awaiting supersede cleanup, an interrupted discard) are SIMULATED with
// owner-privileged writes on the staging app.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@base44/sdk';
import { planBvaImport } from '../src/lib/bvaImport.js';
import { validateBva } from '../src/lib/bvaValidation.js';
import { cleanParsed } from '../src/lib/__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';
import { withPublishExpect } from '../src/lib/__fixtures__/publishExpect.js';

const STAGING = '6ac5040ff86172a58191d35a';
const PRODUCTION = '6a80ccf1dac2259ae9870f29';
const env = Object.fromEntries(fs.readFileSync('.staging.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const link = fs.readFileSync('base44/.app.jsonc', 'utf8');
if (env.STAGING_APP_ID !== STAGING || !link.includes(STAGING) || link.includes(PRODUCTION)) { console.log('Refusing: not linked to the staging app.'); process.exit(2); }
console.error = () => {};
const log = console.log;
const [mode, tag] = process.argv.slice(2);
const SCENARIO = '.drilldown-scenario.json';
const admin = createClient({ appId: STAGING, token: env.STAGING_TOKEN, requiresAuth: false });
const anon = createClient({ appId: STAGING, requiresAuth: false });
const E = admin.entities;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (e) => e?.status || e?.response?.status || 'err';
const call = async (client, fn, body) => {
  try { const r = await client.functions.invoke(fn, body); return { status: 200, body: r?.data ?? r }; } catch (e) { return { status: status(e), body: e?.response?.data ?? e?.data ?? {} }; }
};
// Paced, with retries for transient errors (and a count of them).
const transientSeen = {};
async function steady(client, fn, body) {
  for (let i = 0; i < 6; i++) {
    const r = await call(client, fn, body);
    if (r.status === 200 || (typeof r.status === 'number' && r.status < 429 && r.status >= 400)) return r;
    transientSeen[r.status] = (transientSeen[r.status] || 0) + 1;
    await sleep(800 * (i + 1));
  }
  return call(client, fn, body);
}
const transition = async (action, period_id, extra = {}) => call(admin, 'periodTransition', await withPublishExpect(admin.entities, { action, period_id, ...extra }));
const privileged = (code) => execFileSync('npx', ['base44', 'exec', '--privileged'], { input: `if (Deno.env.get('BASE44_APP_ID') !== '${STAGING}') throw new Error('not staging');\n${code}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const canon = (x) => (Array.isArray(x) ? x.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(canon(x))).digest('hex');
const results = [];
const check = (n, name, ok, detail = '') => { results.push({ n, ok }); log(`${ok ? 'PASS' : 'FAIL'}  [${n}] ${name}${detail ? `  (${detail})` : ''}`); };

// ---- seed: a fictional year with every version state ----------------------------
const ACCOUNT = 'ZZ Test Groceries';
async function publishedMonth(year, month) {
  const parsed = cleanParsed();
  const mm = String(month).padStart(2, '0');
  const cutoffDate = `${year}-${mm}-28`;
  const validation = validateBva(parsed, { cutoffDate, period: { month, year } });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
  const plan = planBvaImport({ parsed, validation, confirm: { month, year, cutoffDate }, groupMap });
  plan.budgetLines.toCreate[0].category = ACCOUNT; // the drill-down line
  const c = await transition('create', null, { data: { ...plan.periodWrite, label: `ZZ TEST ${month}/${year}` } });
  const pid = c.body?.period_id;
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
    if (plan[key].toCreate.length) await E[entity].bulkCreate(plan[key].toCreate.map((d) => ({ ...d, period_id: pid })));
  }
  return { pid, mm };
}
async function finalizePublish(pid, publish = true) {
  const chk = await transition('check', pid);
  const overrides = Object.fromEntries((chk.body?.finalize?.blockers || []).filter((b) => b.overridable !== false).map((b) => [b.code, { reason: 'Fictional staging test.' }]));
  const f = await transition('finalize', pid, { overrides });
  // Phase 6c: the checklist is confirmed through the server (who/when recorded).
  for (const [k] of PUBLISH_CHECKLIST) await transition('confirm_checklist', pid, { item: k });
  const p = publish ? await transition('publish', pid) : null;
  if (f.status !== 200 || (publish && p.status !== 200)) throw new Error(`finalize ${f.status} publish ${p?.status} ${JSON.stringify(f.body?.blockers || p?.body?.blockers || '')}`);
}
const addTx = async (pid, year, mm, vendor, n = 3) =>
  E.Transaction.bulkCreate(Array.from({ length: n }, (_, i) => ({ period_id: pid, date: `${year}-${mm}-1${i}`, amount: 10 + i, vendor, description: `Fictional ${vendor}`, category: ACCOUNT, account_id: globalThis.ACCT, source: 'manual', transaction_type: 'expense', treatment: 'personal' })));
async function revise(pid, year, mm, vendor) {
  const r = await transition('create_revision', pid, { reason: 'Staging test: drill-down versions.' });
  const rid = r.body?.period_id;
  for (let i = 0; i < 10 && !(await E.ReportingPeriod.get(rid)).copy_status?.startsWith('verified'); i++) await transition('copy_revision', rid);
  for (const t of await E.Transaction.filter({ period_id: rid }, undefined, 500)) await E.Transaction.update(t.id, { vendor });
  return rid;
}

if (mode === 'seed') {
  const used = new Set((await E.ReportingPeriod.list('-year', 500)).map((p) => p.year));
  let year; do year = 3000 + Math.floor(Math.random() * 6000); while (used.has(year));
  const acct = (await E.Account.create({ account_name: ACCOUNT, source: 'quickbooks', top_level_group: 'variable', account_type: 'expense' })).id;
  globalThis.ACCT = acct;
  const s = { year, account: acct };
  // May: cleanly superseded original
  const may = await publishedMonth(year, 5); await addTx(may.pid, year, may.mm, 'MAY ORIGINAL'); await finalizePublish(may.pid);
  const mayR = await revise(may.pid, year, may.mm, 'MAY REVISION'); await finalizePublish(mayR);
  // June: revision published, original awaiting cleanup (SIMULATED: switch only)
  const jun = await publishedMonth(year, 6); await addTx(jun.pid, year, jun.mm, 'JUNE ORIGINAL'); await finalizePublish(jun.pid);
  const junR = await revise(jun.pid, year, jun.mm, 'JUNE REVISION'); await finalizePublish(junR, false);
  privileged(`await base44.entities.ReportingPeriod.update('${junR}', { published: true, publication_date: '${new Date().toISOString().slice(0, 10)}' });`);
  // July: a discarded revision (SIMULATED interrupted discard) and an open draft revision
  const jul = await publishedMonth(year, 7); await addTx(jul.pid, year, jul.mm, 'JULY ORIGINAL'); await finalizePublish(jul.pid);
  const julX = await revise(jul.pid, year, jul.mm, 'JULY DISCARDED');
  privileged(`await base44.entities.ReportingPeriod.update('${julX}', { revision_status: 'discarded' });`);
  const julR = await revise(jul.pid, year, jul.mm, 'JULY DRAFT');
  // August: the current month
  const aug = await publishedMonth(year, 8); await addTx(aug.pid, year, aug.mm, 'AUGUST ORIGINAL'); await finalizePublish(aug.pid);
  Object.assign(s, { may: may.pid, mayR, jun: jun.pid, junR, jul: jul.pid, julX, julR, aug: aug.pid });
  fs.writeFileSync(SCENARIO, JSON.stringify(s));
  log(`seeded ZZ TEST year ${year}`);
}

// ---- fingerprints of every response a client or admin can get ------------------
if (mode === 'fingerprint') {
  const periods = await E.ReportingPeriod.list('-year', 1000);
  const out = { dashboard: {}, publicDrill: {}, adminDrill: {}, publicDrillBodies: {} };
  const d0 = await steady(anon, 'publicDashboard', {});
  out.dashboard.default = `${d0.status} ${hash(d0.body)}`;
  for (const p of periods) {
    const d = await steady(anon, 'publicDashboard', { period_id: p.id });
    out.dashboard[p.id] = `${d.status} ${hash(d.body)}`;
    const lines = (await E.BudgetLine.filter({ period_id: p.id }, undefined, 500)) || [];
    for (const l of lines) {
      const pu = await steady(anon, 'publicCategoryTransactions', { period_id: p.id, budget_line_id: l.id });
      out.publicDrill[`${p.id}/${l.id}`] = `${pu.status} ${hash(pu.body)}`;
      if (pu.status === 200) out.publicDrillBodies[`${p.id}/${l.id}`] = { keys: Object.keys(pu.body).sort(), rows: (pu.body.transactions || []).length, nonzero: !!(pu.body.total || pu.body.ytd_amount || pu.body.month_amount) };
      const ad = await steady(admin, 'categoryTransactions', { period_id: p.id, category: l.category, qb_account_names: l.qb_account_names || [] });
      out.adminDrill[`${p.id}/${l.id}`] = `${ad.status} ${hash(ad.body)}`;
    }
  }
  fs.writeFileSync(`.fp-${tag}.json`, JSON.stringify(out));
  log(`fingerprinted ${Object.keys(out.dashboard).length} dashboard, ${Object.keys(out.publicDrill).length} public and ${Object.keys(out.adminDrill).length} admin drill-down responses; transient errors retried: ${JSON.stringify(transientSeen)}`);
}

// ---- the 5a checks ---------------------------------------------------------------
if (mode === 'check') {
  const s = JSON.parse(fs.readFileSync(SCENARIO, 'utf8'));
  const lineOf = async (pid) => (await E.BudgetLine.filter({ period_id: pid, category: ACCOUNT }, undefined, 5))[0];
  const vendors = (b) => [...new Set((b.transactions || []).map((t) => t.vendor))].sort();
  // 1. anonymous public drill-down
  const augLine = await lineOf(s.aug);
  const pu = await steady(anon, 'publicCategoryTransactions', { period_id: s.aug, budget_line_id: augLine.id });
  check(1, 'anonymous drill-down: only period_id, category, detail_available, transactions -- and transactions: []', pu.status === 200 && JSON.stringify(Object.keys(pu.body).sort()) === JSON.stringify(['category', 'detail_available', 'period_id', 'transactions']) && Array.isArray(pu.body.transactions) && pu.body.transactions.length === 0 && pu.body.detail_available === false, `HTTP ${pu.status} keys ${Object.keys(pu.body || {}).sort().join(',')}`);
  const stored = (await E.Transaction.filter({ period_id: s.aug }, undefined, 100)).length;
  check(1, 'the period does hold matching transactions (so the empty answer is the allowlist, not missing data)', stored > 0, `${stored} stored`);
  const nonAdminAsk = await steady(anon, 'publicCategoryTransactions', { period_id: s.aug, category: ACCOUNT, qb_account_names: [ACCOUNT] });
  check(1, 'caller-supplied account names change nothing', nonAdminAsk.body?.transactions?.length === 0);
  // 6/8. admin: rows only from current versions, one per month
  const ad = await steady(admin, 'categoryTransactions', { period_id: s.aug, category: ACCOUNT, qb_account_names: [] });
  check(6, 'admin (current August): legitimate rows from current versions only', ad.status === 200 && JSON.stringify(vendors(ad.body)) === JSON.stringify(['AUGUST ORIGINAL', 'JULY ORIGINAL', 'JUNE REVISION', 'MAY REVISION']), vendors(ad.body).join(', '));
  const perMonth = {};
  for (const t of ad.body.transactions || []) perMonth[t.date.slice(0, 7)] = (perMonth[t.date.slice(0, 7)] || new Set()).add(t.vendor);
  check(8, 'YTD: exactly one version per month', Object.values(perMonth).every((v) => v.size === 1) && Object.keys(perMonth).length === 4, JSON.stringify(Object.fromEntries(Object.entries(perMonth).map(([k, v]) => [k, [...v]]))));
  const draft = await steady(admin, 'categoryTransactions', { period_id: s.julR, category: ACCOUNT, qb_account_names: [] });
  check(6, 'admin (open July draft): its own rows plus earlier current versions only', JSON.stringify(vendors(draft.body)) === JSON.stringify(['JULY DRAFT', 'JUNE REVISION', 'MAY REVISION']), vendors(draft.body).join(', '));
  // 7. replaced versions never supply rows
  for (const [label, id] of [['superseded May original', s.may], ['June original awaiting cleanup', s.jun], ['discarded July revision', s.julX]]) {
    const r = await steady(admin, 'categoryTransactions', { period_id: id, category: ACCOUNT, qb_account_names: [] });
    check(7, `admin: ${label} is refused, no rows`, r.status === 409 && r.body?.transactions === undefined, `HTTP ${r.status} ${r.body?.code || ''}`);
    const l = await lineOf(id);
    const p2 = await steady(anon, 'publicCategoryTransactions', { period_id: id, budget_line_id: l?.id });
    check(7, `public: ${label} is refused, no rows`, p2.status === 403 && p2.body?.transactions === undefined, `HTTP ${p2.status}`);
  }
  const pd = await steady(anon, 'publicCategoryTransactions', { period_id: s.julR, budget_line_id: (await lineOf(s.julR)).id });
  check(7, 'public: the open July draft is refused', pd.status === 403);
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed} passed, ${failed} failed; transient errors retried: ${JSON.stringify(transientSeen)}`);
}
