// Guards the entity access rules. Financial entities must be admin-only for
// direct access on every operation; the no-login client view reads published
// data only through the backend functions (service role). If Base44 Builder or
// anyone else loosens a rule, this fails.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../base44/entities');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const ADMIN = { user_condition: { role: 'admin' } };

const FINANCIAL = [
  'Account',
  'BudgetLine',
  'CashAccount',
  'Distribution',
  'RecurringTransfer',
  'ReportingPeriod',
  'SavedReport',
  'SavingsSpend',
  'Transaction',
];

// A published ReportingPeriod is read-only for direct writes (even admins);
// its state fields are writable only by the periodTransition function.
const UNPUBLISHED_ADMIN = { $and: [ADMIN, { 'data.published': { $ne: true } }] };
const PROTECTED_STATE = ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides', 'reopen_log'];

describe('entity access rules', () => {
  it.each(FINANCIAL.filter((n) => n !== 'ReportingPeriod'))('%s is admin-only for create, read, update and delete', (name) => {
    expect(load(name).rls).toEqual({ create: ADMIN, read: ADMIN, update: ADMIN, delete: ADMIN });
  });

  it('ReportingPeriod: admin-only, and update/delete only while not published', () => {
    expect(load('ReportingPeriod').rls).toEqual({ create: ADMIN, read: ADMIN, update: UNPUBLISHED_ADMIN, delete: UNPUBLISHED_ADMIN });
  });

  it.each(PROTECTED_STATE)('ReportingPeriod.%s is never directly writable', (field) => {
    expect(load('ReportingPeriod').properties[field].rls).toEqual({ write: false });
  });

  it('every entity other than the built-in User is covered by the list above', () => {
    const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc')).map((f) => f.replace(/\.jsonc$/, ''));
    expect(all.filter((n) => n !== 'User').sort()).toEqual([...FINANCIAL].sort());
  });

  it('no field-level rule re-opens a financial field', () => {
    for (const name of FINANCIAL) {
      for (const [field, def] of Object.entries(load(name).properties || {})) {
        if (!def || !def.rls) continue;
        const allowed = name === 'ReportingPeriod' && PROTECTED_STATE.includes(field) ? { write: false } : { read: ADMIN, write: ADMIN };
        expect({ name, field, rls: def.rls }).toEqual({ name, field, rls: allowed });
      }
    }
  });
});
