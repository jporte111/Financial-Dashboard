import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Static checks on the Base44 entity schemas (base44/entities/*.jsonc).
//
// Every array field must declare its item type. Hosted Base44 treats an
// undeclared item type as string, so writing objects into such a field is
// refused ("Input should be a valid string") -- while the local `base44 dev`
// emulator accepts anything, so only a static check catches it. This is what
// refused the exceptional reopen of a published period in production, which
// appends { at, by, reason, was_published } objects to ReportingPeriod.reopen_log.
const DIR = path.resolve(__dirname, '../../base44/entities');
const load = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonc'));

// Every array definition anywhere in a schema, with its path.
function arrays(def, at) {
  if (!def || typeof def !== 'object') return [];
  const out = def.type === 'array' ? [{ at, def }] : [];
  for (const [k, v] of Object.entries(def.properties || {})) out.push(...arrays(v, `${at}.${k}`));
  if (def.items) out.push(...arrays(def.items, `${at}[]`));
  return out;
}

describe('Base44 entity schemas: array item types', () => {
  it('finds the entity schemas', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every array field declares an explicit items type', () => {
    const undeclared = files.flatMap((f) => {
      const schema = load(f);
      return arrays({ properties: schema.properties }, schema.name || f)
        .filter(({ def }) => !def.items || typeof def.items.type !== 'string')
        .map(({ at }) => at);
    });
    expect(undeclared).toEqual([]);
  });

  it('ReportingPeriod.reopen_log holds objects and stays write-protected', () => {
    const f = load('ReportingPeriod.jsonc').properties.reopen_log;
    expect(f.type).toBe('array');
    expect(f.items).toEqual({ type: 'object' });
    expect(f.rls).toEqual({ write: false });
  });
});
