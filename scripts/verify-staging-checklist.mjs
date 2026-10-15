// Phase 6c hosted staging test: checklist confirmations (who / when / what),
// resets limited to the item whose data changed, the four review groups.
// STAGING APP ONLY, fictional data. Run from the staging checkout with its
// owner-only .staging.env:  node scripts/verify-staging-checklist.mjs
import fs from 'node:fs';
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
const KEYS = PUBLISH_CHECKLIST.map(([k]) => k);

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
// Cross-period checks fail CLOSED when Base44 rate-limits a burst of reads
// (seen on hosted staging): retry a refused publish a few times in that case only.
async function publishRetry(pid) {
  let p = await transition('publish', pid);
  for (let i = 0; i < 3 && p.status === 409 && (p.body?.blockers || []).some((b) => b.code === 'cross_period:checks_unavailable' || /could not run|could not be evaluated/.test(b.message || '')); i++) { await sleep(5000); p = await transition('publish', pid); }
  return p;
}
// ...and a confirm refused only because the checks could not run (fail closed).
// Transient refusals only (the same rule in every hosted suite): checks that could
// not run, a change not verified as saved, or lines not yet visible to the server.
const unavailable = (r) => r.status === 409 && (r.body?.blockers || []).some((b) => b.code === 'checklist_not_saved' || /could not run|could not be evaluated|Budget lines are incomplete/.test(b.message || ''));
async function confirmRetry(pid, item) {
  let r = await transition('confirm_checklist', pid, { item });
  for (let i = 0; i < 3 && unavailable(r); i++) { await sleep(5000); r = await transition('confirm_checklist', pid, { item }); }
  return r;
}
// Base44 reads can lag a write for a few seconds: poll the server's check until `want` holds.
// A check taken while the checks could not run (Base44 rate limits) blocks every
// item by design (fail closed); it says nothing about the data, so skip it.
const checksRan = (b) => !b?.cross_period?.unavailable && !b?.checklist?.unavailable
  && !(b?.checklist?.items || []).some((s) => (s.blockedBy || []).some((c) => /checks_unavailable|checklist_unavailable/.test(c)));
async function checkUntil(pid, want, tries = 12) {
  let r;
  for (let i = 0; i < tries; i++) { r = await transition('check', pid); if (r.status === 200 && checksRan(r.body) && want(r.body)) return r; await sleep(1500); }
  return r;
}
const states = (body) => Object.fromEntries((body?.checklist?.items || []).map((s) => [s.key, s.state]));
const notConfirmed = (body) => Object.entries(states(body)).filter(([, v]) => v !== 'confirmed').map(([k]) => k).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const usedYears = new Set((await E.ReportingPeriod.list('-year', 1000)).map((p) => p.year));
const freshYear = () => { let y; do y = 3000 + Math.floor(Math.random() * 6000); while (usedYears.has(y)); usedYears.add(y); return y; };
const mm = (m) => String(m).padStart(2, '0');
const periodData = (year, month) => {
  const k = month - 1;
  return { label: `ZZ TEST CL ${month}/${year}`, month, year, reporting_cutoff_date: `${year}-${mm(k)}-28`, months_elapsed: k,
    ytd_income: 1013 * k, ytd_expenses: 811 * k, month_income: 1013, month_expenses: 811, distributions_ytd: 307, total_cash: 4409,
    annual_budgeted_income: 12157, annual_budgeted_expenses: 9733, bva_parsed_source: { fictional: true }, bva_validation_warnings: [] };
};
const lineData = (k) => [
  { category: 'ZZ Income', budget_group: 'income', ytd_actual: 1013 * k, annual_budget: 12157, month_actual: 1013 },
  { category: 'FIXED', budget_group: 'fixed', ytd_actual: 211 * k, annual_budget: 2533, month_actual: 211 },
  { category: 'VARIABLE', budget_group: 'variable', ytd_actual: 307 * k, annual_budget: 3685, month_actual: 307 },
  { category: 'DISCRETIONARY', budget_group: 'discretionary', ytd_actual: 293 * k, annual_budget: 3515, month_actual: 293 },
];
async function makeMonth(year, month, { publish = true } = {}) {
  const c = await transition('create', null, { data: periodData(year, month) });
  const pid = c.body?.period_id;
  if (!pid) throw new Error(`create ${month}/${year}: ${c.status}`);
  await E.BudgetLine.bulkCreate(lineData(month - 1).map((l) => ({ ...l, period_id: pid })));
  await E.Distribution.create({ period_id: pid, entity_name: 'ZZ Entity', q1: 101, q2: 203 });
  await E.RecurringTransfer.create({ period_id: pid, source: 'ZZ Bank', purpose: 'ZZ Savings', amount: 17 });
  await E.CashAccount.create({ period_id: pid, name: 'ZZ Checking', balance: 4409 });
  let f = await transition('finalize', pid);
  for (let i = 0; i < 10 && f.status === 409 && codes(f).length === 1 && codes(f)[0] === 'import_incomplete'; i++) { await sleep(1500); f = await transition('finalize', pid); }
  if (f.status !== 200) throw new Error(`finalize ${month}/${year}: ${f.status} ${codes(f)}`);
  if (publish) {
    await checkUntil(pid, (b) => (b.checklist?.items || []).every((s) => s.state !== 'blocked'));
    for (const k of KEYS) { const r = await confirmRetry(pid, k); if (r.status !== 200) throw new Error(`confirm ${k}: ${r.status} ${codes(r)}`); }
    const p = await publishRetry(pid);
    if (p.status !== 200) throw new Error(`publish ${month}/${year}: ${p.status} ${codes(p)}`);
  }
  return pid;
}

const year = freshYear();
const jul = await makeMonth(year, 7);
const aug = await makeMonth(year, 8, { publish: false });

// 1. nothing confirmed yet; the four groups are there
const c0 = await checkUntil(aug, (b) => notConfirmed(b).length === 7 && !!b.review);
check('1a a finalized month starts with all 7 items not confirmed', notConfirmed(c0.body).length === 7 && Object.values(states(c0.body)).every((s) => s === 'unconfirmed'), JSON.stringify(states(c0.body)));
check('1b the review has the four groups, with plain-language actions', ['blockers', 'needsReview', 'warnings', 'completed'].every((g) => Array.isArray(c0.body.review?.[g])) && c0.body.review.needsReview.every((e) => e.action && e.title));
check('1c the old true/false checklist alone cannot publish', codes(await transition('publish', aug)).filter((c) => c.startsWith('checklist_incomplete:')).length === 7);

// 2. confirm each item: who and when recorded
for (const k of KEYS) await confirmRetry(aug, k);
const p1 = await E.ReportingPeriod.get(aug);
check('2a every item recorded with who, when and what it covered', KEYS.every((k) => p1.checklist_confirmations?.[k]?.by && p1.checklist_confirmations[k].at && Object.keys(p1.checklist_confirmations[k].parts || {}).length));
const c1 = await checkUntil(aug, (b) => notConfirmed(b).length === 0);
check('2b all 7 confirmed', notConfirmed(c1.body).length === 0, notConfirmed(c1.body).join(','));

// 3. a Monthly Data edit to a cash balance resets ONLY cash (and the whole-report review)
const cash = (await E.CashAccount.filter({ period_id: aug }))[0];
await E.CashAccount.update(cash.id, { balance: 4410 });
const c2 = await checkUntil(aug, (b) => notConfirmed(b).length > 0);
check('3a only cash and the budget report need confirming again', same(notConfirmed(c2.body), ['budget_report_reviewed', 'cash_confirmed']), notConfirmed(c2.body).join(','));
const cashItem = (c2.body.checklist.items || []).find((s) => s.key === 'cash_confirmed');
check('3b ...and it says what changed', cashItem?.state === 'stale' && same(cashItem.changedParts, ['cash_accounts']));
const pubStale = await transition('publish', aug);
check('3c publish is refused while they are stale', pubStale.status === 409 && same(codes(pubStale).sort(), ['checklist_incomplete:budget_report_reviewed', 'checklist_incomplete:cash_confirmed']), codes(pubStale).join(','));
await E.CashAccount.update(cash.id, { balance: 4409 });
await checkUntil(aug, (b) => notConfirmed(b).length === 0);

// 4. an identical re-import (rows deleted and re-created with the same values) resets nothing
for (const ent of ['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer']) {
  const rows = await E[ent].filter({ period_id: aug });
  for (const r of rows) await E[ent].delete(r.id);
  await E[ent].bulkCreate(rows.reverse().map(({ id, created_date, updated_date, created_by, created_by_id, is_sample, app_id, ...rest }) => rest));
}
await sleep(3000);
const c3 = await checkUntil(aug, (b) => notConfirmed(b).length === 0, 6);
check('4  an identical re-import resets nothing', notConfirmed(c3.body).length === 0, notConfirmed(c3.body).join(','));

// 5. a distribution correction resets only distributions (and the whole report)
const d = (await E.Distribution.filter({ period_id: aug }))[0];
await E.Distribution.update(d.id, { q2: 204 });
const c4 = await checkUntil(aug, (b) => notConfirmed(b).length > 0);
check('5  a distribution correction resets only distributions and the budget report', same(notConfirmed(c4.body), ['budget_report_reviewed', 'distributions_confirmed']), notConfirmed(c4.body).join(','));
await E.Distribution.update(d.id, { q2: 203 });
await checkUntil(aug, (b) => notConfirmed(b).length === 0);

// 6. a figure marked missing (not $0.00) resets its item
await E.ReportingPeriod.update(aug, { source_missing_fields: ['month_income'] });
const c5 = await checkUntil(aug, (b) => notConfirmed(b).length > 0);
check('6  a figure becoming missing resets income (and the budget report)', same(notConfirmed(c5.body), ['budget_report_reviewed', 'income_reviewed']), notConfirmed(c5.body).join(','));
await E.ReportingPeriod.update(aug, { source_missing_fields: [] });
await checkUntil(aug, (b) => notConfirmed(b).length === 0);

// 7. a linked open STRUCTURAL blocker (the distributions block could not be
// found): the item cannot be confirmed. (Financial anomalies only warn.)
const savedWarnings = (await E.ReportingPeriod.get(aug)).bva_validation_warnings || [];
await E.ReportingPeriod.update(aug, { bva_validation_warnings: [...savedWarnings, { code: 'section_missing:distributions', section: 'distributions', message: 'Fictional: the workbook has no distributions block.', blocksFinalize: true, overridable: false }] });
await checkUntil(aug, (b) => states(b).distributions_confirmed === 'blocked');
const blocked = await confirmRetry(aug, 'distributions_confirmed');
check('7  an item with an open linked structural blocker cannot be confirmed', blocked.status === 409 && codes(blocked)[0] === 'checklist_item_blocked' && /A required workbook section is missing/.test(blocked.body.blockers[0].message), `${blocked.status} ${(blocked.body?.blockers?.[0]?.message || '').slice(0, 90)}`);
await E.ReportingPeriod.update(aug, { bva_validation_warnings: savedWarnings });
await checkUntil(aug, (b) => notConfirmed(b).length === 0);

// 8. publish once everything is current
const pub = await publishRetry(aug);
check('8  publishes once every item is confirmed and current', pub.status === 200, `${pub.status} ${codes(pub).join(',')}`);

// 9. a published period is untouched
const c6 = await transition('check', aug);
check('9a a published period is not re-evaluated', c6.body?.checklist === null && c6.body?.review === null);
check('9b ...and its checklist cannot be changed', (await transition('unconfirm_checklist', aug, { item: 'cash_confirmed' })).status === 409);

// 10. a revision starts unconfirmed; the original keeps its record
const r = await transition('create_revision', aug, { reason: 'Fictional staging test: checklist on a revision.' });
const rid = r.body?.period_id;
for (let i = 0; i < 10 && (await E.ReportingPeriod.get(rid)).copy_status !== 'verified'; i++) await transition('copy_revision', rid);
const rev = await E.ReportingPeriod.get(rid);
const orig = await E.ReportingPeriod.get(aug);
const itemKeys = (c) => Object.keys(c || {}).filter((k) => KEYS.includes(k)); // not the _revision stamp
check('10 a revision starts with no confirmations; the original keeps all 7', itemKeys(rev.checklist_confirmations).length === 0 && itemKeys(orig.checklist_confirmations).length === 7, `revision ${itemKeys(rev.checklist_confirmations).length}, original ${itemKeys(orig.checklist_confirmations).length}`);
await transition('discard_revision', rid);

const failed = results.filter((x) => !x).length;
fs.writeFileSync('.checklist-scenario.json', JSON.stringify({ year, jul, aug }));
log(`\n${results.length - failed} passed, ${failed} failed; fictional year ${year}`);
