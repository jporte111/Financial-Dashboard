import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Structural proof that QuickBooks has been fully disconnected: no source
// file calls the QuickBooks/Intuit API, the QuickBooks-calling backend
// functions and connector no longer exist, no frontend code can invoke them,
// and the BVA-only drill-down function can never return a QuickBooks-sourced
// record. These read the actual repository files rather than mocking
// anything, so they fail if the removal is ever partially reverted.

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'bva-workbooks']);

function listFiles(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const srcFiles = listFiles(path.join(ROOT, 'src'), ['.js', '.jsx', '.ts']);
const base44Files = listFiles(path.join(ROOT, 'base44'), ['.ts', '.jsonc']);
const nonTestSrcFiles = srcFiles.filter((f) => !f.includes('.test.'));
const rel = (f) => path.relative(ROOT, f);

describe('QuickBooks is fully disconnected — structural checks over the real repository', () => {
  it('no source file calls the QuickBooks/Intuit API', () => {
    const offenders = [];
    for (const f of [...srcFiles, ...base44Files]) {
      if (/quickbooks\.api\.intuit\.com/i.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('the QuickBooks-calling backend functions no longer exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'base44/functions/quickbooksSync'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'base44/functions/quickbooksTransactionSync'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'base44/functions/liveRollup'))).toBe(false);
  });

  it('the QuickBooks connector configuration no longer exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'base44/connectors/quickbooks.jsonc'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'base44/connectors'))).toBe(false);
  });

  it('no frontend code invokes a QuickBooks-named Base44 function', () => {
    const offenders = [];
    for (const f of nonTestSrcFiles) {
      if (/invoke\(\s*['"]quickbooks/i.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('the Live (QuickBooks) page, route, and nav entry are removed', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/pages/LiveQuickbooks.jsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/useLiveRollup.js'))).toBe(false);
    const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
    expect(app).not.toMatch(/live-quickbooks/i);
    expect(app).not.toMatch(/LiveQuickbooks/);
    const layout = fs.readFileSync(path.join(ROOT, 'src/components/Layout.jsx'), 'utf8');
    expect(layout).not.toMatch(/Live \(QuickBooks\)/i);
  });

  it('the QuickBooks Import subtab, the legacy importer, and its parsers are removed', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/components/admin/ImportCenter.jsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/lib/importParsers.js'))).toBe(false);
    const hub = fs.readFileSync(path.join(ROOT, 'src/components/admin/ImportHub.jsx'), 'utf8');
    // No "QuickBooks Import" tab label and no import of the removed component
    // (a documentation comment noting QuickBooks was removed is fine).
    expect(hub).not.toMatch(/QuickBooks Import/);
    expect(hub).not.toMatch(/admin\/ImportCenter/);
  });

  it('the admin Reconciliation view and its comparison table are removed', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/components/admin/Reconciliation.jsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/components/SpendingComparisonTable.jsx'))).toBe(false);
    const admin = fs.readFileSync(path.join(ROOT, 'src/pages/Admin.jsx'), 'utf8');
    expect(admin).not.toMatch(/reconciliation/i);
  });

  it('no remaining UI file offers a "Sync from QuickBooks" (or similar) action', () => {
    const offenders = [];
    for (const f of nonTestSrcFiles) {
      if (/sync from quickbooks/i.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('no remaining UI file shows a QuickBooks connect/sync button, status indicator, or error message', () => {
    const offenders = [];
    for (const f of nonTestSrcFiles) {
      const text = fs.readFileSync(f, 'utf8');
      // Comments documenting the removal are fine; a literal user-facing
      // control or message referencing QuickBooks is not.
      if (/(button|Button)[^\n]{0,120}quickbooks/i.test(text) || /quickbooks[^\n]{0,60}(sync|connect|failed|error)/i.test(text)) {
        offenders.push(rel(f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the BVA drill-down function never returns a QuickBooks-sourced transaction and takes no QuickBooks-only params', () => {
    const text = fs.readFileSync(path.join(ROOT, 'base44/functions/categoryTransactions/entry.ts'), 'utf8');
    expect(text).toMatch(/source\s*!==\s*['"]quickbooks['"]/);
    // no source_filter param and no Live-page single-account request param —
    // the request body only ever destructures these three fields now.
    expect(text).not.toMatch(/source_filter/);
    expect(text).toMatch(/const\s*\{\s*period_id,\s*category,\s*qb_account_names\s*\}\s*=\s*body/);
    expect(text).not.toMatch(/quickbooks\.api\.intuit\.com/i);
  });

  it('no shared rollup helper still sums QuickBooks-linked live transactions', () => {
    const text = fs.readFileSync(path.join(ROOT, 'base44/shared/rollupHelpers.ts'), 'utf8');
    expect(text).not.toMatch(/rollUpByAccount/);
  });

  it('the BVA dashboard view-model never accepts a QuickBooks fallback (existing requirement-17 coverage still holds)', () => {
    // The dashboard builder file itself never imports base44/functions or a
    // live-rollup hook — it is driven only by the period + its BVA entities.
    const text = fs.readFileSync(path.join(ROOT, 'src/lib/bvaDashboard.js'), 'utf8');
    expect(text).not.toMatch(/useLiveRollup|liveRollup|quickbooksSync|quickbooksTransactionSync/);
  });

  it('no committed Base44 secret or connector references QuickBooks/Intuit credentials', () => {
    const connectorsDir = path.join(ROOT, 'base44/connectors');
    expect(fs.existsSync(connectorsDir) ? fs.readdirSync(connectorsDir) : []).toEqual([]);
  });
});