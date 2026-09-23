// Regression tests for scripts/client-data-scan.mjs. Each test builds commits in a
// throwaway git repo and runs the scanner as a subprocess.
//
// EVERY identifier, name, account number and amount in this file is FICTIONAL.
// Never add real client data here, even to reproduce a bug: invent an equivalent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAN = fileURLToPath(new URL('./client-data-scan.mjs', import.meta.url));

// Fictional list. Entry numbers (#1..#6) are what the scanner reports.
const LIST = [
  '# fictional identifiers',
  'Zephyr Trust Bank', // #1
  '7342', // #2 account suffix
  'Quillon Holdings', // #3 entity
  'Marisol Vantreight', // #4 person
  '4817.35', // #5 amount
  'Lakehouse Reserve', // #6 transfer purpose
].join('\n');
const VALUES = /zephyr trust bank|7342|quillon|marisol|vantreight|4817|lakehouse reserve/i;

let dir;
const outputs = [];
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = (file, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};
const commit = (message = 'change') => {
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
};
function scan(args, env = { CLIENT_IDENTIFIERS: LIST }) {
  const clean = { ...process.env };
  delete clean.CLIENT_IDENTIFIERS;
  delete clean.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, [SCAN, ...args], { cwd: dir, encoding: 'utf8', env: { ...clean, ...env } });
  const out = r.stdout + r.stderr;
  outputs.push(out);
  return { code: r.status, out };
}
const one = (sha) => [`${sha}^!`];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-data-scan-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  write('README.md', 'seed\n');
  commit('seed');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('client-data-scan: finds client data', () => {
  it('bank name and account suffix in a code comment', () => {
    write('src/lib/a.js', '// e.g. ["Zephyr Trust Bank 7342", "Savings", "", 10]\n');
    const { code, out } = scan(one(commit()));
    expect(code).toBe(1);
    expect(out).toContain('src/lib/a.js:1: matches private identifier #1');
    expect(out).toContain('src/lib/a.js:1: matches private identifier #2');
  });

  it('an amount written with a thousands comma and trailing zero', () => {
    write('src/lib/b.js', 'const note = "moved $4,817.350 last month";\n');
    expect(scan(one(commit())).out).toContain('src/lib/b.js:1: matches private identifier #5');
  });

  it('a name in an unexpected directory, with odd case and spacing', () => {
    write('misc/notes/readme.txt', 'owner: marisol   VANTREIGHT\n');
    expect(scan(one(commit())).out).toContain('misc/notes/readme.txt:1: matches private identifier #4');
  });

  it('a hyphenated entity name in a dot-directory', () => {
    write('.github/x.yml', 'entity: Quillon-Holdings\n');
    expect(scan(one(commit())).out).toContain('.github/x.yml:1: matches private identifier #3');
  });

  it.each([
    ['data/report.xlsx', 'spreadsheet file must not be committed'],
    ['export.CSV', 'spreadsheet file must not be committed'],
    ['tools/bva-workbooks/a.txt', 'file under bva-workbooks/ must not be committed'],
    ['src/lib/expected-aug-2026.json', 'acceptance expected-values file must not be committed'],
  ])('blocked file %s', (file, message) => {
    write(file, 'x\n');
    const { code, out } = scan(one(commit()));
    expect(code).toBe(1);
    expect(out).toContain(`${file}: ${message}`);
  });

  it('an unscannable binary file type (PDF)', () => {
    write('docs/statement.pdf', Buffer.from('%PDF-1.4\0\x01'));
    expect(scan(one(commit())).out).toContain("docs/statement.pdf: binary file of an unexpected type can't be scanned");
  });

  it('an identifier in a file path, which is redacted from the output', () => {
    write('docs/Lakehouse Reserve.md', 'hi\n');
    const { code, out } = scan(one(commit()));
    expect(code).toBe(1);
    expect(out).toContain('[redacted path]: file path matches private identifier #6');
  });

  it('an identifier in a commit message', () => {
    write('README.md', 'seed\nmore\n');
    expect(scan(one(commit('Move funds for Quillon Holdings'))).out).toContain('commit message matches private identifier #3');
  });

  it('data added and removed within one push (it stays in history)', () => {
    write('src/lib/tmp.js', 'x = "Zephyr Trust Bank"\n');
    const added = commit();
    fs.rmSync(path.join(dir, 'src/lib/tmp.js'));
    const removed = commit();
    const { code, out } = scan([`${added}~1..${removed}`]);
    expect(code).toBe(1);
    expect(out).toContain(`${added.slice(0, 7)} src/lib/tmp.js:1: matches private identifier #1`);
  });

  it('content introduced by a merge conflict resolution', () => {
    const main = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('checkout', '-q', '-b', 'side');
    write('src/lib/m.js', 'side = 1\n');
    commit();
    git('checkout', '-q', main);
    write('src/lib/m.js', 'main = 1\n');
    commit();
    spawnSync('git', ['merge', '-q', 'side'], { cwd: dir });
    write('src/lib/m.js', 'main = 1\nside = 1\nacct = "7342"\n');
    git('add', '-A');
    git('-c', 'core.editor=true', 'commit', '-q', '--no-edit');
    const merge = git('rev-parse', 'HEAD');
    expect(scan(one(merge)).out).toContain(`${merge.slice(0, 7)} src/lib/m.js:3: matches private identifier #2`);
  });

  it('non-hash lines of the lockfile', () => {
    write('package-lock.json', '{\n  "name": "Quillon Holdings"\n}\n');
    expect(scan(one(commit())).out).toContain('package-lock.json:2: matches private identifier #3');
  });

  it('commits selected with --rev-list', () => {
    write('src/lib/r.js', 'x = "Lakehouse Reserve"\n');
    const c = commit();
    expect(scan(['--rev-list', '-n1', c]).out).toContain(`${c.slice(0, 7)} src/lib/r.js:1: matches private identifier #6`);
  });
});

describe('client-data-scan: allows synthetic and ordinary content', () => {
  it('fixtures, near-misses, lockfile hashes, images and placeholder amounts', () => {
    const before = git('rev-parse', 'HEAD');
    write('src/lib/__fixtures__/sample.js', [
      '// Synthetic fixture: invented names, round numbers.',
      'export const rows = [["Acct A", "Tax Savings", "", 500], ["Lease Co", "Auto", "", 750]];',
      'export const client = "Sample Client"; export const amt = 1234.56;',
    ].join('\n'));
    write('src/lib/near.js', [
      'const ids = [173420, 73421, "v7342x", "x7342"]; // longer numbers, glued to letters',
      'const amt = [4817.36, 4817.3, 14817.35, 4817.351]; // different amounts',
      'const partial = ["Zephyr Trust", "Quillon"]; // partial names',
      '// "$1,234.56 Over Budget" / "$2,500.00 Under Budget"',
    ].join('\n'));
    write('package-lock.json', '{\n  "integrity": "sha512-ab+7342/Zz==",\n  "resolved": "https://r/x-7342.tgz"\n}\n');
    write('src/logo.png', Buffer.from('\x89PNG\r\n\x1a\n\0\x01', 'latin1'));
    const { code, out } = scan([`${before}..${commit()}`]);
    expect(out).toContain('0 error(s), 0 warning(s)');
    expect(code).toBe(0);
  });

  it('warns, without failing, on an uneven amount in a code comment', () => {
    write('src/lib/w.js', '// e.g. transfer of 9,381.27 last month\n');
    const { code, out } = scan(one(commit()));
    expect(code).toBe(0);
    expect(out).toContain('src/lib/w.js:1: uneven dollar amount in a comment');
  });

  it('does not warn on the same amount in a test file', () => {
    write('src/lib/w.test.js', 'const t = 9381.27; // test data\n');
    expect(scan(one(commit())).out).toContain('0 error(s), 0 warning(s)');
  });
});

describe('client-data-scan: modes', () => {
  it('--cached blocks a staged identifier and passes a clean change', () => {
    write('src/lib/staged.js', 'x = "Lakehouse Reserve"\n');
    git('add', 'src/lib/staged.js');
    expect(scan(['--cached'])).toMatchObject({ code: 1 });
    write('src/lib/staged.js', 'x = 1\n');
    git('add', 'src/lib/staged.js');
    expect(scan(['--cached'])).toMatchObject({ code: 0 });
    git('reset', '-q');
    fs.rmSync(path.join(dir, 'src/lib/staged.js'));
  });

  it('--tree finds identifiers present at a ref and passes a clean one', () => {
    expect(scan(['--tree', 'HEAD']).code).toBe(1);
    const root = git('rev-list', '--max-parents=0', 'HEAD');
    expect(scan(['--tree', root]).code).toBe(0);
  });

  it('--no-identifiers runs structural checks without a list', () => {
    const { code, out } = scan(['--no-identifiers', '--tree', 'HEAD'], {});
    expect(code).toBe(1);
    expect(out).toContain('spreadsheet file must not be committed');
    expect(out).not.toContain('private identifier');
    expect(out).toContain('structural checks only');
  });
});

describe('client-data-scan: fails closed', () => {
  it.each([
    ['a missing list', {}, 'no identifier list'],
    ['a list with no entries', { CLIENT_IDENTIFIERS: '# only a comment\n\n' }, 'no entries'],
    ['a too-short entry, without echoing it', { CLIENT_IDENTIFIERS: 'Zephyr Trust Bank\n12' }, 'identifier #2 is shorter'],
  ])('%s exits 2', (_, env, message) => {
    const { code, out } = scan(['--tree', 'HEAD'], env);
    expect(code).toBe(2);
    expect(out).toContain(message);
  });

  it('bad arguments exit 2', () => {
    expect(scan(['--bogus']).code).toBe(2);
    expect(scan(['--tree', 'a', 'b']).code).toBe(2);
  });

  it('uses the git-ignored local list outside CI, but never inside CI', () => {
    write('bva-workbooks/client-identifiers.txt', 'Quillon Holdings\n');
    try {
      expect(scan(['--tree', 'HEAD'], {}).code).toBe(1);
      const ci = scan(['--tree', 'HEAD'], { GITHUB_ACTIONS: 'true' });
      expect(ci.code).toBe(2);
      expect(ci.out).toContain('no identifier list');
    } finally {
      fs.rmSync(path.join(dir, 'bva-workbooks'), { recursive: true, force: true });
    }
  });
});

describe('client-data-scan: never prints a matched value', () => {
  it('no identifier value appears in any output above', () => {
    expect(outputs.length).toBeGreaterThan(20);
    // Drop commit hashes first: a random 7-hex prefix could contain "7342".
    for (const out of outputs) expect(out.replace(/\b[0-9a-f]{7}\b/g, '')).not.toMatch(VALUES);
  });
});
