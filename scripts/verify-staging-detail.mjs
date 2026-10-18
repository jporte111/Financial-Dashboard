// Hosted staging test for Phase 5b transaction detail. STAGING
// APP ONLY, fictional data. Built on the Phase 4 suite's setup helpers.
//
// Run from the staging checkout (linked to the staging app), with the
// owner-only .staging.env holding STAGING_APP_ID and STAGING_TOKEN:
//   node scripts/verify-staging-detail.mjs
//
// Every period it creates is labelled "ZZ TEST ..." with an invented year; the
// attached transaction detail is a FICTIONAL Transaction Report of about 2,600
// rows (src/lib/__fixtures__/detailWorkbook.js), the size of the real export.
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
import { readDetailReport, buildDetailRows, chunkRows, validationPackage, normPath } from '../base44/shared/detailReport.ts';
import { makeDetailModel } from '../src/lib/__fixtures__/detailWorkbook.js';
import { withPublishExpect } from '../src/lib/__fixtures__/publishExpect.js';

const STAGING = '6ac5040ff86172a58191d35a';
const PRODUCTION = '6a80ccf1dac2259ae9870f29';
const env = Object.fromEntries(fs.readFileSync('.staging.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const link = fs.readFileSync('base44/.app.jsonc', 'utf8');
if (env.STAGING_APP_ID !== STAGING || !link.includes(STAGING) || link.includes(PRODUCTION)) { console.log('Refusing: not linked to the staging app.'); process.exit(2); }
// --only=A,B,C,D picks scenarios (default all); --cycles=N sets D's publish ->
// immediate-upload cycles (default 4).
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




// ==== Phase 5b: transaction detail on the hosted backend ==========================
const rowsOf = async (pid) => ((await E.TransactionDetailChunk.filter({ period_id: pid }, 'seq', 2000)) || []);
const importId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
async function attach(pid, model, { tamper = null } = {}) {
  const period = await E.ReportingPeriod.get(pid);
  const maps = new Map(((await E.DetailAccountMap.list('-created_date', 5000)) || []).map((m) => [normPath(m.account_path), m.plain_name]));
  const built = buildDetailRows(readDetailReport(model), { cutoff: period.reporting_cutoff_date, year: period.year }, maps);
  const id = importId();
  const parts = chunkRows(built.rows);
  for (let seq = 0; seq < parts.length; seq++) {
    const st = await transition('stage_detail', pid, { import_id: id, seq, rows: tamper && seq === 0 ? tamper(structuredClone(parts[seq])) : parts[seq] });
    if (st.status !== 200) return { stage: st, built };
  }
  const pkg = validationPackage(model);
  const commit = await transition('commit_detail', pid, { import_id: id, package: pkg, file: { name: 'ZZ Transaction Report.xlsx', sha256: 'f'.repeat(64) } });
  return { commit, built, id, bytes: JSON.stringify(pkg).length };
}
const fingerprint = (chunks) => JSON.stringify(chunks.map((c) => [c.import_id, c.seq, (c.rows || []).length, (c.rows || []).reduce((s, r) => s + r.a, 0)]).sort());

log('\n== 5b. attach the Transaction Report (fictional, full size) to a final but unpublished report');
const s = await seedPublished({ publish: false });
const year = s.year;
const model = makeDetailModel({ year, scale: 30, cutoffMonth: 7, seed: year % 97 });
const total = readDetailReport(model).transactions.length;
let t0 = Date.now();
const a1 = await attach(s.pid, model);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
let p = await E.ReportingPeriod.get(s.pid);
check('5b', 'full-size detail attaches (staged, re-checked on the server, switched in one write)', a1.commit?.status === 200 && p.detail_import?.status === 'attached', `${total} rows in the report, ${a1.built.rows.length} through the cutoff, ${a1.built.after.count} after it; package ${Math.round(a1.bytes / 1024)} KB; ${secs}s; ${a1.commit?.status} ${JSON.stringify(a1.commit?.body?.blockers || a1.stage?.body || '')}`);
check('5b', 'stored rows = rows through the cutoff; later rows counted, not stored', p.detail_import?.rows_stored === a1.built.rows.length && p.detail_import?.after_cutoff?.count === a1.built.after.count);
let stored = await rowsOf(s.pid);
check('5b', 'every stored chunk is readable and belongs to the attached import', stored.length === p.detail_import?.chunks && stored.every((c) => c.import_id === p.detail_import.import_id) && stored.flatMap((c) => c.rows).length === p.detail_import.rows_stored, `${stored.length} chunks`);
check('5b', 'all three checks recorded as passed', (p.detail_import?.checks || []).every((c) => c.ok) && ['sum', 'balances', 'subtotals'].every((k) => (p.detail_import?.checks || []).some((c) => c.key === k)));
check('5b', 'per-line reconciliation stored (BVA total, detail total, difference, status)', (p.detail_import?.reconciliation?.lines || []).length > 0 && p.detail_import.reconciliation.lines.every((e) => 'bva_total' in e && 'detail_total' in e && 'difference' in e && e.status), (p.detail_import?.reconciliation?.lines || []).map((e) => `${e.key}:${e.status}`).join(' '));
check('5b', 'no Transaction records were written', (await rows('Transaction', s.pid)).length === 374);
const direct = await attempt(() => E.TransactionDetailChunk.create({ period_id: s.pid, import_id: importId(), seq: 99, rows: [] }));
check('5b', 'an admin cannot write detail directly (server only)', !direct.ok, `${direct.status}`);

log('\n== 5b. fail safely');
const bad = structuredClone(model); bad.rows.find((x) => /^\d\d\//.test(String(x.B || ''))).I += 0.01;
const before = JSON.stringify((await E.ReportingPeriod.get(s.pid)).detail_import);
const a2 = await attach(s.pid, bad);
check('5b', 'a report that fails its checks is refused; the attached detail is unchanged', a2.commit?.status === 409 && a2.commit.body?.blockers?.[0]?.code === 'detail_checks_failed' && JSON.stringify((await E.ReportingPeriod.get(s.pid)).detail_import) === before, `${a2.commit?.status} ${a2.commit?.body?.blockers?.[0]?.code}`);
const a3 = await attach(s.pid, model, { tamper: (r) => { r[0].a += 1; return r; } });
check('5b', 'staged rows that do not match the file are refused', a3.commit?.status === 409 && a3.commit.body?.blockers?.[0]?.code === 'detail_staged_mismatch', `${a3.commit?.status} ${a3.commit?.body?.blockers?.[0]?.code}`);

log('\n== 5b. review, publish, public drill-down');
const chk = await transition('check', s.pid);
const causes = chk.body?.review?.causes || [];
check('5b', 'reconciliation differences are review warnings, never blockers', !causes.some((c) => c.bucket === 'blockers' && c.key === 'transaction_detail') && (causes.some((c) => c.key === 'transaction_detail' && c.bucket === 'warnings') || !(p.detail_import?.reconciliation?.lines || []).some((e) => e.status === 'difference')));
const pub = await publishRetry(s.pid);
check('5b', 'the report publishes with detail attached', pub.status === 200, `${pub.status} ${JSON.stringify(pub.body?.blockers || '')}`);
p = await E.ReportingPeriod.get(s.pid);
const lines = await rows('BudgetLine', s.pid);
const gLine = lines.find((l) => ['fixed', 'variable', 'discretionary'].includes(l.budget_group) && !l.bva_detail);
const pc = await attempt(() => admin.functions.invoke('publicCategoryTransactions', { period_id: s.pid, budget_line_id: gLine.id }));
const body = pc.ok ? (pc.value?.data ?? pc.value) : {};
const fields = new Set((body.transactions || []).flatMap((t) => Object.keys(t)));
check('5b', 'public drill-down: exactly date, payee, signed amount, plain account name', pc.ok && body.detail_available === true && (body.transactions || []).length > 0 && [...fields].sort().join() === 'account,amount,date,payee', `${(body.transactions || []).length} rows; fields ${[...fields].join(',')}`);
check('5b', 'public drill-down: nothing internal (memo, card, path, type)', !/ZZ MEMO|ZZ Card 0001|ZZ Bank 0002|COSTS:|Credit Card Credit/.test(JSON.stringify(body)));
check('5b', 'public drill-down: the neutral note', typeof body.note === 'string' && /report/.test(body.note), body.note);
const wLine = lines.find((l) => l.bva_detail && l.qb_code);
if (wLine) {
  const e = (p.detail_import.reconciliation.lines || []).find((x) => x.line_id === wLine.id);
  const wc = await attempt(() => admin.functions.invoke('publicCategoryTransactions', { period_id: s.pid, budget_line_id: wLine.id }));
  const wb = wc.ok ? (wc.value?.data ?? wc.value) : {};
  check('5b', 'a watch-list line that does not reconcile shows no rows (only the note)', !e || e.status === 'reconciled' || ((wb.transactions || []).length === 0 && /isn't shown/.test(wb.note || '')), `${e?.status}`);
}
const frozen = await attach(s.pid, model);
check('5b', 'the published report is frozen (attach refused)', (frozen.stage?.status === 409 && frozen.stage.body?.blockers?.[0]?.code === 'detail_frozen'), `${frozen.stage?.status} ${frozen.stage?.body?.blockers?.[0]?.code}`);

log('\n== 5b. Phase 4: a correction copies the detail; the published detail never changes');
const pubPrint = fingerprint(await rowsOf(s.pid));
let prep = await transition('prepare_import', null, { month: 7, year, filename: 'ZZ corrected.xlsx' });
for (let i = 0; i < 8 && prep.status === 409 && ['copy_in_progress', 'copy_unverified', 'state_settling'].includes(prep.body?.blockers?.[0]?.code); i++) { await sleep(4000); prep = await transition('prepare_import', null, { month: 7, year, filename: 'ZZ corrected.xlsx' }); }
const rid = prep.body?.target_id;
const rev = rid ? await E.ReportingPeriod.get(rid) : null;
const revChunks = rid ? await rowsOf(rid) : [];
check('5b', 'the correction starts with a verified copy of the published detail', prep.status === 200 && rev?.copy_status === 'verified' && rev?.detail_import?.status === 'attached' && revChunks.flatMap((c) => c.rows).length === rev.detail_import.rows_stored, `${prep.status} ${prep.body?.mode || prep.body?.blockers?.[0]?.code} copy ${rev?.copy_status}`);
if (rid) {
  const later = makeDetailModel({ year, scale: 30, cutoffMonth: 7, seed: (year % 97) + 1 });
  const a4 = await attach(rid, later);
  check('5b', 'a later export attaches to the correction only', a4.commit?.status === 200, `${a4.commit?.status} ${JSON.stringify(a4.commit?.body?.blockers || '')}`);
  check('5b', 'the correction keeps only its new import (older chunks removed)', new Set((await rowsOf(rid)).map((c) => c.import_id)).size === 1);
  check('5b', 'the published version\'s detail is byte-for-byte unchanged', fingerprint(await rowsOf(s.pid)) === pubPrint);
  const disc = await transition('discard_revision', rid);
  let left = -1;
  for (let i = 0; i < 10; i++) { left = (await rowsOf(rid)).length; if (left === 0) break; await sleep(1500); }
  check('5b', 'discarding the correction removes its detail', disc.status === 200 && left === 0, `${disc.status}; ${left} chunks left`);
}
const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
