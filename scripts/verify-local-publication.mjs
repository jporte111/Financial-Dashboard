#!/usr/bin/env node
// Verifies the publication safeguards against a LOCAL Base44 dev server
// (in-memory data), using fresh fictional records. It exercises the real
// permission behaviour, not mocks:
//
//   npx base44 dev                       # in another terminal, on this branch
//   SERVER=http://localhost:4400 ADMIN_EMAIL=<your CLI email> node scripts/verify-local-publication.mjs
//
// Observed Base44 behaviour this script encodes (see the Phase 1 notes):
//   - A direct write to a field-protected state field (rls write: false) may
//     return success while leaving the field unchanged; the fields are
//     protected, but not by an error.
//   - In a mixed update, permitted fields persist and protected fields are
//     dropped.
//   - null is rejected for string and number fields (HTTP 422).
//   - The periodTransition function (service role) can write the protected
//     fields; the ReportingPeriod update/delete rule refuses direct changes to
//     a published period.
//
// Refuses any server that is not localhost. Prints PASS/FAIL, HTTP statuses
// and field names only -- never tokens or codes.
import { createClient } from '@base44/sdk';

const SERVER = process.env.SERVER || '';
const APP = process.env.SONIA_APP_ID || '6a80ccf1dac2259ae9870f29';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(SERVER)) {
  console.error('SERVER must be http://localhost:<port> (local dev server only).');
  process.exit(2);
}
if (!process.env.ADMIN_EMAIL) {
  console.error('ADMIN_EMAIL (your Base44 CLI email; the local dev server accepts any password for it) is required.');
  process.exit(2);
}
const log = console.log;
console.error = () => {}; // the SDK logs every failed request in development

const mk = (token) => createClient({ appId: APP, serverUrl: SERVER, requiresAuth: false, ...(token ? { token } : {}) });
const status = (e) => e?.status || e?.response?.status || 'err';
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: status(e), data: e?.data }; } };
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const login = await mk().auth.loginViaEmailPassword(process.env.ADMIN_EMAIL, 'local-dev-any-password');
const admin = mk(login?.access_token || login?.token);
const anon = mk();
check('admin session', (await admin.auth.me())?.role === 'admin');

const RP = admin.entities.ReportingPeriod;
const BL = admin.entities.BudgetLine;
const PROTECTED = ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log'];
const CHECKLIST = ['categories_reviewed', 'classes_reviewed', 'refunds_reviewed', 'income_reviewed', 'cash_confirmed', 'distributions_confirmed', 'budget_report_reviewed'];
const transition = async (action, periodId, extra = {}) => {
  const r = await attempt(() => admin.functions.invoke('periodTransition', { action, period_id: periodId, ...extra }));
  return r.ok ? { status: 200, body: r.value?.data ?? r.value } : { status: r.status, body: r.data };
};
const snapshot = async (id) => { const { updated_date, ...rest } = await RP.get(id); return JSON.stringify(rest); };
const served = async (id) => {
  const r = await attempt(() => anon.functions.invoke('publicDashboard', {}));
  return r.ok && ((r.value?.data ?? r.value)?.periods || []).some((p) => p.id === id);
};
const blockerCodes = (r) => (r.body?.blockers || []).map((b) => b.code);

// Fresh, fictional month for every run.
const year = 2100 + Math.floor(Math.random() * 800);
const label = `July ${year}`;
const data = {
  label, month: 7, year, start_date: `${year}-07-01`, end_date: `${year}-07-31`, reporting_cutoff_date: `${year}-07-31`,
  months_elapsed: 7, total_cash: 100, ytd_income: 70, ytd_expenses: 50, annual_budgeted_income: 120,
  annual_budgeted_expenses: 100, distributions_ytd: 0, bva_parsed_source: { fictional: true }, bva_validation_warnings: [],
  published: true, status: 'final', // must be ignored by the server
};

log(`\n== create (fictional ${label})`);
let r = await transition('create', null, { data });
check('server-side create succeeds', r.status === 200 && r.body?.ok && !!r.body?.period_id, `HTTP ${r.status}`);
const pid = r.body?.period_id;
if (!pid) { log(`\n${passed} passed, ${failed} failed (cannot continue without a period)`); process.exit(1); }
let p = await RP.get(pid);
check('created as draft + unpublished with verified state (caller state ignored)', p.status === 'draft' && p.published === false && p.bva_import_status === 'draft' && p.finalized_at === '',
  `status=${p.status} published=${p.published} bva=${p.bva_import_status}`);
r = await transition('create', null, { data });
check('retrying the same month is refused as a duplicate', r.status === 409 && blockerCodes(r).includes('period_exists'));
check('  ...and no duplicate exists', (await RP.filter({ month: 7, year })).length === 1);

log('\n== direct writes to protected fields (ordinary admin)');
for (const [field, value] of [['published', true], ['status', 'final'], ['bva_import_status', 'final'], ['finalized_at', `${year}-08-01T00:00:00Z`], ['finalized_by', 'someone'], ['bva_overrides', { x: { reason: 'y' } }], ['reopen_log', [{ reason: 'forged' }]]]) {
  const before = await snapshot(pid);
  const w = await attempt(() => RP.update(pid, { [field]: value }));
  check(`${field}: unchanged after a direct write`, before === (await snapshot(pid)), w.ok ? 'request returned success (Base44 drops protected fields)' : `refused HTTP ${w.status}`);
}
const beforeMixed = await RP.get(pid);
const mixed = await attempt(() => RP.update(pid, { total_cash: 101, published: true, status: 'final' }));
const afterMixed = await RP.get(pid);
check('mixed update: permitted field persists', mixed.ok && afterMixed.total_cash === 101, mixed.ok ? '' : `HTTP ${mixed.status}`);
check('mixed update: protected fields unchanged', PROTECTED.every((k) => JSON.stringify(afterMixed[k]) === JSON.stringify(beforeMixed[k])));
await RP.update(pid, { total_cash: 100 });

log('\n== refused transitions leave the record unchanged');
let before = await snapshot(pid);
r = await transition('publish', pid);
check('publish of an incomplete draft is refused', r.status === 409 && blockerCodes(r).includes('not_final'));
check('  ...unchanged', before === (await snapshot(pid)));
r = await transition('finalize', pid);
check('finalize without budget lines is refused (import incomplete)', r.status === 409 && blockerCodes(r).includes('import_incomplete'));
check('  ...unchanged', before === (await snapshot(pid)));

for (const [category, group, ytd, annual] of [['Fixed', 'fixed', 20, 40], ['Variable', 'variable', 20, 40], ['Discretionary', 'discretionary', 10, 20], ['Salary', 'income', 70, 120]]) {
  await BL.create({ period_id: pid, category, budget_group: group, bva_detail: false, group_confirmed: true, ytd_actual: ytd, annual_budget: annual });
}
const detail = await BL.create({ period_id: pid, category: 'Monitored', qb_code: '6100', budget_group: 'unassigned', bva_detail: true, group_confirmed: false, ytd_actual: 5, annual_budget: 10 });
before = await snapshot(pid);
r = await transition('finalize', pid);
check('finalize blocks a material unassigned DETAIL row', r.status === 409 && blockerCodes(r).includes(`detail_unassigned:${detail.id}`));
check('  ...unchanged', before === (await snapshot(pid)));

log('\n== finalize and publish through the authorized function');
r = await transition('finalize', pid, { overrides: { [`detail_unassigned:${detail.id}`]: { reason: 'excluded: not part of the personal budget' } } });
check('finalize with a documented exclusion succeeds', r.status === 200, `HTTP ${r.status}`);
p = await RP.get(pid);
check('final, not published, exclusion recorded', p.status === 'final' && p.bva_import_status === 'final' && !!p.finalized_at && p.published === false && !!p.bva_overrides?.[`detail_unassigned:${detail.id}`]?.reason);
check('public dashboard does not serve a final-but-unpublished period', !(await served(pid)));
before = await snapshot(pid);
r = await transition('publish', pid);
check('publish with an incomplete checklist is refused', r.status === 409 && blockerCodes(r).some((c) => c.startsWith('checklist_incomplete:')));
check('  ...unchanged', before === (await snapshot(pid)));
const ck = await attempt(() => RP.update(pid, { checklist: Object.fromEntries(CHECKLIST.map((k) => [k, true])) }));
check('checklist editable while unpublished', ck.ok);
r = await transition('publish', pid);
check('publish succeeds', r.status === 200, `HTTP ${r.status}`);
p = await RP.get(pid);
check('period is published', p.published === true && p.status === 'final');
check('public dashboard serves it', await served(pid));

log('\n== a published period is protected');
for (const [name, patch] of [['total_cash', { total_cash: 999 }], ['ytd_expenses', { ytd_expenses: 1 }], ['months_elapsed', { months_elapsed: 12 }], ['checklist', { checklist: {} }], ['published (unpublish attempt)', { published: false }]]) {
  before = await snapshot(pid);
  const w = await attempt(() => RP.update(pid, patch));
  check(`direct change of ${name} is refused`, !w.ok, w.ok ? 'request returned success' : `HTTP ${w.status}`);
  check('  ...unchanged', before === (await snapshot(pid)));
}
before = await snapshot(pid);
const del = await attempt(() => RP.delete(pid));
check('direct deletion is refused', !del.ok, del.ok ? 'request returned success' : `HTTP ${del.status}`);
const stillThere = await attempt(() => RP.get(pid));
check('  ...still exists, unchanged', stillThere.ok && before === (await snapshot(pid)));
r = await transition('invalidate', pid);
check('re-import reset (invalidate) is refused', r.status === 409 && blockerCodes(r).includes('published_read_only'));
r = await transition('set_stage', pid, { stage: 'draft' });
check('stage change is refused', r.status === 409);
r = await transition('set_stage', pid, { stage: 'final' });
check('stage "final" is never accepted', r.status === 400);
check('  ...unchanged after refused transitions', before === (await snapshot(pid)));
const child = await attempt(() => BL.update(detail.id, { ytd_actual: 6 }));
check('KNOWN LIMITATION: line items of a published period are still directly editable', child.ok, child.ok ? 'editable (UI read-only only)' : `HTTP ${child.status}`);

log('\n== exceptional reopen');
before = await snapshot(pid);
r = await transition('reopen', pid, { reason: 'too short', confirm: label });
check('reopen with an insufficient reason is refused', r.status === 409 && blockerCodes(r).includes('reopen_reason_required'));
r = await transition('reopen', pid, { reason: 'fictional exceptional withdrawal test', confirm: label.toLowerCase() });
check('reopen without the exact label is refused', r.status === 409 && blockerCodes(r).includes('reopen_confirmation_required'));
check('  ...unchanged', before === (await snapshot(pid)));
check('  ...still served publicly', await served(pid));
r = await transition('reopen', pid, { reason: 'fictional exceptional withdrawal test', confirm: label });
check('confirmed reopen succeeds', r.status === 200, `HTTP ${r.status}`);
p = await RP.get(pid);
check('reopened to an unpublished draft with cleared finalization', p.published === false && p.status === 'draft' && p.bva_import_status === 'draft' && p.finalized_at === '' && p.finalized_by === '');
const entry = Array.isArray(p.reopen_log) ? p.reopen_log[p.reopen_log.length - 1] : null;
check('audit entry recorded (who, when, reason, was published)', !!entry && entry.reason === 'fictional exceptional withdrawal test' && entry.was_published === true && !!entry.by && !!entry.at);
check('public dashboard no longer serves it', !(await served(pid)));

log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
