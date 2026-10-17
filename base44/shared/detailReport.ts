// Phase 5b: QuickBooks "Transaction Report" (Excel export) as transaction-level
// drill-down for a report version. Shared by the browser importer (preview) and
// periodTransition (stage_detail / commit_detail, check, finalize) and the
// drill-down endpoints. Pure functions, no I/O.
//
// Rules (owner, 2026-10-17):
// - The BVA stays authoritative for every dashboard figure; this detail only
//   supports drill-down. Reconciliation differences are warnings, never blockers.
// - Excel is the import source. The file must pass three checks before anything
//   is stored: transaction sum = report TOTAL; running balances continuous per
//   account; every subtotal (Excel formula) recomputes from the cells it names.
// - Strictly through the version's BVA cutoff; later rows are counted, not stored.
// - Signed amounts kept exactly (whole cents); credits/refunds stay negative.
// - Group lines map by top-level cost group; watch-list lines by account number
//   in the full account path, child accounts included. An account without a
//   number of its own counts toward a watch line, and is shown to the client,
//   only once its full path is confirmed (DetailAccountMap). Anything outside
//   the three cost groups is "unmapped": kept internal, never dropped.

export const DETAIL_HEADERS = ['Transaction date', 'Transaction type', 'Num', 'Name', 'Description', 'Account Name', 'Item split account', 'Amount', 'Balance'];
export const CHUNK_ROWS = 250; // rows per TransactionDetailChunk record

export const toCents = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const fromCents = (c: number | null) => (c == null ? null : c / 100);
const fmt = (c: number | null) => (c == null ? '—' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ---- account paths ------------------------------------------------------------
// QuickBooks writes "2.  VARIABLE COSTS" (two spaces): whitespace is normalised.
export const normSegment = (s: any) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const normPath = (p: any) => String(p ?? '').split(':').map(normSegment).filter(Boolean).join(':');
const segments = (p: string) => normPath(p).split(':').filter(Boolean);
const NUM = /^(\d{4})(?=\D|$)/;
export const segmentNumber = (seg: string) => (normSegment(seg).match(NUM) || [])[1] || null;
export const pathNumbers = (p: string) => segments(p).map(segmentNumber).filter(Boolean) as string[];
export const ownNumber = (p: string) => { const s = segments(p); return s.length ? segmentNumber(s[s.length - 1]) : null; };
export const GROUPS = { fixed: /^1\.\s*FIXED\b/i, variable: /^2\.\s*VARIABLE\b/i, discretionary: /^3\.\s*DISCRETIONARY\b/i } as const;
export function topGroup(p: string): 'fixed' | 'variable' | 'discretionary' | null {
  const first = segments(p)[0] || '';
  for (const [k, re] of Object.entries(GROUPS)) if (re.test(first)) return k as any;
  return null;
}
const cleanName = (seg: string) => normSegment(seg).replace(/^\d{4}\s*-?\s*/, '').replace(/\(deleted\)/gi, '').replace(/^[-\s]+|[-\s]+$/g, '').replace(/\s+/g, ' ').trim();
// The client-facing account name: the last part of the path without its number
// ("6115 - Flowers" -> "Flowers"); an account without its own number reads
// "<parent> – <account>" unless a confirmed plain name was given.
export function plainAccountName(p: string, confirmedName: string | null = null) {
  if (confirmedName && confirmedName.trim()) return confirmedName.trim();
  const s = segments(p);
  if (!s.length) return '';
  const last = cleanName(s[s.length - 1]);
  if (segmentNumber(s[s.length - 1]) || s.length < 2 || topGroupOf(s[s.length - 2])) return last;
  return `${cleanName(s[s.length - 2])} – ${last}`;
}
const topGroupOf = (seg: string) => Object.values(GROUPS).some((re) => re.test(normSegment(seg)));

// ---- reading the sheet model ------------------------------------------------------
// The browser parser (src/lib/detailWorkbook.js) turns the Excel sheet into
//   { rows: [{ r, A, B, C, D, E, F, G, H, I, J }], formulas: { [r]: number[] } }
// (cell values as stored; formulas = the rows a column-I formula adds up).
export function readDetailReport(model: any) {
  const errors: string[] = [];
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const byR = new Map(rows.map((x: any) => [x.r, x]));
  const title = normSegment(rows.find((x: any) => x.r === 1)?.A);
  const periodText = normSegment(rows.find((x: any) => x.r === 2)?.A);
  if (title !== 'Transaction Report') errors.push(`The first row should read "Transaction Report" (found "${title || 'nothing'}"). Export the QuickBooks Transaction Report to Excel.`);
  const header = rows.find((x: any) => normSegment(x.B) === DETAIL_HEADERS[0]);
  if (!header) errors.push('The column headings (Transaction date … Balance) were not found.');
  else {
    const got = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((k) => normSegment(header[k]));
    if (got.join('|') !== DETAIL_HEADERS.join('|')) errors.push(`The columns are not the expected ones: ${got.join(', ')}.`);
  }
  const pm = periodText.match(/^([A-Za-z]+)(?:\s+\d{1,2})?\s*-\s*([A-Za-z]+)(?:\s+\d{1,2})?,\s*(\d{4})$/);
  if (!pm) errors.push(`The report period "${periodText || 'missing'}" could not be read.`);
  const footerRow = [...rows].reverse().find((x: any) => /^(Cash|Accrual) Basis/i.test(normSegment(x.A)));
  const footer = normSegment(footerRow?.A);
  const meta = {
    title, period: periodText,
    year: pm ? Number(pm[3]) : null,
    startsJanuary: pm ? /^jan/i.test(pm[1]) : false,
    basis: (footer.match(/^(Cash|Accrual) Basis/i) || [])[0] || null,
    run_at: footer.replace(/^(Cash|Accrual) Basis\s*/i, '') || null,
  };
  const transactions: any[] = [];
  const headersSeen: any[] = [];
  const totals: any[] = [];
  let grandTotal: any = null;
  const stack: string[] = [];
  // a parent's own subtotal comes before its children close; it closes at its
  // "with sub-accounts" total
  const parents = new Set(rows.filter((x: any) => /^Total for .* with sub-accounts$/.test(normSegment(x.A))).map((x: any) => normSegment(x.A).replace(/^Total for /, '').replace(/ with sub-accounts$/, '')));
  const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  for (const x of rows) {
    if (!header || x.r <= header.r || x === footerRow) continue;
    const a = normSegment(x.A), b = normSegment(x.B);
    if (b) {
      const m = b.match(DATE);
      if (!m) { errors.push(`Row ${x.r}: "${b}" is not a date (MM/DD/YYYY).`); continue; }
      const amount = toCents(x.I), balance = toCents(x.J);
      if (amount == null || balance == null) { errors.push(`Row ${x.r}: amount or balance is not a number.`); continue; }
      transactions.push({
        r: x.r, date: `${m[3]}-${m[1]}-${m[2]}`, type: normSegment(x.C), num: normSegment(x.D), payee: normSegment(x.E),
        memo: normSegment(x.F), path: normPath(x.G), payment: normSegment(x.H), amount, balance, headerPath: stack.join(':'),
      });
    } else if (/^TOTAL$/i.test(a)) {
      grandTotal = { r: x.r, value: toCents(x.I), refs: model?.formulas?.[x.r] || null };
    } else if (/^Total for /.test(a)) {
      const label = a.replace(/^Total for /, '').replace(/ with sub-accounts$/, '');
      totals.push({ r: x.r, label, value: toCents(x.I), refs: model?.formulas?.[x.r] || null });
      if (parents.has(label) && !/ with sub-accounts$/.test(a)) continue;
      while (stack.length && stack[stack.length - 1] !== label) stack.pop();
      if (stack.length) stack.pop();
    } else if (a) {
      headersSeen.push({ r: x.r, label: a });
      stack.push(a);
    } else if ([x.C, x.D, x.E, x.F, x.G, x.H, x.I, x.J].some((v) => v !== null && v !== undefined && v !== '')) {
      errors.push(`Row ${x.r}: content outside the report layout.`);
    }
  }
  if (!grandTotal) errors.push('The report has no TOTAL row.');
  return { meta, transactions, totals, grandTotal, headers: headersSeen, errors, byR };
}

// ---- the three checks ----------------------------------------------------------------
// Returns { ok, checks: [{ key, ok, message }] }. Nothing may be stored unless ok.
export function validateDetailReport(read: any) {
  const checks: any[] = [];
  const add = (key: string, ok: boolean, message: string) => checks.push({ key, ok, message });
  add('layout', read.errors.length === 0, read.errors.length ? read.errors.slice(0, 5).join(' ') + (read.errors.length > 5 ? ` (+${read.errors.length - 5} more)` : '') : 'Recognised QuickBooks Transaction Report layout.');
  const tx = read.transactions;
  const sum = tx.reduce((s: number, t: any) => s + t.amount, 0);
  const total = read.grandTotal?.value ?? null;
  add('sum', total != null && sum === total, total == null ? 'The report TOTAL is missing.' : sum === total ? `The ${tx.length} transactions add up to the report total (${fmt(total)}).` : `The transactions add up to ${fmt(sum)}, but the report total is ${fmt(total)}.`);
  // running balance per account, in report order
  const prev = new Map<string, number>();
  const breaks: number[] = [];
  for (const t of tx) {
    const expected = (prev.get(t.path) ?? 0) + t.amount;
    if (expected !== t.balance) breaks.push(t.r);
    prev.set(t.path, t.balance);
  }
  add('balances', breaks.length === 0, breaks.length ? `The running balance breaks at ${breaks.length} row(s) (first: row ${breaks[0]}) — rows may be missing or reordered.` : 'Running balances are continuous in every account.');
  // every subtotal: formula recomputation, and leaf totals = their transactions
  const valueAt = new Map<number, number>();
  for (const t of tx) valueAt.set(t.r, t.amount);
  for (const s of read.totals) if (s.value != null) valueAt.set(s.r, s.value);
  if (read.grandTotal?.value != null) valueAt.set(read.grandTotal.r, read.grandTotal.value);
  const bad: string[] = [];
  const all = [...read.totals, ...(read.grandTotal ? [{ ...read.grandTotal, label: 'TOTAL' }] : [])];
  let withFormula = 0;
  for (const s of all) {
    if (s.value == null) { bad.push(`${s.label} has no amount`); continue; }
    if (Array.isArray(s.refs)) {
      withFormula++;
      const re = s.refs.reduce((acc: number, r: number) => acc + (valueAt.get(r) ?? 0), 0);
      if (re !== s.value) bad.push(`${s.label}: ${fmt(s.value)} vs ${fmt(re)} recomputed`);
    }
  }
  // every transaction is inside exactly one subtotal formula
  const refCount = new Map<number, number>();
  for (const s2 of read.totals) for (const r of Array.isArray(s2.refs) ? s2.refs : []) refCount.set(r, (refCount.get(r) ?? 0) + 1);
  const orphans = tx.filter((t: any) => (refCount.get(t.r) ?? 0) !== 1);
  if (withFormula && orphans.length) bad.push(`${orphans.length} transaction(s) are not inside exactly one subtotal (first: row ${orphans[0].r})`);
  if (!withFormula) bad.push('the subtotals carry no formulas (export the report to Excel from QuickBooks without changes)');
  add('subtotals', bad.length === 0, bad.length ? `Subtotals do not match: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}.` : `All ${all.length} subtotals recompute exactly.`);
  const pathMismatch = tx.filter((t: any) => normPath(t.headerPath) !== t.path).length;
  add('structure', pathMismatch === 0, pathMismatch ? `${pathMismatch} transaction(s) sit under a different account heading than their Account Name.` : 'Every transaction sits under its own account heading.');
  return { ok: checks.every((c) => c.ok), checks };
}

// ---- the version's rows: cutoff, mapping, client visibility ----------------------------
// `confirmed`: Map(normalised path -> plain name) of confirmed accounts without
// their own number. Returns stored rows (compact) plus what was left out.
export function buildDetailRows(read: any, { cutoff, year }: { cutoff: string; year: number }, confirmed: Map<string, string> = new Map()) {
  const issues: string[] = [];
  if (read.meta.year !== Number(year)) issues.push(`The report is for ${read.meta.year ?? 'an unknown year'}, but this report version is for ${year}.`);
  if (!read.meta.startsJanuary) issues.push(`The report must start on January 1 (it covers "${read.meta.period}") so year-to-date detail is complete.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoff || ''))) issues.push('This report version has no confirmed cutoff date.');
  const through: any[] = [];
  let after = 0, afterCents = 0;
  for (const t of read.transactions) {
    if (cutoff && t.date > cutoff) { after++; afterCents += t.amount; continue; }
    if (!t.date.startsWith(`${year}-`)) { issues.push(`Row ${t.r} is dated ${t.date}, outside ${year}.`); continue; }
    const group = topGroup(t.path);
    const own = ownNumber(t.path);
    const conf = own ? true : confirmed.has(t.path);
    through.push({
      r: t.r, d: t.date, py: t.payee, a: t.amount, ac: plainAccountName(t.path, own ? null : confirmed.get(t.path) || null),
      p: t.path, n: own || '', ns: pathNumbers(t.path), g: group || '', ok: !!(group && conf),
      ty: t.type, no: t.num, m: t.memo, pm: t.payment,
    });
  }
  return { rows: through, after: { count: after, cents: afterCents }, issues };
}

// Rows that count toward a watch-list line with account number `code`: any row
// whose path contains that number (children included) -- an account without its
// own number only when confirmed (row.ok).
const countsForWatch = (row: any, code: string) => row.ns.includes(code) && (row.n ? true : row.ok);

// ---- reconciliation ----------------------------------------------------------------
// lines: the version's BudgetLines (the BVA, authoritative). Per line:
//   { key, kind: 'group'|'watch', line_id, label, group, code, bva_total,
//     detail_total, listed_total, difference, status, withheld }
// (cents). status: reconciled | difference | no_detail | bva_missing.
// `listed_total` = rows the client may see (confirmed accounts).
export function reconcileDetail(rows: any[], lines: any[]) {
  const out: any[] = [];
  const isDetailLine = (l: any) => !!(l.bva_detail || l.detail_flag);
  const groupLines = (g: string) => lines.filter((l) => l.budget_group === g && !isDetailLine(l));
  const statusOf = (bva: number | null, detail: number, n: number) => (bva == null ? 'bva_missing' : n === 0 ? 'no_detail' : detail === bva ? 'reconciled' : 'difference');
  for (const g of ['fixed', 'variable', 'discretionary'] as const) {
    const gl = groupLines(g);
    if (!gl.length) continue;
    const vals = gl.map((l) => toCents(l.ytd_actual));
    const bva = vals.some((v) => v == null) ? null : vals.reduce((s: number, v: any) => s + v, 0);
    const mine = rows.filter((r) => r.g === g);
    const detail = mine.reduce((s, r) => s + r.a, 0);
    const listed = mine.filter((r) => r.ok).reduce((s, r) => s + r.a, 0);
    out.push({ key: `group:${g}`, kind: 'group', line_id: gl[0].id, line_ids: gl.map((l) => l.id), label: gl.length === 1 ? gl[0].category : g, group: g, code: null,
      bva_total: bva, detail_total: detail, listed_total: listed, difference: bva == null ? null : detail - bva, status: statusOf(bva, detail, mine.length), rows: mine.length, withheld: mine.filter((r) => !r.ok).length });
  }
  for (const l of lines.filter(isDetailLine)) {
    const code = segmentNumber(String(l.qb_code || '')) || segmentNumber(String(l.category || ''));
    if (!code) continue;
    const bva = toCents(l.ytd_actual);
    const mine = rows.filter((r) => countsForWatch(r, code));
    const detail = mine.reduce((s, r) => s + r.a, 0);
    const withheld = rows.filter((r) => r.ns.includes(code) && !r.n && !r.ok).length;
    out.push({ key: `watch:${l.id}`, kind: 'watch', line_id: l.id, label: l.category, group: l.budget_group || null, code,
      bva_total: bva, detail_total: detail, listed_total: detail, difference: bva == null ? null : detail - bva, status: statusOf(bva, detail, mine.length), rows: mine.length, withheld });
  }
  const unmapped = rows.filter((r) => !r.g);
  const byAcct = new Map<string, { count: number; cents: number }>();
  for (const r of unmapped) { const b = byAcct.get(r.p) || { count: 0, cents: 0 }; b.count++; b.cents += r.a; byAcct.set(r.p, b); }
  const unconfirmed = new Map<string, { count: number; cents: number }>();
  for (const r of rows.filter((x) => x.g && !x.ok)) { const b = unconfirmed.get(r.p) || { count: 0, cents: 0 }; b.count++; b.cents += r.a; unconfirmed.set(r.p, b); }
  return {
    lines: out,
    unmapped: { count: unmapped.length, cents: unmapped.reduce((s, r) => s + r.a, 0), accounts: [...byAcct].map(([path, v]) => ({ path, ...v })) },
    unconfirmed: [...unconfirmed].map(([path, v]) => ({ path, ...v })),
  };
}

// The rows behind one BVA line (for the drill-down), by its reconciliation entry.
export function rowsForLine(rows: any[], entry: any) {
  if (!entry) return [];
  if (entry.kind === 'group') return rows.filter((r) => r.g === entry.group);
  return rows.filter((r) => countsForWatch(r, entry.code));
}

// What a client may see for one line (decisions B and C, 2026-10-17):
//   group line: the confirmed rows, with a neutral note when the totals differ;
//   watch line: rows only when it reconciles; otherwise no rows, a neutral note.
export const PUBLIC_DETAIL_FIELDS = ['date', 'payee', 'amount', 'account'];
export function clientDetail(rows: any[], entry: any) {
  if (!entry) return { transactions: [], note: null, listed_total: null };
  const listed = rowsForLine(rows, entry).filter((r) => r.ok);
  const listedCents = listed.reduce((s, r) => s + r.a, 0);
  const asClient = listed.map((r) => ({ date: r.d, payee: r.py || '', amount: r.a / 100, account: r.ac || '' }));
  const matches = entry.status === 'reconciled' && listedCents === entry.bva_total;
  if (entry.kind === 'watch' && !matches) {
    return { transactions: [], listed_total: null, note: 'Transaction detail isn\'t shown for this category in this report: the transaction ledger and the report figure don\'t match. The report figure is the one used on this dashboard.' };
  }
  const note = matches
    ? `Listed transactions total ${fmt(listedCents)}, matching the report.`
    : entry.bva_total == null
      ? `The listed transactions total ${fmt(listedCents)}. The report shows no figure for this line.`
      : `The listed transactions total ${fmt(listedCents)}; the report shows ${fmt(entry.bva_total)}. The report figure is the one used on this dashboard.`;
  return { transactions: asClient, listed_total: listedCents / 100, note };
}

// Warnings for the review (never blockers).
export function detailWarnings(reconciliation: any) {
  if (!reconciliation) return [];
  const out: any[] = [];
  for (const e of reconciliation.lines || []) {
    if (e.status === 'difference') out.push({ code: `detail_difference:${e.key}`, message: `${e.label}: the transaction detail totals ${fmt(e.detail_total)}, the report ${fmt(e.bva_total)} (difference ${fmt(e.difference)}).${e.kind === 'watch' ? ' Its transactions are not shown to the client.' : ''}` });
    if (e.status === 'no_detail' && e.bva_total) out.push({ code: `detail_difference:${e.key}`, message: `${e.label}: no transactions in the detail for a report figure of ${fmt(e.bva_total)}.` });
  }
  const u = reconciliation.unmapped;
  if (u?.count) out.push({ code: 'detail_unmapped', message: `${u.count} transaction(s) (${fmt(u.cents)}) are outside the three cost groups (${u.accounts.map((a: any) => a.path).join(', ')}); they are kept internal.` });
  if (reconciliation.unconfirmed?.length) out.push({ code: 'detail_unconfirmed', message: `${reconciliation.unconfirmed.length} account(s) without their own number are not confirmed, so their transactions are not shown to the client: ${reconciliation.unconfirmed.map((a: any) => a.path).join('; ')}.` });
  return out;
}

// The compact package the server re-validates at commit (no memos or payees).
// Transaction rows keep only date, account path, amount and balance; every
// other row (title, period, headings, totals, footer) is kept whole.
export function validationPackage(model: any) {
  const isTx = (x: any) => /^\d{2}\/\d{2}\/\d{4}$/.test(normSegment(x.B));
  return {
    rows: (model.rows || []).map((x: any) => (isTx(x) ? { r: x.r, B: x.B, G: x.G, I: x.I, J: x.J } : x)),
    formulas: model.formulas || {},
  };
}
export const modelFromPackage = (pkg: any) => ({ rows: Array.isArray(pkg?.rows) ? pkg.rows : [], formulas: pkg?.formulas || {} });

export const chunkRows = (rows: any[], size = CHUNK_ROWS) => {
  const out: any[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};
