// FICTIONAL QuickBooks "Transaction Report" (Excel layout) for Phase 5b tests
// and staging. Same structure as the real export: title, period, headings on
// row 4, account headings in column A, transactions B-J with the full account
// path in G, "Total for ..." rows whose column-I formulas add up the rows above,
// a parent's own subtotal before its children and a "with sub-accounts" total,
// "2.  VARIABLE COSTS" with two spaces, accounts without their own number, a
// "(deleted)" account, credits, an account outside the cost groups, rows after
// the cutoff, and the "Cash Basis ..." footer. Every name and amount is invented.
import * as XLSX from 'xlsx';

// tree: [name, children[] | null, ownTx]
export const DETAIL_TREE = [
  ['1. FIXED COSTS', [
    ['6005 - ZZ Auto', [['6015 - ZZ Citations', null, 3], ['6040 - ZZ Parking', null, 6]], 0],
    ['6120 - ZZ Gardening', [['6122 ZZ Tree Care', null, 4], ['6124 ZZ Monthly Gardening', null, 5]], 0],
    ['6210 - ZZ Mortgage', null, 9],
    ['6290 - ZZ Utilities', [['6280 - ZZ Security', [['ZZ Security Reimb', null, 2]], 2]], 0],
  ], 0],
  ['2.  VARIABLE COSTS', [
    ['6105 - ZZ Household', [['6115 - ZZ Flowers', null, 5], ['6125 - ZZ Supplies', null, 12]], 0],
    ['6215 - ZZ Nanny', null, 9],
    ['6550 - ZZ Medical', [['6575 - ZZ Doctor Visits', [['ZZ Person A', null, 6], ['ZZ Person B', null, 3]], 0], ['6630 - ZZ Prescriptions', null, 4]], 0],
  ], 1],
  ['3. DISCRETIONARY COSTS', [
    ['6150 - ZZ Home Improvement', [['6155 - ZZ Art', null, 2], ['6160 - ZZ Furniture', null, 3]], 1],
    ['6720 - ZZ Clothing', null, 14],
    ['6845 - ZZ Personal', [['6875 - ZZ Hair', null, 4], [' ZZ SPA (deleted)', null, 1]], 0],
    ['7100 - ZZ Travel', [['7115 - ZZ Airfare', null, 4]], 0],
    ['8030 - ZZ Monthly Savings', null, 3],
    ['ZZ Event', null, 1],
  ], 0],
  ['7215 - ZZ Card Interest', null, 3],
];

const pad = (n) => String(n).padStart(2, '0');
// Deterministic pseudo-random (no Math.random: tests must be repeatable).
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// scale: transactions per leaf are multiplied (scale 30 -> about 2,600 rows).
// year/cutoff: rows dated after `cutoffMonth` (1-12) exist but are later in the year.
export function makeDetailModel({ year = 9102, scale = 1, cutoffMonth = 6, seed = 7 } = {}) {
  const rand = rng(seed);
  const rows = [];
  const formulas = {};
  let r = 0;
  const byR = new Map();
  const push = (o) => { r += 1; const row = { r, A: null, B: null, C: null, D: null, E: null, F: null, G: null, H: null, I: null, J: null, ...o }; rows.push(row); byR.set(r, row); return r; };
  push({ A: 'Transaction Report' });
  push({ A: `January-December, ${year}` });
  r += 1; // blank row 3
  push({ B: 'Transaction date', C: 'Transaction type', D: 'Num', E: 'Name', F: 'Description', G: 'Account Name', H: 'Item split account', I: 'Amount', J: 'Balance' });
  const txRowsByPath = new Map();
  const walk = (node, parentPath) => {
    const [name, children, own] = node;
    const path = parentPath ? `${parentPath}:${name}` : name;
    const header = push({ A: name.trim() });
    const ownRows = [header];
    const n = Math.max(0, Math.round((own || 0) * scale));
    let bal = 0;
    for (let i = 0; i < n; i++) {
      // most rows before the cutoff, a few after it; about one in eight a credit
      const month = i % 9 === 8 ? Math.min(12, cutoffMonth + 1 + (i % 3)) : 1 + Math.floor(rand() * cutoffMonth);
      const day = 1 + Math.floor(rand() * 27);
      const credit = i % 8 === 7;
      const amt = Math.round((credit ? -1 : 1) * (5 + rand() * 900) * 100) / 100;
      bal = Math.round((bal + amt) * 100) / 100;
      ownRows.push(push({
        B: `${pad(month)}/${pad(day)}/${year}`, C: credit ? 'Credit Card Credit' : 'Expense', D: i % 50 === 0 ? `ZZ-${i}` : '',
        E: `ZZ Payee ${(i % 23) + 1}`, F: `ZZ MEMO REF XXXX${1000 + i}`, G: path, H: i % 2 ? 'ZZ Card 0001' : 'ZZ Bank 0002', I: amt, J: bal,
      }));
    }
    txRowsByPath.set(path, ownRows.length - 1);
    const sumRows = (list) => Math.round(list.reduce((s, x) => s + (byR.get(x)?.I || 0), 0) * 100) / 100;
    if (!children) {
      const t = push({ A: `Total for ${name.trim()}`, I: sumRows(ownRows) });
      formulas[t] = ownRows;
      return t;
    }
    const parts = [];
    if (n > 0) { const own1 = push({ A: `Total for ${name.trim()}`, I: sumRows(ownRows) }); formulas[own1] = ownRows; parts.push(own1); }
    for (const c of children) parts.push(walk(c, path));
    const t = push({ A: `Total for ${name.trim()} with sub-accounts`, I: sumRows(parts) });
    formulas[t] = parts;
    return t;
  };
  const tops = DETAIL_TREE.map((node) => walk(node, ''));
  const total = push({ A: 'TOTAL', I: Math.round(tops.reduce((s, x) => s + byR.get(x).I, 0) * 100) / 100 });
  formulas[total] = tops;
  r += 3;
  push({ A: `Cash Basis Monday, October 1, ${year} 09:00 AM GMT-04:00` });
  return { rows, formulas, year, cutoff: `${year}-${pad(cutoffMonth)}-${new Date(Date.UTC(year, cutoffMonth, 0)).getUTCDate()}` };
}

// The same model as an .xlsx workbook (formulas included), for the parser.
export function detailWorkbookBytes(model) {
  const ws = {};
  let maxR = 1;
  for (const row of model.rows) {
    maxR = Math.max(maxR, row.r);
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      const cell = typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
      if (c === 'I' && model.formulas[row.r]) cell.f = model.formulas[row.r].map((x) => `I${x}`).join('+');
      ws[`${c}${row.r}`] = cell;
    }
  }
  ws['!ref'] = `A1:J${maxR}`;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
