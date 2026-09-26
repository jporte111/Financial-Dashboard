#!/usr/bin/env node
// Verifies the null-free import path against a LOCAL Base44 dev server
// (in-memory data) with a fictional two-sheet workbook, using the real parser,
// validation, import planner and write order of the admin import screen:
//
//   npx base44 dev                       # in another terminal, on this branch
//   SERVER=http://localhost:4400 ADMIN_EMAIL=<your CLI email> node scripts/verify-local-missing-values.mjs
//
// What it establishes:
//   - Base44 rejects null in a number field (the constraint being designed for);
//   - an import never sends null: a blank figure is left out, a real 0 is kept;
//   - a re-import that turns a stored value into a missing one succeeds: the
//     period lists the field in source_missing_fields, a child row is replaced;
//   - the server-side publish gate treats a listed field as missing.
//
// Refuses any server that is not localhost. Prints PASS/FAIL, HTTP statuses
// and field names only.
import { createClient } from '@base44/sdk';
import * as XLSX from 'xlsx';
import { parseBvaWorkbook } from '../src/lib/bvaParser.js';
import { validateBva } from '../src/lib/bvaValidation.js';
import { planBvaImport, groupMapFromLines } from '../src/lib/bvaImport.js';
import { totalsWrite } from '../src/lib/periodTotals.js';

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
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: status(e), data: e?.response?.data ?? e?.data }; } };
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const login = await mk().auth.loginViaEmailPassword(process.env.ADMIN_EMAIL, 'local-dev-any-password');
const admin = mk(login?.access_token || login?.token);
check('admin session', (await admin.auth.me())?.role === 'admin');
const E = admin.entities;
const transition = async (action, periodId, extra = {}) => {
  const r = await attempt(() => admin.functions.invoke('periodTransition', { action, period_id: periodId, ...extra }));
  return r.ok ? { status: 200, body: r.value?.data ?? r.value } : { status: r.status, body: r.data };
};

// ---- A fictional two-sheet workbook (summary + "Detail & Notes") ---------
const year = 2100 + Math.floor(Math.random() * 800);
function workbook({ blankMonth }) {
  const m = (x) => (blankMonth ? '' : x);
  const s1 = [
    [`BVA September ${year}`],
    [`Sample | Reporting Cutoff Date: 08/31/${year} | Data through August 31, ${year} (08/31/${year}) | USD`],
    [''],
    ['CASH — Current Bank Balances', '', '', `Distributions ${year}`],
    ['Account', `08/31/${year}`, '', 'Entity', 'Q1', 'Q2', 'Q3', 'Q4', 'YTD Total'],
    ['First Checking', 100, '', 'Alpha', 10, 0, 5, '', 15],
    ['Total Cash', 100, '', 'Total', 10, 0, 5, 0, 15],
    [''],
    ['INCOME'],
    ['Category', 'Current Month', 'Actual YTD', 'Annual Budget'],
    ['Monthly Income', m(800), 6400, 9600],
    ['Total Income', m(800), 6400, 9600],
    [''],
    ['EXPENSES'],
    ['Category', 'Current Month', 'Actual YTD', 'Annual Budget'],
    ['FIXED', m(10), 720, 1200],
    ['VARIABLE', m(5), 540, 1200],
    ['DISCRETIONARY', m(8), 890, 1200],
    ['Total Expenses', m(23), 2150, 3600],
  ];
  const s2 = [
    ['DETAIL — WATCH LIST CATEGORIES'],
    ['Code', 'Category', 'Current Month', 'Actual YTD', 'Annual Budget'],
    ['6100', 'Landscaping', m(3), 35, 60],
    ['6300', 'Clothing', m(0), 70, 60],
    [''],
    ['MONTHLY TRANSFERS / RECURRING DEBITS'],
    ['Item', 'QBO Account', 'Current Month Amount'],
    ['Tax Savings', '8030', 500],
    ['Auto Lease', '6400', 750],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Detail & Notes');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

// The admin import screen's write sequence (BvaImportCenter.apply).
async function importWorkbook(bytes) {
  const parsed = parseBvaWorkbook(bytes);
  const confirm = { month: 9, year, cutoffDate: parsed.meta.cutoffDate, filename: 'fictional.xlsx', importedBy: 'verify' };
  const validation = validateBva(parsed, { cutoffDate: confirm.cutoffDate, period: { month: 9, year } });
  const existingPeriods = await E.ReportingPeriod.filter({ year }, undefined, 10);
  const match = existingPeriods.find((p) => p.month === 9) || null;
  let existing = { budgetLines: [], cashAccounts: [], distributions: [], transfers: [] };
  if (match) {
    const inv = await transition('invalidate', match.id);
    if (inv.status !== 200) return { error: `invalidate HTTP ${inv.status}` };
    existing = {
      budgetLines: await E.BudgetLine.filter({ period_id: match.id }, undefined, 500),
      cashAccounts: await E.CashAccount.filter({ period_id: match.id }, undefined, 500),
      distributions: await E.Distribution.filter({ period_id: match.id }, undefined, 500),
      transfers: await E.RecurringTransfer.filter({ period_id: match.id }, undefined, 500),
    };
  }
  const plan = planBvaImport({ parsed, validation, confirm, existingPeriods, existing, groupMap: groupMapFromLines(existing.budgetLines) });
  const nulls = [plan.periodWrite, ...['budgetLines', 'cashAccounts', 'distributions', 'transfers'].flatMap((k) => [...plan[k].toCreate, ...plan[k].toUpdate.map((u) => u.data)])]
    .flatMap((rec) => Object.keys(rec).filter((f) => rec[f] === null));
  let periodId = plan.periodId;
  if (plan.action === 'create') {
    const c = await transition('create', null, { data: plan.periodWrite });
    if (c.status !== 200) return { error: `create HTTP ${c.status}`, nulls };
    periodId = c.body.period_id;
  } else {
    const u = await attempt(() => E.ReportingPeriod.update(periodId, plan.periodWrite));
    if (!u.ok) return { error: `period update HTTP ${u.status}`, nulls };
  }
  const failures = [];
  for (const [key, entity] of [['budgetLines', 'BudgetLine'], ['cashAccounts', 'CashAccount'], ['distributions', 'Distribution'], ['transfers', 'RecurringTransfer']]) {
    const b = plan[key];
    if (b.toCreate.length) {
      const r = await attempt(() => E[entity].bulkCreate(b.toCreate.map((d) => ({ ...d, period_id: periodId }))));
      if (!r.ok) failures.push(`${entity} create HTTP ${r.status}`);
    }
    for (const u of b.toUpdate) {
      const r = await attempt(() => E[entity].update(u.id, u.data));
      if (!r.ok) failures.push(`${entity} update HTTP ${r.status}`);
    }
    for (const id of b.toDelete) {
      const r = await attempt(() => E[entity].delete(id));
      if (!r.ok) failures.push(`${entity} delete HTTP ${r.status}`);
    }
  }
  return { periodId, plan, parsed, nulls, failures };
}

log(`\n== the constraint (fictional September ${year})`);
const probe = await transition('create', null, { data: { label: `Probe ${year}`, month: 1, year } });
const probeId = probe.body?.period_id;
const nullWrite = await attempt(() => E.ReportingPeriod.update(probeId, { month_income: null }));
check('Base44 rejects null in a number field', !nullWrite.ok && nullWrite.status === 422, nullWrite.ok ? 'accepted' : `HTTP ${nullWrite.status}`);
if (probeId) await attempt(() => E.ReportingPeriod.delete(probeId));

log('\n== first import: two-sheet workbook with figures in every column');
const first = await importWorkbook(workbook({ blankMonth: false }));
check('import succeeded with no rejected write', !first.error && first.failures.length === 0, first.error || first.failures.join('; '));
check('no write payload contained null', first.nulls.length === 0, first.nulls.join(', '));
const pid = first.periodId;
let lines = await E.BudgetLine.filter({ period_id: pid }, undefined, 100);
check('watch-list rows from the second sheet were stored', lines.filter((l) => l.bva_detail).length === 2);
check('transfers from the second sheet were stored', (await E.RecurringTransfer.filter({ period_id: pid })).length === 2);
check('a real 0 is stored as 0', lines.find((l) => l.qb_code === '6300')?.month_actual === 0);
const dist = (await E.Distribution.filter({ period_id: pid }))[0];
check('a blank distribution quarter is left missing (not 0); a real 0 stays 0', dist && dist.q4 == null && dist.q2 === 0, `q2=${dist?.q2} q4=${dist?.q4}`);
let period = await E.ReportingPeriod.get(pid);
check('the period stored the missing-field list (empty)', Array.isArray(period.source_missing_fields) && period.source_missing_fields.length === 0,
  Array.isArray(period.source_missing_fields) ? '' : 'field not stored: restart the dev server so it loads the updated ReportingPeriod schema');

log('\n== re-import into the same draft: the current-month column is now blank');
const oldIds = new Set(lines.map((l) => l.id));
const second = await importWorkbook(workbook({ blankMonth: true }));
check('re-import succeeded with no rejected write', !second.error && second.failures.length === 0, second.error || second.failures.join('; '));
check('no write payload contained null', second.nulls.length === 0, second.nulls.join(', '));
period = await E.ReportingPeriod.get(pid);
check('the period lists the month totals as missing', ['month_expenses', 'month_income'].every((f) => (period.source_missing_fields || []).includes(f)), `listed: ${(period.source_missing_fields || []).join(',') || 'none'}`);
lines = await E.BudgetLine.filter({ period_id: pid }, undefined, 100);
check('every budget line now reads its month figure as missing', lines.every((l) => l.month_actual == null), `${lines.filter((l) => l.month_actual != null).length} still hold a value`);
check('lines whose value became missing were replaced (new ids), none duplicated', lines.length === 6 && lines.every((l) => !oldIds.has(l.id)), `${lines.length} lines`);

log('\n== the server-side publish gate honours the list');
const chk = await transition('check', pid);
const blockerCodes = [...(chk.body?.finalize?.blockers || []), ...(chk.body?.publish?.blockers || [])].map((b) => b.code);
await attempt(() => E.ReportingPeriod.update(pid, { source_missing_fields: [...(period.source_missing_fields || []), 'total_cash'] }));
const chk2 = await transition('check', pid);
const codes2 = (chk2.body?.finalize?.blockers || []).map((b) => b.code);
check('a listed required total blocks finalization although a number is stored', codes2.includes('required_value_missing:total_cash') && !blockerCodes.includes('required_value_missing:total_cash'));

log('\n== Admin monthly totals: blank input');
period = await E.ReportingPeriod.get(pid);
const tw = totalsWrite(period, { total_cash: '100', savings_in_ytd: '' });
const tu = await attempt(() => E.ReportingPeriod.update(pid, tw.data));
period = await E.ReportingPeriod.get(pid);
check('saving a blank total succeeds (no 422) and lists it as missing', tu.ok && period.source_missing_fields.includes('savings_in_ytd') && !period.source_missing_fields.includes('total_cash'), tu.ok ? '' : `HTTP ${tu.status}`);

log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
