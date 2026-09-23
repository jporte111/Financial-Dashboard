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

describe('entity access rules', () => {
  it.each(FINANCIAL)('%s is admin-only for create, read, update and delete', (name) => {
    expect(load(name).rls).toEqual({ create: ADMIN, read: ADMIN, update: ADMIN, delete: ADMIN });
  });

  it('every entity other than the built-in User is covered by the list above', () => {
    const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc')).map((f) => f.replace(/\.jsonc$/, ''));
    expect(all.filter((n) => n !== 'User').sort()).toEqual([...FINANCIAL].sort());
  });

  it('no field-level rule re-opens a financial field', () => {
    for (const name of FINANCIAL) {
      for (const [field, def] of Object.entries(load(name).properties || {})) {
        if (def && def.rls) expect({ name, field, rls: def.rls }).toEqual({ name, field, rls: { read: ADMIN, write: ADMIN } });
      }
    }
  });
});
