// Draft revisions against a LOCAL Base44 dev backend (throwaway data), with a
// fictional report -- including PARTIAL DEPLOYMENTS: run the backend from a
// copy whose entities (schemas + access rules) and/or functions come from
// `main`, and this script reports what clients would see and whether any
// write reached a published or replaced version.
//
//   SERVER=http://localhost:4400 ADMIN_EMAIL=<CLI email> COMBO=<label> node scripts/verify-local-revisions.mjs
//
// Invariants checked in every combination:
//   I1  clients are served at most one version per month
//   I2  a draft revision is never served before it is published
//   I3  the published original's figures never change (unless it is replaced)
//   I4  no write lands in a published or superseded version
// It also exercises the OLD admin import path (month match by month/year) to
// show what a not-yet-updated browser would do.
import { createClient } from '@base44/sdk';
import { planBvaImport } from '../src/lib/bvaImport.js';
import { validateBva } from '../src/lib/bvaValidation.js';
import { cleanParsed, SAMPLE_CUTOFF } from '../src/lib/__fixtures__/bvaSample.js';
import { PUBLISH_CHECKLIST } from '../base44/shared/publishGate.ts';

const SERVER = process.env.SERVER || '';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(SERVER)) { console.error('SERVER must be a localhost URL.'); process.exit(2); }
const COMBO = process.env.COMBO || 'this branch';
console.error = () => {};
const log = console.log;
const results = [];
const note = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const status = (e) => e?.status || e?.response?.status || 'err';
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: status(e), data: e?.response?.data ?? e?.data }; } };
const mk = (token) => createClient({ appId: process.env.SONIA_APP_ID || '6ac5040ff86172a58191d35a', serverUrl: SERVER, requiresAuth: false, ...(token ? { token } : {}) });
const login = await mk().auth.loginViaEmailPassword(process.env.ADMIN_EMAIL, 'local-dev-any-password');
const admin = mk(login?.access_token || login?.token);
const anon = mk();
const E = admin.entities;
const fn = async (name, body) => {
  const r = await attempt(() => admin.functions.invoke(name, body));
  return r.ok ? { status: 200, body: r.value?.data ?? r.value } : { status: r.status, body: r.data || {} };
};
const transition = (action, period_id, extra = {}) => fn('periodTransition', { action, period_id, ...extra });
const served = async () => {
  const r = await attempt(() => anon.functions.invoke('publicDashboard', {}));
  return r.ok ? (r.value?.data ?? r.value) : null;
};

log(`== ${COMBO}`);
// ---- a fictional, final and published month ------------------------------
const year = Number(SAMPLE_CUTOFF.slice(0, 4)); // the sample workbook's year (the local database starts empty on every run)
const parsed = cleanParsed();
const validation = validateBva(parsed, { cutoffDate: SAMPLE_CUTOFF });
const groupMap = Object.fromEntries((parsed.detail?.categories || []).filter((d) => d.code).map((d) => [String(d.code).trim().toLowerCase(), 'fixed']));
const plan = planBvaImport({ parsed, validation, confirm: { month: 7, year, cutoffDate: SAMPLE_CUTOFF }, groupMap });
const c = await transition('create', null, { data: { ...plan.periodWrite, label: `ZZ TEST July ${year}`, month: 7, year } });
const orig = c.body?.period_id;
if (!orig) { log(`setup failed: create HTTP ${c.status}`); process.exit(1); }
for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
  if (plan[key].toCreate.length) await E[entity].bulkCreate(plan[key].toCreate.map((d) => ({ ...d, period_id: orig })));
}
for (let i = 0; i < 12; i++) await E.Transaction.create({ period_id: orig, date: `${year}-07-0${(i % 9) + 1}`, amount: i + 1, category: plan.budgetLines.toCreate[0].category, vendor: `Test vendor ${i}` });
const chk = await transition('check', orig);
const overrides = Object.fromEntries((chk.body?.finalize?.blockers || []).filter((b) => b.overridable !== false).map((b) => [b.code, { reason: 'Fictional test month.' }]));
const fin = await transition('finalize', orig, { overrides });
// Phase 6c: the checklist is confirmed through the server (who/when recorded).
for (const [k] of PUBLISH_CHECKLIST) await transition('confirm_checklist', orig, { item: k });
const pub = await transition('publish', orig);
if (fin.status !== 200 || pub.status !== 200) { log(`setup failed: finalize ${fin.status} publish ${pub.status} ${JSON.stringify(fin.body?.blockers || pub.body?.blockers || '')}`); process.exit(1); }
const origCash = (await E.CashAccount.filter({ period_id: orig })).map((x) => x.balance).sort().join(',');
const monthServed = async () => ((await served())?.periods || []).filter((p) => p.year === year && p.month === 7);

// ---- the revision flow ------------------------------------------------------
const cr = await transition('create_revision', orig, { reason: 'Fictional correction for the test.' });
let rid = cr.body?.period_id;
note('create_revision', null, `HTTP ${cr.status}${cr.body?.error ? ` — ${cr.body.error}` : ''}${cr.body?.blockers ? ` ${cr.body.blockers[0].code}` : ''}`);
if (rid) {
  for (let i = 0; i < 10 && !(await E.ReportingPeriod.get(rid)).copy_status?.startsWith('verified'); i++) await transition('copy_revision', rid);
  const rev = await E.ReportingPeriod.get(rid);
  note('the revision record kept its version fields', !!rev.supersedes && rev.copy_status === 'verified', `supersedes=${rev.supersedes ? 'yes' : 'NO'} copy_status=${rev.copy_status ?? 'absent'}`);
  const copies = await E.Transaction.filter({ period_id: rid });
  note('copied rows kept copied_from', copies.length > 0 && copies.every((x) => x.copied_from), `${copies.filter((x) => x.copied_from).length}/${copies.length}`);
}
let ms = await monthServed();
note('I1/I2 while the revision is open: clients see one version, the original', ms.length === 1 && ms[0].id === orig, `${ms.length} served`);

// A revision correction, as the Monthly Data editors do.
if (rid) {
  const cash = (await E.CashAccount.filter({ period_id: rid }))[0];
  if (cash) await attempt(() => E.CashAccount.update(cash.id, { balance: 4321 }));
}

// The OLD import path: first period matching month/year, refuse only if published.
const all = await E.ReportingPeriod.list('-year', 500);
const oldMatch = all.find((p) => p.month === 7 && p.year === year);
const oldTarget = oldMatch?.id === orig ? 'the published original' : oldMatch?.id === rid ? 'the revision' : 'another version';
let oldWrite = { ok: false, status: 'skipped (old preflight refuses published)' };
if (oldMatch && !oldMatch.published) oldWrite = await attempt(() => E.ReportingPeriod.update(oldMatch.id, { total_cash: 1 }));
note(`old import path targets ${oldTarget}`, null, oldWrite.ok ? 'write accepted' : `write ${oldWrite.status}`);
const directOrig = await attempt(() => E.ReportingPeriod.update(orig, { total_cash: 2 }));
note('I4 a direct write to the published original is refused', !directOrig.ok, directOrig.ok ? 'ACCEPTED' : `HTTP ${directOrig.status}`);

// Finalize and publish the revision.
if (rid) {
  const f2 = await transition('finalize', rid, { overrides });
  // Phase 6c: the checklist is confirmed through the server (who/when recorded).
  for (const [k] of PUBLISH_CHECKLIST) await transition('confirm_checklist', rid, { item: k });
  const p2 = await transition('publish', rid);
  note('finalize + publish the revision', null, `finalize ${f2.status} publish ${p2.status}${p2.body?.blockers ? ` ${p2.body.blockers.map((b) => b.code).join(',')}` : ''}${p2.body?.supersede_pending ? ' supersede pending' : ''}`);
}
ms = await monthServed();
const origAfter = await E.ReportingPeriod.get(orig);
note('I1 after publishing: clients see at most one version of the month', ms.length <= 1, `${ms.length} served: ${ms.map((p) => (p.id === orig ? 'original' : p.id === rid ? 'revision' : 'other')).join(', ')}`);
note('the original is kept', !!origAfter, origAfter ? `superseded=${!!origAfter.superseded} published=${!!origAfter.published}` : 'MISSING');
const origCashAfter = (await E.CashAccount.filter({ period_id: orig })).map((x) => x.balance).sort().join(',');
note('I3 the original\'s figures are unchanged', origCashAfter === origCash);
if (origAfter?.superseded) {
  const w = await attempt(() => E.ReportingPeriod.update(orig, { total_cash: 3 }));
  note('I4 a direct write to the superseded original is refused', !w.ok, w.ok ? 'ACCEPTED' : `HTTP ${w.status}`);
}

// ---- scenario 2: a final but UNPUBLISHED month with an open revision ----------
// An older browser's import path (month match + "not published" preflight +
// invalidate + direct write) must not get into the original behind the revision.
// August: the sample's cutoff (end of July) is valid for it ("the month before").
const plan8 = planBvaImport({ parsed, validation, confirm: { month: 8, year, cutoffDate: SAMPLE_CUTOFF }, groupMap });
const june = await transition('create', null, { data: { ...plan8.periodWrite, label: `ZZ TEST August ${year}`, month: 8, year } });
const jo = june.body?.period_id;
if (jo) {
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount']]) {
    if (plan8[key].toCreate.length) await E[entity].bulkCreate(plan8[key].toCreate.map((d) => ({ ...d, period_id: jo })));
  }
  const jc = await transition('check', jo);
  const jov = Object.fromEntries((jc.body?.finalize?.blockers || []).filter((b) => b.overridable !== false).map((b) => [b.code, { reason: 'Fictional test month.' }]));
  const jf = await transition('finalize', jo, { overrides: jov });
  const jr = await transition('create_revision', jo, { reason: 'Fictional correction for the test.' });
  note('scenario 2: final unpublished month, create_revision', null, `finalize ${jf.status}${jf.body?.blockers ? ` ${jf.body.blockers.map((b) => b.code).join(',')}` : ''}, create_revision ${jr.status}${jr.body?.blockers ? ` ${jr.body.blockers[0].code}` : ''}`);
  const allNow = await E.ReportingPeriod.list('-year', 500);
  const versions = allNow.filter((p) => p.month === 8 && p.year === year);
  const strays = versions.filter((p) => p.id !== jo && !p.supersedes);
  note('scenario 2: no untracked second copy of the month exists', strays.length === 0, `${versions.length} version(s), ${strays.length} untracked`);
  const oldMatch2 = versions.find((p) => !p.published) || null;
  if (oldMatch2?.id === jo) {
    const inv = await transition('invalidate', jo);
    const hasRevision = versions.some((p) => p.supersedes === jo && p.revision_status !== 'discarded');
    let w = { ok: false };
    if (inv.status === 200) w = await attempt(() => E.ReportingPeriod.update(jo, { total_cash: 5 }));
    note(`scenario 2: an older browser importing into the original${hasRevision ? ' (open revision exists)' : ''}`, hasRevision ? inv.status !== 200 && !w.ok : true, `invalidate ${inv.status}${inv.body?.blockers ? ` ${inv.body.blockers[0].code}` : ''}; write ${w.ok ? 'ACCEPTED' : 'not made'}`);
  } else note('scenario 2: an older browser\'s month match picks', null, oldMatch2 ? 'the revision' : 'nothing editable');
  const after = await E.ReportingPeriod.get(jo);
  if (versions.some((p) => p.supersedes === jo)) note('scenario 2: the original (behind its open revision) is still final', after.status === 'final');
  else note('scenario 2: no revision exists, so re-importing the unpublished month in place is the normal behaviour', null, `status ${after.status}`);
}

const failed = results.filter((r) => r.ok === false).length;
log(`${results.filter((r) => r.ok === true).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
