#!/usr/bin/env node
// Keeps real client data (workbooks, account identifiers, amounts, names) out of
// git. Checks a private identifier list that never lives in git against every
// added line, file path and commit message, in every directory, and blocks
// workbook and unexpected binary files.
//
// It never prints a matched value: findings are reported as commit, file:line and
// the list entry's number (#N). A file path that itself contains an identifier is
// shown as "[redacted path]".
//
// Usage:
//   node scripts/client-data-scan.mjs <base>..<head>          # each commit in a range
//   node scripts/client-data-scan.mjs --rev-list <args...>    # each commit rev-list selects
//   node scripts/client-data-scan.mjs --cached                # staged changes (pre-commit)
//   node scripts/client-data-scan.mjs --tree [ref]            # every tracked file at ref
// Prefix any of these with --no-identifiers to run only the structural checks
// (blocked files, binaries, comment amounts) without an identifier list. That is
// for CI inside this repo, which must never hold the list (see the workflow).
//
// Identifier list: $CLIENT_IDENTIFIERS, or else (outside CI only) the git-ignored
// bva-workbooks/client-identifiers.txt. One entry per line: account numbers or
// suffixes, bank, entity and person names, transfer purposes, and real amounts.
// '#' starts a comment. A missing or empty list is an error, never a pass.
//
// Only git reads the scanned repository, and only raw content (no textconv or
// external diff drivers), so scanning an untrusted checkout runs none of its code.
//
// Exit codes: 0 clean, 1 findings, 2 misconfigured (no list, bad entry, bad args).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const LOCAL_LIST = 'bva-workbooks/client-identifiers.txt';
const MIN_ENTRY = 3;

// Files that must never be committed, wherever they sit in the tree.
const BLOCKED_PATH = [
  [/(^|\/)bva-workbooks\//, 'file under bva-workbooks/'],
  [/\.(xlsx|xlsm|xlsb|xls|ods|numbers|csv|tsv)$/i, 'spreadsheet file'],
  [/(^|\/)expected-[^/]*\.json$/i, 'acceptance expected-values file'],
];
// Binary files can't be scanned, so only known web-asset types are allowed.
const ALLOWED_BINARY = /\.(png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|eot)$/i;
// Lockfile hash lines are random base64 that can contain any digit run.
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/;
const LOCKFILE_HASH_LINE = /^\s*"(integrity|resolved)":/;

// Warning only (never fails): an uneven dollar-like amount inside a code comment
// outside tests. That is how a real workbook row slipped in before. Test files are
// exempt; their fixtures should use synthetic, round numbers.
const TEST_FILE = /(\.test\.[jt]sx?$|(^|\/)__fixtures__\/)/;
const COMMENT = /(?:\/\/|\/\*|^\s*\*|^\s*#|<!--)(.*)$/;
const AMOUNT = /\b\d{1,3}(?:,\d{3})+\.\d{1,2}\b|\b\d{3,}\.\d{1,2}\b/g;
// Obvious placeholders (1234.56, 999.99) and round amounts (500.00) are exempt.
const PLACEHOLDER = (a) => /^1234\.56$|^(\d)\1*\.\1+$|\.0+$/.test(a.replace(/,/g, ''));

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
const fail = (msg) => { console.error(`client-data-scan: ${msg}`); process.exit(2); };

function loadMatchers() {
  let raw = process.env.CLIENT_IDENTIFIERS;
  // In CI the checkout is untrusted: a pushed commit could plant a harmless list file.
  if (!raw?.trim() && !process.env.GITHUB_ACTIONS && fs.existsSync(LOCAL_LIST)) raw = fs.readFileSync(LOCAL_LIST, 'utf8');
  if (!raw?.trim()) fail(`no identifier list ($CLIENT_IDENTIFIERS is empty${process.env.GITHUB_ACTIONS ? '' : ` and ${LOCAL_LIST} is missing`})`);
  const entries = raw.split(/\r?\n/).map((s) => s.replace(/#.*/, '').trim()).filter(Boolean);
  if (!entries.length) fail('identifier list has no entries');
  return entries.map((entry, i) => {
    if (entry.replace(/[\s,.]/g, '').length < MIN_ENTRY)
      fail(`identifier #${i + 1} is shorter than ${MIN_ENTRY} characters and would match too broadly`);
    return toMatcher(entry);
  });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Numbers ignore thousands separators and trailing zeros (2,500.00 == 2500) and
// never match inside a longer number or word. Text ignores case and treats any
// run of whitespace, '-' or '_' as equivalent.
function toMatcher(entry) {
  if (/^\d[\d,]*(\.\d+)?$/.test(entry)) {
    const [int, frac = ''] = entry.replace(/,/g, '').split('.');
    const f = frac.replace(/0+$/, '');
    const re = new RegExp(`(?<![\\w.])${int}${f ? `\\.${f}0*` : '(?:\\.0+)?'}(?!\\w|\\.\\d)`);
    return (s) => re.test(s.replace(/(\d),(?=\d{3}\b)/g, '$1'));
  }
  const body = entry.split(/[\s_-]+/).map(esc).join('[\\s_-]+');
  const re = new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
  return (s) => re.test(s);
}

const args = process.argv.slice(2);
const noIdentifiers = args[0] === '--no-identifiers';
if (noIdentifiers) args.shift();
const [first, ...rest] = args;
let mode, revArgs, ref;
if (first === '--cached' && !rest.length) mode = 'cached';
else if (first === '--tree' && rest.length <= 1) [mode, ref] = ['tree', rest[0] || 'HEAD'];
else if (first === '--rev-list' && rest.length) [mode, revArgs] = ['range', rest];
else if (first && !first.startsWith('-') && !rest.length) [mode, revArgs] = ['range', [first]];
else fail('usage: client-data-scan.mjs [--no-identifiers] <base>..<head> | --rev-list <args...> | --cached | --tree [ref]');

const matchers = noIdentifiers ? [] : loadMatchers();
const hits = (s) => matchers.flatMap((m, i) => (m(s) ? [i + 1] : []));
const show = (p) => (hits(p).length ? '[redacted path]' : p);
const errors = [];
const warnings = [];

function checkPath(where, path) {
  for (const n of hits(path)) errors.push(`${where}${show(path)}: file path matches private identifier #${n}`);
  for (const [re, why] of BLOCKED_PATH) if (re.test(path)) errors.push(`${where}${show(path)}: ${why} must not be committed`);
}

function checkBinary(where, path) {
  if (!ALLOWED_BINARY.test(path)) errors.push(`${where}${show(path)}: binary file of an unexpected type can't be scanned`);
}

function checkLine(where, path, line, text) {
  if (LOCKFILE.test(path) && LOCKFILE_HASH_LINE.test(text)) return;
  for (const n of hits(text)) errors.push(`${where}${show(path)}:${line}: matches private identifier #${n}`);
  if (!TEST_FILE.test(path) && !LOCKFILE.test(path)) {
    const amounts = COMMENT.exec(text)?.[1].match(AMOUNT) || [];
    if (amounts.some((a) => !PLACEHOLDER(a)))
      warnings.push(`${where}${show(path)}:${line}: uneven dollar amount in a comment; confirm it is synthetic`);
  }
}

// Parses a -U0 diff: unified for ordinary commits, combined (--cc) for merges.
// A merge line prefix has one column per parent; only lines found in none of the
// parents are content the merge itself introduced. Lines from either side are
// checked on their own commits.
function scanDiff(where, diff, parents) {
  const cols = Math.max(parents, 1);
  let path = null, n = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff ')) path = null;
    else if (l.startsWith('+++ ')) { path = l === '+++ /dev/null' ? null : l.slice(6); if (path) checkPath(where, path); }
    else if (l.startsWith('--- ')) continue;
    else if (l.startsWith('Binary files ')) {
      const p = / and b\/(.+) differ$/.exec(l)?.[1];
      if (p) { checkPath(where, p); checkBinary(where, p); }
    } else if (l.startsWith('@@')) n = Number(/ \+(\d+)/.exec(l)[1]);
    else if (path && /^[ +-]+$/.test(l.slice(0, cols))) {
      const prefix = l.slice(0, cols);
      if (prefix.includes('-')) continue;
      if (prefix === '+'.repeat(cols)) checkLine(where, path, n, l.slice(cols));
      n++;
    }
  }
}

const DIFF = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv'];

if (mode === 'tree') {
  for (const path of git('ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean)) {
    checkPath('', path);
    const body = execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { maxBuffer: 1 << 30 });
    if (body.includes(0)) { checkBinary('', path); continue; }
    body.toString('utf8').split('\n').forEach((text, i) => checkLine('', path, i + 1, text));
  }
} else if (mode === 'cached') {
  scanDiff('', git('diff', '--cached', ...DIFF, '--no-renames'), 1);
} else {
  // Every commit in the range, merges included, so data added and later removed
  // within one push is still caught: it stays in history either way.
  for (const c of git('rev-list', '--reverse', ...revArgs).split('\n').filter(Boolean)) {
    const where = `${c.slice(0, 7)} `;
    const parents = git('rev-list', '--parents', '-n1', c).trim().split(' ').length - 1;
    for (const n of hits(git('log', '-1', '--format=%B', c))) errors.push(`${where}commit message matches private identifier #${n}`);
    const diff = parents > 1
      ? git('diff-tree', '-p', '--cc', ...DIFF, c)
      : git('diff-tree', '-p', ...DIFF, '--no-renames', '--root', c);
    scanDiff(where, diff, parents);
  }
}

const out = (level, list) => [...new Set(list)].forEach((m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${m}` : `${level}: ${m}`));
out('warning', warnings);
out('error', errors);
console.log(`client-data-scan: ${noIdentifiers ? 'structural checks only (no identifier list)' : `${matchers.length} identifiers`}, ${new Set(errors).size} error(s), ${new Set(warnings).size} warning(s)`);
process.exit(errors.length ? 1 : 0);
