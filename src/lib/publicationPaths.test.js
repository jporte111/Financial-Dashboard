// Structural guard for the publication workflow: the admin UI never writes the
// protected state fields directly, "final" is not a manually selectable stage,
// the importer checks published months before any write, and final/published
// periods render their editors read-only. The server-side enforcement is
// tested in periodTransition.test.js and entityAccess.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : []
  );
const PROTECTED = ['status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'bva_overrides'];

describe('publication paths', () => {
  it('no frontend code writes a protected state field through the entity API', () => {
    const offenders = [];
    for (const f of walk('src')) {
      const text = read(f);
      const writes = [...text.matchAll(/entities(?:\.ReportingPeriod|\[[^\]]+\])\.(?:create|update|bulkCreate)\(([\s\S]{0,600}?)\)\s*;/g)];
      for (const [, args] of writes) {
        for (const k of PROTECTED) if (new RegExp(`\\b${k}\\s*:`).test(args)) offenders.push(`${f}: ${k}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the import plan and manual period creation carry no state fields', () => {
    const importer = read('src/lib/bvaImport.js');
    for (const k of PROTECTED) expect(importer).not.toMatch(new RegExp(`periodData\\.${k}\\s*=`));
    expect(read('src/components/admin/PeriodsManager.jsx')).not.toMatch(/status:\s*'draft'/);
  });

  it('"final" is not a manually selectable review stage', () => {
    const panel = read('src/components/admin/PublishPanel.jsx');
    const stages = panel.slice(panel.indexOf('export const STAGES = ['), panel.indexOf('];', panel.indexOf('export const STAGES = [')));
    const keys = [...stages.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]);
    expect(keys).toEqual(['draft', 'transactions_posted', 'categories_reviewed', 'classes_reviewed', 'reports_reviewed']);
    expect(keys).not.toContain('final');
  });

  it('publish, finalize, reopen and stage changes go through periodTransition', () => {
    const panel = read('src/components/admin/PublishPanel.jsx');
    const center = read('src/components/admin/BvaImportCenter.jsx');
    for (const a of ['publish', 'reopen', 'set_stage']) expect(panel).toMatch(new RegExp(`periodTransition\\('${a}'`));
    expect(center).toMatch(/periodTransition\('finalize'/);
    expect(center).toMatch(/periodTransition\('invalidate'/);
    expect(center).not.toMatch(/planFinalize/);
  });

  it('the importer checks for a published month before any write', () => {
    const center = read('src/components/admin/BvaImportCenter.jsx');
    const pre = center.indexOf('importTarget(existingPeriods');
    const firstWrite = center.search(/entities(?:\.[A-Za-z]+|\[[^\]]+\])\.(?:create|update|delete|bulkCreate)\(/);
    expect(pre).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(0);
    expect(pre).toBeLessThan(firstWrite);
  });

  it('final and published periods render the admin editors disabled', () => {
    const admin = read('src/pages/Admin.jsx');
    expect(admin).toMatch(/const locked = !!period\?\.published \|\| period\?\.status === 'final'/);
    for (const id of ['period-editors', 'transaction-editors', 'review-editors']) {
      expect(admin).toMatch(new RegExp(`<fieldset disabled=\\{locked\\}[^>]*data-testid="${id}"`));
    }
  });
});