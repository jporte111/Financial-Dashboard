// Guards the entity access rules. Financial entities must be admin-only for
// direct access on every operation; the no-login client view reads published
// data only through the backend functions (service role). If Base44 Builder or
// anyone else loosens a rule, this fails.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../base44/entities');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const ADMIN = { user_condition: { role: 'admin' } };

const FINANCIAL = [
  'Account',
  'BudgetLine',
  'DetailAccountMap',
  'CashAccount',
  'Distribution',
  'RecurringTransfer',
  'ReportingPeriod',
  'SavedReport',
  'SavingsSpend',
  'Transaction',
];

// A published or superseded ReportingPeriod is read-only for direct writes
// (even admins); its state and version fields are writable only by the
// periodTransition function.
const UNPUBLISHED_ADMIN = { $and: [ADMIN, { 'data.published': { $ne: true } }, { 'data.superseded': { $ne: true } }] };
const PROTECTED_STATE = [
  'status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log', 'checklist_confirmations',
  'revision_of', 'revision_number', 'supersedes', 'superseded', 'superseded_by', 'superseded_at',
  'revision_reason', 'revision_created_by', 'revision_created_at', 'revision_status', 'copy_status', 'copy_verification',
  'detail_import',
];
// Phase 5b transaction detail: admins may read it; only the backend (service
// role) writes it -- no user role matches 'server_only'.
const SERVER_ONLY = { user_condition: { role: 'server_only' } };
const SERVER_WRITTEN = ['TransactionDetailChunk'];
// Line records copied into a revision name their source; only the server sets it.
const SERVER_ONLY_LINE_FIELDS = ['copied_from'];

describe('entity access rules', () => {
  it.each(FINANCIAL.filter((n) => n !== 'ReportingPeriod'))('%s is admin-only for create, read, update and delete', (name) => {
    expect(load(name).rls).toEqual({ create: ADMIN, read: ADMIN, update: ADMIN, delete: ADMIN });
  });

  it('ReportingPeriod: admin-only, and update/delete only while neither published nor superseded', () => {
    expect(load('ReportingPeriod').rls).toEqual({ create: ADMIN, read: ADMIN, update: UNPUBLISHED_ADMIN, delete: UNPUBLISHED_ADMIN });
  });

  it.each(PROTECTED_STATE)('ReportingPeriod.%s is never directly writable', (field) => {
    expect(load('ReportingPeriod').properties[field].rls).toEqual({ write: false });
  });

  it.each(SERVER_WRITTEN)('%s: admins read; nobody writes directly (server only)', (name) => {
    expect(load(name).rls).toEqual({ create: SERVER_ONLY, read: ADMIN, update: SERVER_ONLY, delete: SERVER_ONLY });
  });

  it.each(['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend', 'Transaction', 'TransactionDetailChunk'])('%s.copied_from is never directly writable', (name) => {
    expect(load(name).properties.copied_from.rls).toEqual({ write: false });
  });

  it('every entity other than the built-in User is covered by the list above', () => {
    const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc')).map((f) => f.replace(/\.jsonc$/, ''));
    expect(all.filter((n) => n !== 'User').sort()).toEqual([...FINANCIAL, ...SERVER_WRITTEN].sort());
  });

  it('no field-level rule re-opens a financial field', () => {
    for (const name of [...FINANCIAL, ...SERVER_WRITTEN]) {
      for (const [field, def] of Object.entries(load(name).properties || {})) {
        if (!def || !def.rls) continue;
        const serverOnly = (name === 'ReportingPeriod' && PROTECTED_STATE.includes(field)) || SERVER_ONLY_LINE_FIELDS.includes(field);
        const allowed = serverOnly ? { write: false } : { read: ADMIN, write: ADMIN };
        expect({ name, field, rls: def.rls }).toEqual({ name, field, rls: allowed });
      }
    }
  });
});