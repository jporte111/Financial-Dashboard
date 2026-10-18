// Hosted staging test for draft revisions. STAGING APP ONLY, fictional data.
//
// Run from the staging checkout (linked to the staging app), with the
// owner-only .staging.env holding STAGING_APP_ID and STAGING_TOKEN:
//   node scripts/verify-staging-revisions.mjs [--only=copy,lifecycle,interrupt,concurrency]
//
// Every period it creates is labelled "ZZ TEST ..." with an invented year and
// is shaped like the largest real month (about 400 rows, mostly transactions).
// States that cannot be produced from outside a running function (a copy cut
// off half-way, a publish that died after its first write) are SIMULATED with
// owner-privileged writes on the staging app (`base44 exec --privileged`),
// then the real hosted recovery is run against them.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@base44/sdk';
import { planBvaImport, importTarget } from '../src/lib/bvaImport.js';
import { validateBva } from '../src/lib/bvaValidation.js';
import { cleanParsed } from '../src/lib/__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';
import { monthState } from '../base44/shared/periodVersions.ts';
import { withPublishExpect } from '../src/lib/__fixtures__/publishExpect.js';

const STAGING = '6ac5040ff86172a58191d35a';
const PRODUCTION = '6a80ccf1dac2259ae9870f29';
const env = Object.fromEntries(fs.readFileSync('.staging.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const link = fs.readFileSync('base44/.app.jsonc', 'utf8');
if (env.STAGING_APP_ID !== STAGING || !link.includes(STAGING) || link.includes(PRODUCTION)) { console.log('Refusing: not linked to the staging app.'); process.exit(2); }
const only = new Set((process.argv.find((a) => a.startsWith('--only=')) || '--only=copy,lifecycle,interrupt,concurrency').slice(7).split(','));
console.error = () => {};
const log = console.log;
const results = [];
const check = (test, name, ok, detail = '') => { results.push({ test, name, ok }); log(`${ok ? 'PASS' : 'FAIL'}  [${test}] ${name}${detail ? `  (${detail})` : ''}`); };
const info = (msg) => log(`      ${msg}`);
const status = (e) => e?.status || e?.response?.status || 'err';
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: status(e), data: e?.response?.data ?? e?.data }; } };
const admin = createClient({ appId: STAGING, token: env.STAGING_TOKEN, requiresAuth: false });
const E = admin.entities;
const calls = { transition: 0 };
const transition = async (action, period_id, extra = {}) => {
  const body = await withPublishExpect(admin.entities, { action, period_id, ...extra });
  calls.transition += 1;
  const r = await attempt(() => admin.functions.invoke('periodTransition', body));
  return r.ok ? { status: 200, body: r.value?.data ?? r.value } : { status: r.status, body: r.data || {} };
};
const served = async () => {
  const r = await attempt(() => admin.functions.invoke('publicDashboard', {}));
  return r.ok ? (r.value?.data ?? r.value) : null;
};
const servedFor = async (pid) => {
  const r = await attempt(() => admin.functions.invoke('publicDashboard', { period_id: pid }));
  return r.ok ? (r.value?.data ?? r.value) : null;
};
// Owner-privileged writes on the staging app, to SIMULATE interrupted states.
const privileged = (code) => execFileSync('npx', ['base44', 'exec', '--privileged'], {
  input: `if (Deno.env.get('BASE44_APP_ID') !== '${STAGING}') throw new Error('not staging');\n${code}`,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
const ENTS = ['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend', 'Transaction'];
const rows = async (entity, pid) => (await E[entity].filter({ period_id: pid }, undefined, 5000)) || [];
const listMonth = async (month, year) => ((await E.ReportingPeriod.filter({ month, year }, undefined, 200)) || []);
const stateOf = async (month, year) => monthState(await listMonth(month, year));
const servedMonth = async (month, year) => ((await served())?.periods || []).filter((p) => p.month === month && p.year === year);
const CHECKLIST = Object.fromEntries(PUBLISH_CHECKLIST.map(([k]) => [k, true]));

// ---- a fictional period shaped like the largest real month --------------------
const usedYears = new Set((await E.ReportingPeriod.list('-year', 500)).map((p) => p.year));
const freshYear = () => { let y; do y = 3000 + Math.floor(Math.random() * 6000); while (usedYears.has(y)); usedYears.add(y); return y; };
function workbookPlan(year, { cashDelta = 0 } = {}) {
  const parsed = cleanParsed();
  if (cashDelta && parsed.cash?.accounts?.length) {
    parsed.cash.accounts[0].balance = Math.round((Number(parsed.cash.accounts[0].balance) + cashDelta) * 100) / 100;
    if (parsed.cash.reportedTotal != null) parsed.cash.reportedTotal = Math.round((Number(parsed.cash.reportedTotal) + cashDelta) * 100) / 100;
  }
  const cutoffDate = `${year}-07-31`;
  const validation = validateBva(parsed, { cutoffDate, period: { month: 7, year } });
  const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
  return { parsed, validation, cutoffDate, groupMap };
}
// Confirm every checklist item through the server, checking each reply (the
// same rule in every hosted suite): retry only TRANSIENT refusals -- checks that
// could not run (Base44 rate limits), a change not verified as saved, or lines
// the server cannot see yet right after finalize (read lag). Anything else fails.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transientRefusal = (r) => r.status === 409 && (r.body?.blockers || []).some((b) => b.code === 'checklist_not_saved' || /could not run|could not be evaluated|Budget lines are incomplete/.test(b.message || ''));
async function confirmItem(pid, item) {
  let r = await transition('confirm_checklist', pid, { item });
  for (let i = 0; i < 6 && transientRefusal(r); i++) { await sleep(3700); r = await transition('confirm_checklist', pid, { item }); }
  return r;
}
async function confirmChecklist(pid) {
  for (const item of Object.keys(CHECKLIST)) {
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
async function finalizeAndPublish(pid, { publish = true } = {}) {
  const chk = await transition('check', pid);
  const overrides = Object.fromEntries((chk.body?.finalize?.blockers || []).filter((b) => b.overridable !== false).map((b) => [b.code, { reason: 'Fictional staging test period.' }]));
  let fin = await transition('finalize', pid, { overrides });
  // The function's reads can lag rows just created (import_incomplete), and a
  // finalize whose reply was lost is answered "already final": retry / accept.
  for (let i = 0; i < 10 && fin.status === 409 && (fin.body?.blockers || []).some((b) => b.code === 'import_incomplete'); i++) { await sleep(1500); fin = await transition('finalize', pid, { overrides }); }
  if (fin.status === 409 && (fin.body?.blockers || []).map((b) => b.code).join() === 'already_final' && (await E.ReportingPeriod.get(pid)).status === 'final') fin = { status: 200, body: { ok: true } };
  if (fin.status !== 200) return { fin, overrides };
    await confirmChecklist(pid); // checked, transient-only retry
  const pub = publish ? await publishRetry(pid) : null; // setup publish: transient-only retry
  return { fin, pub, overrides };
}
async function seedPublished({ publish = true } = {}) {
  const year = freshYear();
  const { parsed, validation, cutoffDate, groupMap } = workbookPlan(year);
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year, cutoffDate }, groupMap });
  const c = await transition('create', null, { data: { ...plan.periodWrite, label: `ZZ TEST July ${year}` } });
  const pid = c.body?.period_id;
  if (!pid) throw new Error(`create ${c.status} ${JSON.stringify(c.body)}`);
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
    if (plan[key].toCreate.length) await E[entity].bulkCreate(plan[key].toCreate.map((d) => ({ ...d, period_id: pid })));
  }
  const cats = plan.budgetLines.toCreate.map((l) => l.category);
  await E.SavingsSpend.bulkCreate(Array.from({ length: 4 }, (_, i) => ({ period_id: pid, category: `Test savings ${i + 1}`, ytd_amount: 100 + i })));
  const txns = Array.from({ length: 374 }, (_, i) => ({ period_id: pid, date: `${year}-07-${String((i % 28) + 1).padStart(2, '0')}`, amount: Math.round((10 + (i * 37) % 900) * 100) / 100, category: cats[i % cats.length], vendor: `Test vendor ${i % 40}`, description: `Fictional transaction ${i + 1}`, transaction_type: 'expense', treatment: 'personal', source: 'manual' }));
  for (let i = 0; i < txns.length; i += 100) await E.Transaction.bulkCreate(txns.slice(i, i + 100));
  // Base44 reads can lag rows just written: wait until every seeded row is
  // visible, so the copy under test starts from the complete original.
  const expected = ['budgetLines', 'cashAccounts', 'distributions', 'transfers'].reduce((t, k) => t + plan[k].toCreate.length, 0) + 4 + txns.length;
  for (let i = 0; i < 40; i++) {
    let seen = 0;
    for (const e of ENTS) seen += (await rows(e, pid)).length;
    if (seen >= expected) break;
    await sleep(1500);
  }
  const fp = await finalizeAndPublish(pid, { publish });
  if (fp.fin.status !== 200 || (publish && fp.pub.status !== 200)) throw new Error(`setup finalize ${fp.fin.status} ${JSON.stringify(fp.fin.body?.blockers || '')} publish ${fp.pub?.status} ${JSON.stringify((fp.pub?.body?.blockers || []).map((b) => b.code))}`);
  let count = 0;
  for (const e of ENTS) count += (await rows(e, pid)).length;
  return { pid, year, rowCount: count, overrides: fp.overrides };
}

// The original's full content: the record (state fields reported separately) and every row.
const STATE_FIELDS = new Set(['superseded', 'superseded_by', 'superseded_at', 'published', 'updated_date']);
async function snapshot(pid) {
  const p = await E.ReportingPeriod.get(pid);
  const record = Object.fromEntries(Object.entries(p).filter(([k]) => !STATE_FIELDS.has(k)));
  const children = {};
  for (const e of ENTS) children[e] = (await rows(e, pid)).map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
  return { record: JSON.stringify(Object.keys(record).sort().map((k) => [k, record[k]])), children: JSON.stringify(children), state: { published: !!p.published, superseded: !!p.superseded } };
}
const sameContent = (a, b) => a.record === b.record && a.children === b.children;
// What differs between two snapshots (field / entity names only), for the report.
const contentDiff = (a, b) => {
  const ra = Object.fromEntries(JSON.parse(a.record)), rb = Object.fromEntries(JSON.parse(b.record));
  const fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k]));
  const ca = JSON.parse(a.children), cb = JSON.parse(b.children);
  const ents = Object.keys(ca).filter((e) => JSON.stringify(ca[e]) !== JSON.stringify(cb[e])).map((e) => `${e}(${ca[e].length}->${cb[e].length})`);
  return [...fields, ...ents].join(',');
};
async function waitCopied(rid) {
  let r;
  for (let i = 0; i < 30; i++) {
    r = await transition('copy_revision', rid);
    if (r.body?.copy?.done) return r;
  }
  return r;
}

// ==== 1. hosted copy time and rate limits ======================================
let base = null;
if (only.has('copy') || only.has('lifecycle')) {
  log('\n== 1. copy of a ~400-row published period');
  base = await seedPublished();
  info(`seeded ${base.rowCount} rows (ZZ TEST July ${base.year})`);
  const before = await snapshot(base.pid);
  const t0 = Date.now();
  calls.transition = 0;
  const cr = await transition('create_revision', base.pid, { reason: 'Staging test: correct the fictional cash figure.' });
  let rid = cr.body?.period_id;
  const firstMs = Date.now() - t0;
  let done = cr.body?.copy;
  if (rid && !done?.done) done = (await waitCopied(rid)).body?.copy;
  const totalMs = Date.now() - t0;
  info(`create_revision: HTTP ${cr.status} in ${(firstMs / 1000).toFixed(1)} s (copy ${cr.body?.copy?.done ? 'finished in that call' : 'continued'}); total ${(totalMs / 1000).toFixed(1)} s over ${calls.transition} function call(s)`);
  check('copy', 'the copy completed and was verified', !!rid && done?.verified === true, `verified=${done?.verified}`);
  let copies = 0;
  for (const e of ENTS) copies += (await rows(e, rid)).length;
  check('copy', 'every row was copied once', copies === base.rowCount, `${copies} of ${base.rowCount}`);
  check('copy', 'within one Base44 function call limit (well under 5 minutes)', totalMs < 120000, `${(totalMs / 1000).toFixed(1)} s`);
  const servedNow = await servedMonth(7, base.year);
  check('copy', 'clients still see exactly the original', servedNow.length === 1 && servedNow[0].id === base.pid, `${servedNow.length} served`);
  check('6-original', 'original unchanged by creating the revision', sameContent(before, await snapshot(base.pid)) && (await snapshot(base.pid)).state.published === true);
  base.rid = rid;
  base.before = before;
}

// ==== 2. full lifecycle ========================================================
if (only.has('lifecycle') && base?.rid) {
  log('\n== 2. published → revision → corrected import + edit → finalize → publish replacement');
  const { pid, rid, year } = base;
  const periods = await E.ReportingPeriod.list('-year', 500);
  const tgt = importTarget(periods, 7, year);
  check('lifecycle', 'the importer targets the revision, not the published original', tgt.allowed && tgt.target?.id === rid, tgt.reason || '');
  const forced = importTarget(periods, 7, year, pid);
  check('lifecycle', 'choosing the original as the import target is refused', !forced.allowed, forced.reason || '');
  // The corrected workbook, applied as the import screen does (period first, then lines).
  const { parsed, validation, cutoffDate, groupMap } = workbookPlan(year, { cashDelta: 250 });
  const existing = { budgetLines: await rows('BudgetLine', rid), cashAccounts: await rows('CashAccount', rid), distributions: await rows('Distribution', rid), transfers: await rows('RecurringTransfer', rid) };
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year, cutoffDate }, existingPeriods: [tgt.target], existing, groupMap });
  if (tgt.needsInvalidate) await transition('invalidate', rid);
  const pw = await attempt(() => E.ReportingPeriod.update(rid, plan.periodWrite));
  let writes = 0, failedWrites = 0;
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
    const b = plan[key];
    if (b.toCreate.length) { const r = await attempt(() => E[entity].bulkCreate(b.toCreate.map((d) => ({ ...d, period_id: rid })))); r.ok ? (writes += 1) : (failedWrites += 1); }
    for (const u of b.toUpdate) { const r = await attempt(() => E[entity].update(u.id, u.data)); r.ok ? (writes += 1) : (failedWrites += 1); }
    for (const id of b.toDelete) { const r = await attempt(() => E[entity].delete(id)); r.ok ? (writes += 1) : (failedWrites += 1); }
  }
  check('lifecycle', 'the corrected import wrote into the revision', pw.ok && failedWrites === 0, `period ${pw.ok ? 'ok' : pw.status}; ${writes} line writes, ${failedWrites} refused`);
  // A Monthly Data edit on the revision.
  const savings = (await rows('SavingsSpend', rid))[0];
  const ed = await attempt(() => E.SavingsSpend.update(savings.id, { ytd_amount: 777 }));
  check('lifecycle', 'an edit on the revision is accepted', ed.ok, ed.ok ? '' : `HTTP ${ed.status}`);
  const fp = await finalizeAndPublish(rid);
  check('lifecycle', 'the revision passes the normal finalize checks', fp.fin.status === 200, `${fp.fin.status} ${(fp.fin.body?.blockers || []).map((b) => b.code).join(',')}`);
  check('lifecycle', 'publish replacement', fp.pub?.status === 200 && !fp.pub.body?.supersede_pending, `${fp.pub?.status} ${JSON.stringify(fp.pub?.body?.blockers || '')}`);
  const sm = await servedMonth(7, year);
  check('lifecycle', 'exactly one client-visible version, the revision', sm.length === 1 && sm[0].id === rid, `${sm.length} served`);
  const dash = await servedFor(pid); // a client still holding the old link
  check('lifecycle', 'the old link serves the revision, not the original', dash?.period?.id === rid);
  const cashOrig = (await rows('CashAccount', pid)).map((c) => c.balance).sort().join(',');
  const cashRev = (dash?.cashAccounts || []).map((c) => c.balance).sort().join(',');
  check('lifecycle', 'clients see the corrected figures', cashOrig !== cashRev && (dash?.savingsSpends || []).some((s) => s.ytd_amount === 777));
  const st = await stateOf(7, year);
  check('lifecycle', 'Admin state: no conflict, no unfinished replacement', !st.conflict && !st.pendingCleanup.length && st.current?.id === rid);
  const after = await snapshot(pid);
  check('6-original', 'original figures and rows unchanged by the whole lifecycle', sameContent(base.before, after), `state: published=${after.state.published} superseded=${after.state.superseded}`);
  const drillCategory = (await rows('BudgetLine', pid))[0].category;
  const drill = await attempt(() => admin.functions.invoke('publicCategoryTransactions', { period_id: pid, category: drillCategory }));
  check('lifecycle', 'drill-down refuses the superseded original', !drill.ok && drill.status === 403, drill.ok ? 'served' : `HTTP ${drill.status}`);
}

// ==== 3. interrupted copy and interrupted publish ===============================
if (only.has('interrupt')) {
  log('\n== 3a. interrupted copy (simulated: half the transactions copied, status "copying")');
  const s = await seedPublished();
  const before = await snapshot(s.pid);
  const rid = (await transition('create_revision', s.pid, { reason: 'Staging test: interrupted copy.' })).body?.period_id;
  await waitCopied(rid);
  privileged(`
    const tx = await base44.entities.Transaction.filter({ period_id: '${rid}' }, undefined, 5000);
    for (const r of tx.slice(0, Math.floor(tx.length / 2))) await base44.entities.Transaction.delete(r.id);
    await base44.entities.ReportingPeriod.update('${rid}', { copy_status: 'copying' });
  `);
  check('interrupt', 'an unfinished copy cannot be finalized', (await transition('finalize', rid)).body?.blockers?.[0]?.code === 'revision_copy_unverified');
  const t0 = Date.now();
  const resumed = await waitCopied(rid);
  info(`resume took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const txCount = (await rows('Transaction', rid)).length;
  check('interrupt', 'the resumed copy filled the gap and verified (no duplicates)', resumed.body?.copy?.verified === true && txCount === 374, `${txCount} transactions`);
  log('\n== 3b. a copy that duplicated a batch (simulated lost response)');
  privileged(`
    const tx = (await base44.entities.Transaction.filter({ period_id: '${rid}' }, undefined, 5000))[0];
    const { id, created_date, updated_date, created_by, created_by_id, ...rest } = tx;
    await base44.entities.Transaction.create(rest);
    await base44.entities.ReportingPeriod.update('${rid}', { copy_status: 'copying' });
  `);
  const dup = await waitCopied(rid);
  check('interrupt', 'verification detects the duplicate; the revision cannot be finalized', dup.body?.copy?.verified === false && (await transition('finalize', rid)).body?.blockers?.[0]?.code === 'revision_copy_unverified', JSON.stringify(dup.body?.copy?.report?.entities?.Transaction || {}).slice(0, 120));
  const disc = await transition('discard_revision', rid);
  let gone = disc.body?.done;
  for (let i = 0; i < 5 && !gone; i++) gone = (await transition('discard_revision', rid)).body?.done;
  // Reads can lag the deletes briefly: look again for a few seconds.
  let periodGone = false, left = -1;
  for (let i = 0; i < 10; i++) {
    periodGone = !(await attempt(() => E.ReportingPeriod.get(rid))).ok;
    left = (await rows('Transaction', rid)).length;
    if (periodGone && left === 0) break;
    await sleep(1500);
  }
  check('interrupt', 'the bad revision is discarded, rows and all', !!gone && periodGone && left === 0, `done ${!!gone}, period gone ${periodGone}, rows left ${left}`);
  const again = await transition('create_revision', s.pid, { reason: 'Staging test: recreate after discard.' });
  const again2 = again.body?.copy?.done ? again : await waitCopied(again.body?.period_id);
  check('interrupt', 'a fresh revision can be created and verified', again2.body?.copy?.verified === true);
  const r2 = again.body?.period_id;
  check('6-original', 'original unchanged through the interrupted copy', sameContent(before, await snapshot(s.pid)));

  log('\n== 3c. interrupted replacement publish (simulated: the switch write happened, the cleanup did not)');
  const fp = await finalizeAndPublish(r2, { publish: false });
  check('interrupt', 'revision finalized', fp.fin.status === 200);
  privileged(`await base44.entities.ReportingPeriod.update('${r2}', { published: true, publication_date: '${new Date().toISOString().slice(0, 10)}', reviewed_by: 'staging test (simulated interrupted publish)' });`);
  const st = await stateOf(7, s.year);
  check('interrupt', 'Admin state: awaiting cleanup, NOT a conflict', !st.conflict && st.pendingCleanup.map((v) => v.id).includes(s.pid) && st.current?.id === r2);
  const sm = await servedMonth(7, s.year);
  check('interrupt', 'clients see exactly one version (the revision) during the unfinished state', sm.length === 1 && sm[0].id === r2, `${sm.length} served`);
  check('interrupt', 'the original cannot be revised meanwhile', (await transition('create_revision', s.pid, { reason: 'Should be refused.' })).body?.blockers?.[0]?.code === 'supersede_pending');
  const pubDateBefore = (await E.ReportingPeriod.get(r2)).publication_date;
  const retry = await transition('publish', r2);
  check('interrupt', 'a retried publish only finishes the cleanup', retry.body?.already_published === true && retry.body?.supersede_pending === false);
  check('interrupt', 'no second switch (publication unchanged)', (await E.ReportingPeriod.get(r2)).publication_date === pubDateBefore);
  const fin = await stateOf(7, s.year);
  check('interrupt', 'state is clean afterwards', !fin.conflict && !fin.pendingCleanup.length && fin.current?.id === r2);
  check('6-original', 'original figures unchanged through the interrupted publish', sameContent(before, await snapshot(s.pid)));
}

// ==== 4. concurrency ============================================================
if (only.has('concurrency')) {
  log('\n== 4a. two revisions requested at the same moment (real race)');
  const s = await seedPublished();
  const before = await snapshot(s.pid);
  const [a, b] = await Promise.all([
    transition('create_revision', s.pid, { reason: 'Staging test: concurrent revision A.' }),
    transition('create_revision', s.pid, { reason: 'Staging test: concurrent revision B.' }),
  ]);
  info(`outcomes: ${a.status} ${a.body?.blockers?.[0]?.code || ''} / ${b.status} ${b.body?.blockers?.[0]?.code || ''}`);
  let st = await stateOf(7, s.year);
  info(`open revisions afterwards: ${st.openRevisions.length}`);
  check('concurrency', 'at most one open revision survives a simultaneous request', st.openRevisions.length <= 1, `${st.openRevisions.length} open`);
  let rA = st.openRevisions[0]?.id;
  for (const r of st.openRevisions) await waitCopied(r.id);

  log('\n== 4b. two final revisions published at the same moment (second revision SIMULATED as created in the same instant)');
  // A competing revision the guard would normally prevent: a privileged clone of revision A.
  const cloneOut = privileged(`
    const src = await base44.entities.ReportingPeriod.get('${rA}');
    const { id, created_date, updated_date, created_by, created_by_id, ...rest } = src;
    const b = await base44.entities.ReportingPeriod.create({ ...rest, revision_reason: 'Staging test: competing revision (simulated).' });
    for (const e of ${JSON.stringify(ENTS)}) {
      const rs = await base44.entities[e].filter({ period_id: '${rA}' }, undefined, 5000);
      const list = rs.map(({ id, created_date, updated_date, created_by, created_by_id, ...r }) => ({ ...r, period_id: b.id }));
      for (let i = 0; i < list.length; i += 100) await base44.entities[e].bulkCreate(list.slice(i, i + 100));
    }
    console.log('CLONE=' + b.id);
  `);
  const rB = (cloneOut.match(/CLONE=([0-9a-f]+)/) || [])[1];
  await finalizeAndPublish(rA, { publish: false });
  await finalizeAndPublish(rB, { publish: false });
  const [pa, pb] = await Promise.all([transition('publish', rA), transition('publish', rB)]);
  info(`publish outcomes: A ${pa.status} ${pa.body?.blockers?.[0]?.code || ''}${pa.body?.conflict ? ' conflict reported' : ''} / B ${pb.status} ${pb.body?.blockers?.[0]?.code || ''}${pb.body?.conflict ? ' conflict reported' : ''}`);
  st = await stateOf(7, s.year);
  const bothPublished = pa.status === 200 && pb.status === 200;
  if (bothPublished) {
    check('concurrency', 'both publishes passed (no mutual exclusion) -- and the conflict was detected', !!st.conflict && (pa.body?.conflict || pb.body?.conflict || true), `conflict: ${st.conflict?.length || 0} versions`);
  } else {
    check('concurrency', 'one publish was refused as stale; no conflict', !st.conflict && [pa, pb].some((r) => r.body?.blockers?.[0]?.code === 'stale_revision'));
  }
  const sm = await servedMonth(7, s.year);
  check('concurrency', 'clients are served exactly one version even so', sm.length === 1, `${sm.length} served`);
  if (st.conflict) {
    check('concurrency', 'Admin: further revisions of the month are blocked during the conflict', (await transition('create_revision', st.conflict[0].id, { reason: 'Should be refused.' })).body?.blockers?.[0]?.code === 'version_conflict');
    // Resolution: reopen the version that should not be published (Exceptional administrative action).
    const loser = st.conflict.find((v) => v.id !== sm[0]?.id) || st.conflict[1];
    const re = await transition('reopen', loser.id, { reason: 'Staging test: resolve the competing publication.', confirm: loser.label });
    const after = await stateOf(7, s.year);
    check('concurrency', 'resolving by reopening one version clears the conflict', re.status === 200 && !after.conflict && after.current?.id !== loser.id, `reopen ${re.status}`);
    const disc = await transition('discard_revision', loser.id);
    check('concurrency', 'the reopened competing revision can be discarded', disc.status === 200);
  }
  const afterC = await snapshot(s.pid);
  check('6-original', 'original figures unchanged through the concurrency tests', sameContent(before, afterC), sameContent(before, afterC) ? '' : contentDiff(before, afterC));
}

// ==== 1b. rate limits under a burst: three ~400-row copies at once ==============
if (only.has('burst')) {
  log('\n== 1b. burst: three ~400-row revisions copied at the same moment');
  const seeds = [];
  for (let i = 0; i < 3; i++) seeds.push(await seedPublished());
  const befores = await Promise.all(seeds.map((x) => snapshot(x.pid)));
  const t0 = Date.now();
  const res = await Promise.all(seeds.map(async (x) => {
    const t = Date.now();
    const cr = await transition('create_revision', x.pid, { reason: 'Staging test: burst copy.' });
    const done = cr.body?.copy?.done ? cr : await waitCopied(cr.body?.period_id);
    return { ms: Date.now() - t, verified: done.body?.copy?.verified, status: cr.status };
  }));
  info(`each: ${res.map((r) => `${(r.ms / 1000).toFixed(1)} s (${r.status}, verified=${r.verified})`).join('; ')}; all done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('burst', 'all three copies completed and verified', res.every((r) => r.verified === true));
  for (let i = 0; i < seeds.length; i++) check('6-original', `original ${i + 1} unchanged by the burst`, sameContent(befores[i], await snapshot(seeds[i].pid)));
}

// ==== 5. rollback states: set up with the new code, then inspected with each code version ====
const STATES_FILE = '.rollback-states.json';
if (only.has('rollback-setup')) {
  log('\n== 5. setting up the states a rollback would meet');
  const clean = await seedPublished();
  const cr = await transition('create_revision', clean.pid, { reason: 'Staging test: replaced month before rollback.' });
  await waitCopied(cr.body.period_id);
  await finalizeAndPublish(cr.body.period_id);
  const open = await seedPublished();
  const ro = (await transition('create_revision', open.pid, { reason: 'Staging test: open revision before rollback.' })).body.period_id;
  await waitCopied(ro);
  const ready = await seedPublished();
  const rr = (await transition('create_revision', ready.pid, { reason: 'Staging test: final revision before rollback.' })).body.period_id;
  await waitCopied(rr);
  await finalizeAndPublish(rr, { publish: false });
  const pending = await seedPublished();
  const rp = (await transition('create_revision', pending.pid, { reason: 'Staging test: unfinished replacement before rollback.' })).body.period_id;
  await waitCopied(rp);
  await finalizeAndPublish(rp, { publish: false });
  privileged(`await base44.entities.ReportingPeriod.update('${rp}', { published: true, publication_date: '${new Date().toISOString().slice(0, 10)}' });`);
  const states = {
    clean: { year: clean.year, original: clean.pid, revision: cr.body.period_id },
    open: { year: open.year, original: open.pid, revision: ro },
    ready: { year: ready.year, original: ready.pid, revision: rr },
    pending: { year: pending.year, original: pending.pid, revision: rp },
  };
  const snaps = {};
  for (const [k, v] of Object.entries(states)) snaps[k] = await snapshot(v.original);
  fs.writeFileSync(STATES_FILE, JSON.stringify({ states, snaps }));
  for (const [k, v] of Object.entries(states)) info(`${k}: served ${(await servedMonth(7, v.year)).length} version(s)`);
}
if (only.has('rollback-observe')) {
  const label = process.env.CODE_LABEL || 'current code';
  log(`\n== 5. observing the rollback states with ${label}`);
  const { states, snaps } = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
  for (const [k, v] of Object.entries(states)) {
    const sm = await servedMonth(7, v.year);
    check(`rollback/${label}`, `${k}: clients served one version of the month`, sm.length === 1, `${sm.length} served: ${sm.map((p) => (p.id === v.original ? 'original' : p.id === v.revision ? 'revision' : 'other')).join(', ')}`);
  }
  if (process.env.TRY_OLD_PUBLISH === '1') {
    const r = await transition('publish', states.ready.revision);
    info(`old-code publish of the ready revision: HTTP ${r.status}${r.body?.blockers ? ` ${r.body.blockers.map((b) => b.code).join(',')}` : ''}`);
    const sm = await servedMonth(7, states.ready.year);
    check(`rollback/${label}`, 'ready: after publishing the revision with this code, clients served one version', sm.length === 1, `${sm.length} served`);
    // The old import path into the month: first match by month/year.
    const all = await E.ReportingPeriod.list('-year', 500);
    const m = all.find((p) => p.month === 7 && p.year === states.clean.year && !p.published);
    if (m) {
      const inv = await transition('invalidate', m.id);
      const w = inv.status === 200 ? await attempt(() => E.ReportingPeriod.update(m.id, { total_cash: 1 })) : { ok: false };
      check(`rollback/${label}`, `clean: an old-style import into the ${m.id === states.clean.original ? 'superseded original' : 'month'} is refused`, !w.ok, `invalidate ${inv.status}; write ${w.ok ? 'ACCEPTED' : 'refused'}`);
    }
  }
  for (const [k, v] of Object.entries(states)) check('6-original', `${k}: original figures unchanged (${label})`, sameContent(snaps[k], await snapshot(v.original)));
}

// ==== 4c. the Admin conflict state and its resolution ===========================
if (only.has('conflict')) {
  log('\n== 4c. two published competing revisions (SIMULATED: the race outcome Base44 cannot prevent)');
  const s = await seedPublished();
  const before = await snapshot(s.pid);
  const rA = (await transition('create_revision', s.pid, { reason: 'Staging test: conflict revision A.' })).body?.period_id;
  await waitCopied(rA);
  await finalizeAndPublish(rA, { publish: false });
  const out = privileged(`
    const src = await base44.entities.ReportingPeriod.get('${rA}');
    const { id, created_date, updated_date, created_by, created_by_id, ...rest } = src;
    const b = await base44.entities.ReportingPeriod.create({ ...rest, revision_reason: 'Staging test: competing revision (simulated).' });
    for (const e of ${JSON.stringify(ENTS)}) {
      const rs = await base44.entities[e].filter({ period_id: '${rA}' }, undefined, 5000);
      const list = rs.map(({ id, created_date, updated_date, created_by, created_by_id, ...r }) => ({ ...r, period_id: b.id }));
      for (let i = 0; i < list.length; i += 100) await base44.entities[e].bulkCreate(list.slice(i, i + 100));
    }
    const day = new Date().toISOString().slice(0, 10);
    // Both switch writes landed (as when two publishes pass their checks together).
    await base44.entities.ReportingPeriod.update('${rA}', { published: true, publication_date: day });
    await base44.entities.ReportingPeriod.update(b.id, { published: true, publication_date: day });
    console.log('CLONE=' + b.id);
  `);
  const rB = (out.match(/CLONE=([0-9a-f]+)/) || [])[1];
  const st = await stateOf(7, s.year);
  check('conflict', 'Admin state: a CONFLICT between the two revisions (not "awaiting cleanup")', st.conflict?.length === 2 && st.conflict.every((v) => [rA, rB].includes(v.id)), `conflict ${st.conflict?.length || 0}, pending ${st.pendingCleanup.length}`);
  const sm = await servedMonth(7, s.year);
  check('conflict', 'clients are served exactly one version (display order, flagged in Admin)', sm.length === 1 && [rA, rB].includes(sm[0].id), `${sm.length} served`);
  check('conflict', 'creating another revision is blocked during the conflict', (await transition('create_revision', sm[0].id, { reason: 'Should be refused.' })).body?.blockers?.[0]?.code === 'version_conflict');
  check('conflict', 'publishing the original again is refused', (await transition('publish', s.pid)).status !== 200);
  const keep = sm[0].id;
  const drop = keep === rA ? rB : rA;
  const dropLabel = (await E.ReportingPeriod.get(drop)).label;
  const re = await transition('reopen', drop, { reason: 'Staging test: resolve the competing publication.', confirm: dropLabel });
  const after = await stateOf(7, s.year);
  check('conflict', 'resolution: reopening the unwanted version clears the conflict', re.status === 200 && !after.conflict && after.current?.id === keep, `reopen ${re.status}`);
  const sm2 = await servedMonth(7, s.year);
  check('conflict', 'clients see the kept version', sm2.length === 1 && sm2[0].id === keep);
  const fin = await transition('finish_supersede', keep);
  check('conflict', 'finishing the replacement marks the original superseded', fin.status === 200 && (await E.ReportingPeriod.get(s.pid)).superseded === true, `HTTP ${fin.status}`);
  let gone = (await transition('discard_revision', drop)).body?.done;
  for (let i = 0; i < 5 && !gone; i++) gone = (await transition('discard_revision', drop)).body?.done;
  check('conflict', 'the reopened competing revision is discarded', !!gone);
  check('6-original', 'original figures unchanged through the conflict and its resolution', sameContent(before, await snapshot(s.pid)));
}

const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
for (const t of [...new Set(results.map((r) => r.test))]) log(`  ${t}: ${results.filter((r) => r.test === t && !r.ok).length ? 'FAIL' : 'PASS'} (${results.filter((r) => r.test === t).length} checks)`);
process.exit(failed ? 1 : 0);
