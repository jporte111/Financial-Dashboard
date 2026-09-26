import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseBvaWorkbook } from './bvaParser.js';
import { validateBva } from './bvaValidation.js';
import { planBvaImport } from './bvaImport.js';

// Reference check against real monthly workbooks. The workbooks and their
// expected figures are client-confidential and live only in the git-ignored
// bva-workbooks/reference/ directory; nothing client-specific is in this file.
// Without that directory (e.g. CI) the suite is skipped with a notice.
//
// Each bva-workbooks/reference/<name>.json manifest:
//   { "workbooks": ["a.xlsx", ...],          // versions that must agree
//     "expected": { cutoff, cash, cashTotal, dist, distTotal, income, groups,
//                   detail, transferAmounts },  // built without the parser
//     "blankQuartersWereZero"?: true }         // expected came from the old parser
//
// Failures name only the differing paths -- never the values -- so client
// figures are not printed to the console.
const DIR = path.resolve(process.cwd(), 'bva-workbooks', 'reference');
const manifests = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

if (!manifests.length) {
  // eslint-disable-next-line no-console
  console.warn('[bvaReferenceWorkbooks] skipped — no git-ignored reference manifests in bva-workbooks/reference/.');
}

const r2 = (x) => (x == null ? null : Math.round(Number(x) * 100) / 100);
function figures(p, { blankAsZero = false } = {}) {
  const q = (x) => (x == null && blankAsZero ? 0 : r2(x));
  return {
    cutoff: p.meta.cutoffDate,
    cash: p.cash.accounts.map((a) => [a.name, r2(a.balance)]),
    cashTotal: r2(p.cash.reportedTotal),
    dist: p.distributions.entities.map((e) => [e.name, q(e.q1), q(e.q2), q(e.q3), q(e.q4)]),
    distTotal: r2(p.distributions.reportedTotal),
    income: p.income.categories.map((c) => [c.name, r2(c.monthActual), r2(c.actualYtd), r2(c.annualBudget)]),
    groups: p.expenseSummary.groups.map((g) => [g.key, r2(g.monthActual), r2(g.actualYtd), r2(g.annualBudget)]),
    detail: p.detail.categories.map((d) => [d.code, r2(d.monthActual), r2(d.actualYtd), r2(d.annualBudget)]),
    transferAmounts: p.transfers.items.map((t) => r2(t.amount)).sort((a, b) => a - b),
  };
}
// Paths where two structures differ (values are never returned).
function diffPaths(a, b, at = '') {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length !== b.length ? [`${at}.length`] : [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffPaths(a[i], b[i], `${at}[${i}]`));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return a === b ? [] : [at || '(root)'];
}

describe.skipIf(!manifests.length)('real reference workbooks (git-ignored)', () => {
  for (const file of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const E = m.expected;
    describe(file.replace(/\.json$/, ''), () => {
      const parsedAll = m.workbooks.map((w) => [w, parseBvaWorkbook(fs.readFileSync(path.join(DIR, w)))]);

      for (const [w, p] of parsedAll) {
        it(`${w}: every source row and figure matches the independently read values`, () => {
          expect(diffPaths(figures(p, { blankAsZero: !!m.blankQuartersWereZero }), E)).toEqual([]);
        });

        it(`${w}: nothing left unread, nothing conflicting, all sections parsed`, () => {
          expect(p.workbook.sheets.flatMap((s) => s.unrecognizedRows)).toEqual([]);
          expect(p.parseWarnings.filter((x) => x.blocksFinalize).map((x) => x.code)).toEqual([]);
          for (const k of ['cash', 'distributions', 'income', 'expenseSummary', 'detail', 'transfers']) {
            expect([k, p.sections[k].status]).toEqual([k, 'parsed']);
          }
        });

        it(`${w}: legitimate zeros stay 0 and no primary value is missing`, () => {
          const zeros = (rows) => rows.flatMap((r, i) => r.slice(1).map((x, j) => (x === 0 ? `${i}:${j}` : null)).filter(Boolean));
          const f = figures(p);
          expect(zeros(f.detail)).toEqual(zeros(E.detail));
          const primaries = [...f.income, ...f.groups, ...f.detail].flatMap((r) => [r[2], r[3]]);
          expect(primaries.filter((x) => x == null)).toHaveLength(0);
        });

        it(`${w}: the import plan writes every row, with no null field and nothing listed as missing`, () => {
          const [year, month] = [Number(E.cutoff.slice(0, 4)), Number(E.cutoff.slice(5, 7)) + 1];
          const v = validateBva(p, { cutoffDate: E.cutoff, period: { month, year } });
          expect(v.warnings.filter((x) => x.blocksFinalize && x.overridable === false).map((x) => x.code)).toEqual([]);
          const plan = planBvaImport({ parsed: p, validation: v, confirm: { month, year, cutoffDate: E.cutoff } });
          const lines = plan.budgetLines.toCreate;
          expect(lines.filter((l) => l.bva_detail)).toHaveLength(E.detail.length);
          expect(lines.filter((l) => !l.bva_detail)).toHaveLength(E.income.length + 3);
          expect(plan.transfers.toCreate).toHaveLength(E.transferAmounts.length);
          const nullFields = [plan.periodWrite, ...lines, ...plan.cashAccounts.toCreate, ...plan.transfers.toCreate].flatMap((rec) => Object.keys(rec).filter((k) => rec[k] === null));
          expect(nullFields).toEqual([]);
          expect(plan.periodWrite.source_missing_fields).toEqual([]);
        });
      }

      if (parsedAll.length > 1) {
        it('every version produces the same financial data', () => {
          const [first, ...rest] = parsedAll.map(([, p]) => figures(p));
          for (const f of rest) expect(diffPaths(f, first)).toEqual([]);
        });
      }
    });
  }
});
