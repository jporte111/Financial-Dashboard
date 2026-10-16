// Hosted staging test for the updated-BVA workflow (prepare_import). STAGING
// APP ONLY, fictional data. Built on the Phase 4 suite's setup helpers.
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
import { planBvaImport, importTarget, importIntent } from '../src/lib/bvaImport.js';
import { changeSummary, planRecords } from '../src/lib/bvaChangeSummary.js';
import { validateBva } from '../src/lib/bvaValidation.js';
import { cleanParsed } from '../src/lib/__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';
import { monthState } from '../base44/shared/periodVersions.ts';

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
  calls.transition += 1;
  const r = await attempt(() => admin.functions.invoke('periodTransition', { action, period_id, ...extra }));
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


// ---- helpers -------------------------------------------------------------------
const prepare = (month, year, extra = {}) => transition('prepare_import', null, { month, year, filename: 'ZZ Test Updated BVA.xlsx', ...extra });
const childRecords = async (pid) => ({
  period: await E.ReportingPeriod.get(pid),
  lines: await rows('BudgetLine', pid), cashAccounts: await rows('CashAccount', pid), distributions: await rows('Distribution', pid), transfers: await rows('RecurringTransfer', pid),
});
// Apply a workbook into `target` exactly as the import screen does: period first, then rows.
async function importInto(target, year, { cashDelta = 0 } = {}) {
  const { parsed, validation, cutoffDate, groupMap } = workbookPlan(year, { cashDelta });
  const existing = { budgetLines: await rows('BudgetLine', target.id), cashAccounts: await rows('CashAccount', target.id), distributions: await rows('Distribution', target.id), transfers: await rows('RecurringTransfer', target.id) };
  const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year, cutoffDate, filename: 'ZZ Test Updated BVA.xlsx' }, existingPeriods: [target], existing, groupMap });
  const pw = await attempt(() => E.ReportingPeriod.update(target.id, plan.periodWrite));
  let failed = pw.ok ? 0 : 1;
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
    const b = plan[key];
    if (b.toCreate.length) { const r = await attempt(() => E[entity].bulkCreate(b.toCreate.map((d) => ({ ...d, period_id: target.id })))); if (!r.ok) failed++; }
    for (const u of b.toUpdate) { const r = await attempt(() => E[entity].update(u.id, u.data)); if (!r.ok) failed++; }
    for (const id of b.toDelete) { const r = await attempt(() => E[entity].delete(id)); if (!r.ok) failed++; }
  }
  return { failed, plan };
}

// ==== A. a published month: upload the updated workbook ==========================
log('\n== A. published month -> upload updated BVA -> review changes -> finalize -> publish correction');
const s = await seedPublished();
const before = await snapshot(s.pid);
check('A', 'the screen says the upload becomes a correction', importIntent(await E.ReportingPeriod.list('-year', 500), 7, s.year).mode === 'correct');
const p1 = await prepare(7, s.year, { note: 'Fictional: bookkeeper corrected the cash block.' });
const rid = p1.body?.target_id;
const rev = rid ? await E.ReportingPeriod.get(rid) : null;
check('A', 'prepare_import created a draft revision of the published report, copy verified', p1.status === 200 && p1.body.mode === 'correct' && rev?.supersedes === s.pid && rev?.copy_status === 'verified' && !rev.published, `${p1.status} ${p1.body?.mode} ${JSON.stringify(p1.body?.blockers || '')}`);
check('A', 'the automatic revision reason names the file, the user and the date, plus the note', /^Updated BVA workbook ZZ Test Updated BVA\.xlsx uploaded by .+ on \d{4}-\d{2}-\d{2}\. Note: Fictional: bookkeeper corrected the cash block\.$/.test(rev?.revision_reason || ''), rev?.revision_reason);
const p2 = await prepare(7, s.year);
check('A', 'uploading again reuses the same correction (no second revision)', p2.status === 200 && p2.body.mode === 'continue' && p2.body.target_id === rid);
check('A', 'one open revision for the month', monthState(await listMonth(7, s.year)).openRevisions.length === 1);
// What changed (the screen's summary) before importing.
const upd = workbookPlan(s.year, { cashDelta: 250 });
const updPlan = planBvaImport({ parsed: upd.parsed, validation: upd.validation, confirm: { month: 7, year: s.year, cutoffDate: upd.cutoffDate }, groupMap: upd.groupMap });
const sumVsPublished = changeSummary(await childRecords(s.pid), planRecords(updPlan));
check('A', 'the change summary shows the changed cash (Total Cash +250) and nothing invented', !sumVsPublished.identical && sumVsPublished.headline.find((h) => h.label === 'Total Cash')?.changed && sumVsPublished.cash.changed.length === 1, `${sumVsPublished.totalChanges} change(s)`);
const same = workbookPlan(s.year);
const samePlan = planBvaImport({ parsed: same.parsed, validation: same.validation, confirm: { month: 7, year: s.year, cutoffDate: same.cutoffDate }, groupMap: same.groupMap });
check('A', 'the original workbook uploaded again is identical to the published report (nothing to correct)', changeSummary(await childRecords(s.pid), planRecords(samePlan)).identical);
const tgt = importTarget(await E.ReportingPeriod.list('-year', 500), 7, s.year, rid);
check('A', 'the importer targets the revision', tgt.allowed && tgt.target?.id === rid, tgt.reason || '');
const imp = await importInto(tgt.target, s.year, { cashDelta: 250 });
check('A', 'the updated workbook is imported into the revision', imp.failed === 0);
check('A', 'transactions copied with the published report are untouched by the import', (await rows('Transaction', rid)).length === 374);
check('A', 'the published report is unchanged by everything so far', sameContent(before, await snapshot(s.pid)), contentDiff(before, await snapshot(s.pid)));
check('A', 'clients still see the published report', (await servedMonth(7, s.year)).map((p) => p.id).join() === s.pid);
let identicalNow = false;
for (let i = 0; i < 10 && !identicalNow; i++) { identicalNow = changeSummary(await childRecords(rid), planRecords(updPlan)).identical; if (!identicalNow) await sleep(1500); }
check('A', 'the same updated workbook again is "already imported" (identical to the correction)', identicalNow);
const fp = await finalizeAndPublish(rid);
check('A', 'the correction finalizes and publishes', fp.fin.status === 200 && fp.pub?.status === 200 && !fp.pub.body?.supersede_pending, `${fp.fin.status}/${fp.pub?.status} ${JSON.stringify(fp.pub?.body?.blockers || fp.fin.body?.blockers || '')}`);
let shown = [];
for (let i = 0; i < 10; i++) { shown = (await servedMonth(7, s.year)).map((p) => p.id); if (shown.join() === rid) break; await sleep(1500); }
check('A', 'clients now see the correction (one version)', shown.join() === rid, shown.join());
const orig = await E.ReportingPeriod.get(s.pid);
check('A', 'the replaced version is kept, superseded and unpublished', orig.superseded === true && orig.published === false && orig.superseded_by === rid);
const after = await snapshot(s.pid);
check('A', 'the replaced version\'s figures and rows are unchanged', sameContent(before, after), contentDiff(before, after));
const p3 = await prepare(7, s.year);
check('A', 'after publishing, a further upload starts a new correction of the published correction', p3.status === 200 && p3.body.mode === 'correct' && (await E.ReportingPeriod.get(p3.body.target_id)).supersedes === rid);
if (p3.body?.target_id) await transition('discard_revision', p3.body.target_id); // tidy

// ==== B. two uploads at the same moment =========================================
log('\n== B. two simultaneous uploads for a published month');
const s2 = await seedPublished();
const [b1, b2] = await Promise.all([prepare(7, s2.year), prepare(7, s2.year)]);
let open = [];
for (let i = 0; i < 10; i++) { open = monthState(await listMonth(7, s2.year)).openRevisions; if (open.length === 1) break; await sleep(1000); }
const ok = [b1, b2].filter((r) => r.status === 200);
check('B', 'one revision results; every successful upload targets it', open.length === 1 && ok.length >= 1 && ok.every((r) => r.body.target_id === open[0].id), `${open.length} open; ${[b1, b2].map((r) => `${r.status}:${r.body?.mode || r.body?.blockers?.[0]?.code}`).join(' ')}`);
for (const r of open) await transition('discard_revision', r.id);

// ==== C. a month not yet published: updated in place ============================
log('\n== C. unpublished month -> update the draft in place');
const s3 = await seedPublished({ publish: false }); // finalized, not published
const c1 = await prepare(7, s3.year);
check('C', 'a final but unpublished month is updated in place (no revision)', c1.status === 200 && c1.body.mode === 'update' && c1.body.target_id === s3.pid);
check('C', 'no revision was created', (await listMonth(7, s3.year)).length === 1);

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
