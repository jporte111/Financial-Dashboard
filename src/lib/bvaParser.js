// Parser for the monthly BVA ("Budget vs Actual") Excel workbook.
//
// The workbook is a single flat sheet with six labelled blocks. Blocks are
// located by their anchor label rather than fixed row numbers, because the
// layout drifts month to month. Only the columns known to be reliable are
// read; every derived column (Remaining, % of Budget, variance) is left for
// src/lib/bvaValidation.js to recompute, because the workbook's DETAIL block
// has historically had those formulas shifted by a row.

import * as XLSX from 'xlsx';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const neg = /^\s*\(.*\)\s*$/.test(String(v));
  const s = String(v).replace(/[$,\s]/g, '').replace(/[()]/g, '');
  const x = Number(s);
  if (!Number.isFinite(x)) return null;
  return neg ? -x : x;
}

const norm = (v) => String(v == null ? '' : v).trim();
const low = (v) => norm(v).toLowerCase();

function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  // Excel serial date number
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  // Only accept clearly date-shaped strings — never a generic `new Date()`
  // fallback, which would misread account names like "Acme Bank - 1234".
  const s = norm(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

// "  4030 - Interest Income" -> { code: '4030', name: 'Interest Income' }
// " 1. FIXED " -> { code: '1', name: 'FIXED' }
// "6120 Grounds Care" -> { code: '6120', name: 'Grounds Care' }
function splitCode(label) {
  const s = norm(label);
  const m = s.match(/^(\d+)\s*[.\-–:]?\s*(.*)$/);
  if (m) return { code: m[1], name: norm(m[2]) || s };
  return { code: null, name: s };
}

function findRow(aoa, predicate, startAt = 0) {
  for (let r = startAt; r < aoa.length; r++) {
    if (predicate(aoa[r] || [], r)) return r;
  }
  return -1;
}

function colIndexInRow(row, predicate) {
  for (let c = 0; c < row.length; c++) {
    if (predicate(low(row[c]), c)) return c;
  }
  return -1;
}

/**
 * @param {ArrayBuffer|Uint8Array} data  raw .xlsx bytes
 * @returns parsed structure consumed by validateBva()
 */
export function parseBvaWorkbook(data) {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });

  const parseWarnings = [];
  const pushWarn = (code, section, message) => parseWarnings.push({ code, section, message });

  // ---- Meta ---------------------------------------------------------------
  const titleText = norm(aoa[0] && aoa[0][0]);
  let suggestedMonth = null;
  let suggestedYear = null;
  const tm = low(titleText).match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
  if (tm) {
    suggestedMonth = MONTHS.indexOf(tm[1]) + 1;
    suggestedYear = Number(tm[2]);
  }

  // Cutoff date: the value directly under "Current Bank Balances".
  let cutoffDate = null;
  const bankHdr = findRow(aoa, (row) => low(row[0]).includes('current bank balances'));
  if (bankHdr >= 0) {
    for (let r = bankHdr + 1; r <= bankHdr + 3 && r < aoa.length; r++) {
      const iso = toISODate((aoa[r] || [])[0]);
      if (iso) {
        cutoffDate = iso;
        break;
      }
    }
  }
  if (!cutoffDate) pushWarn('cutoff_date_missing', 'meta', 'Could not read a reporting cutoff date from the workbook; confirm it manually.');

  // ---- CASH -------------------------------------------------------------
  const cashAccounts = [];
  let cashReportedTotal = null;
  const cashStart = bankHdr >= 0 ? bankHdr + 1 : findRow(aoa, (row) => low(row[0]) === 'cash');
  if (cashStart >= 0) {
    for (let r = cashStart; r < aoa.length; r++) {
      const label = norm((aoa[r] || [])[0]);
      const val = toNum((aoa[r] || [])[1]);
      if (/^total\s*cash/i.test(label)) {
        cashReportedTotal = val;
        break;
      }
      if (!label || toISODate(label) || val == null) continue;
      cashAccounts.push({ name: label, balance: val });
    }
  }
  if (!cashAccounts.length) pushWarn('cash_block_empty', 'cash', 'No cash accounts were parsed.');

  // ---- Distributions --------------------------------------------------
  const distEntities = [];
  let distReportedTotal = null;
  let distReportedQuarterTotals = null;
  const distHdr = findRow(aoa, (row) => row.some((c) => low(c) === 'entity'));
  if (distHdr >= 0) {
    const hrow = aoa[distHdr];
    const cEntity = colIndexInRow(hrow, (v) => v === 'entity');
    const cYtd = colIndexInRow(hrow, (v) => v.includes('ytd'));
    // Quarter columns are the numeric-headed columns between entity and YTD.
    const qCols = [];
    for (let c = cEntity + 1; c < (cYtd === -1 ? hrow.length : cYtd); c++) {
      if (low(hrow[c])) qCols.push(c);
    }
    for (let r = distHdr + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const name = norm(row[cEntity]);
      if (!name) continue;
      if (/^total$/i.test(name)) {
        distReportedTotal = cYtd >= 0 ? toNum(row[cYtd]) : null;
        // The Total row's own per-quarter column cells, captured separately
        // from the entity rows so a per-quarter reconciliation can pinpoint
        // exactly which quarter (and, within it, which entity) a workbook
        // formula error affects — rather than only knowing the grand total
        // disagrees. This workbook has previously had a manually-typed
        // column range that silently skipped one entity's row.
        const qt = qCols.slice(0, 4).map((c) => toNum(row[c]));
        if (qt.some((v) => v != null)) {
          distReportedQuarterTotals = { q1: qt[0], q2: qt[1], q3: qt[2], q4: qt[3] };
        }
        break;
      }
      const q = [0, 0, 0, 0];
      qCols.slice(0, 4).forEach((c, i) => {
        q[i] = toNum(row[c]) || 0;
      });
      distEntities.push({
        name,
        q1: q[0],
        q2: q[1],
        q3: q[2],
        q4: q[3],
        reportedYtd: cYtd >= 0 ? toNum(row[cYtd]) : null,
      });
    }
  }

  // ---- INCOME --------------------------------------------------------
  const incomeCats = [];
  let incomeReportedActual = null;
  let incomeReportedBudget = null;
  let pacePctProxy = null;
  const incomeHdr = findRow(aoa, (row) => low(row[0]) === 'income');
  if (incomeHdr >= 0) {
    const hRow = aoa[incomeHdr];
    const cBudget = colIndexInRow(hRow, (v) => v === 'budget');
    // "Category" sub-header row establishes month / ytd columns.
    let cMonth = 1;
    let cYtd = 2;
    const catHdr = findRow(aoa, (row) => low(row[0]) === 'category', incomeHdr);
    if (catHdr >= 0 && catHdr <= incomeHdr + 2) {
      const cr = aoa[catHdr];
      const m = colIndexInRow(cr, (v) => v.includes('current month'));
      const y = colIndexInRow(cr, (v) => v.includes('actual ytd') || v === 'ytd');
      if (m >= 0) cMonth = m;
      if (y >= 0) cYtd = y;
    }
    const startRow = catHdr >= 0 ? catHdr + 1 : incomeHdr + 1;
    for (let r = startRow; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const label = norm(row[0]);
      if (!label) continue;
      if (/^total\s*income/i.test(label)) {
        incomeReportedActual = toNum(row[cYtd]);
        incomeReportedBudget = cBudget >= 0 ? toNum(row[cBudget]) : null;
        break;
      }
      const { code, name } = splitCode(label);
      const annualBudget = cBudget >= 0 ? toNum(row[cBudget]) : null;
      const actualYtd = toNum(row[cYtd]);
      const cat = {
        code,
        name,
        // Blank "Current Month" cells stay null — the workbook's month column
        // is frequently empty and a blank must not be read as a confirmed $0.
        monthActual: toNum(row[cMonth]),
        actualYtd: actualYtd || 0,
        annualBudget: annualBudget || 0,
      };
      incomeCats.push(cat);
      // Pace proxy = the recurring "monthly" income line's percent received.
      if (/monthly/i.test(name) && cat.annualBudget) {
        pacePctProxy = cat.actualYtd / cat.annualBudget;
      }
    }
  }

  // ---- EXPENSE summary ---------------------------------------------
  const groups = [];
  let expReportedActual = null;
  let expReportedBudget = null;
  let expReportedVarianceAmount = null;
  let expReportedVariancePct = null;
  const expHdr = findRow(aoa, (row) => low(row[0]) === 'expense');
  if (expHdr >= 0) {
    const hRow = aoa[expHdr];
    const cBudget = colIndexInRow(hRow, (v) => v === 'budget');
    let cMonth = 1;
    let cYtd = 2;
    const subHdr = findRow(aoa, (row) => low(row[1]).includes('current month') || low(row[2]).includes('actual ytd'), expHdr);
    if (subHdr >= 0 && subHdr <= expHdr + 2) {
      const sr = aoa[subHdr];
      const m = colIndexInRow(sr, (v) => v.includes('current month'));
      const y = colIndexInRow(sr, (v) => v.includes('actual ytd') || v === 'ytd');
      if (m >= 0) cMonth = m;
      if (y >= 0) cYtd = y;
    }
    const groupKey = (name) => {
      const l = name.toLowerCase();
      if (l.includes('fixed')) return 'fixed';
      if (l.includes('variable')) return 'variable';
      if (l.includes('discretionary')) return 'discretionary';
      return null;
    };
    for (let r = expHdr + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const label = norm(row[0]);
      if (!label) continue;
      if (/^total\s*expense/i.test(label)) {
        expReportedActual = toNum(row[cYtd]);
        expReportedBudget = cBudget >= 0 ? toNum(row[cBudget]) : null;
        continue;
      }
      if (/^over\s*\/?\s*under\s*budget/i.test(label)) {
        expReportedVariancePct = toNum(row[1]);
        expReportedVarianceAmount = toNum(row[2]);
        break;
      }
      const { name } = splitCode(label);
      const key = groupKey(name);
      if (!key) continue;
      groups.push({
        key,
        name: name.replace(/\s+/g, ' ').trim(),
        // Blank "Current Month" cells stay null (see the income block above).
        monthActual: toNum(row[cMonth]),
        actualYtd: toNum(row[cYtd]) || 0,
        annualBudget: cBudget >= 0 ? toNum(row[cBudget]) || 0 : 0,
      });
    }
  }

  // ---- DETAIL (monitored categories) ------------------------------
  // Only columns A (code + name), C (Actual YTD), D (Budget) are trusted.
  const detailCats = [];
  const detailHdr = findRow(aoa, (row) => low(row[0]) === 'detail');
  if (detailHdr >= 0) {
    let cYtd = 2;
    let cBudget = 3;
    const dSub = aoa[detailHdr + 1] || [];
    const y = colIndexInRow(dSub, (v) => v.includes('actual ytd') || v === 'ytd');
    const b = colIndexInRow(dSub, (v) => v === 'budget');
    if (y >= 0) cYtd = y;
    if (b >= 0) cBudget = b;
    for (let r = detailHdr + 2; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const label = norm(row[0]);
      if (/monthly transfers|monthly transfer\/debit/i.test(label)) break;
      if (!label || toNum(label) != null) continue; // skip blank / orphan (amount-only) rows
      const { code, name } = splitCode(label);
      const actualYtd = toNum(row[cYtd]);
      const annualBudget = toNum(row[cBudget]);
      if (actualYtd == null && annualBudget == null) continue;
      detailCats.push({
        code,
        name,
        group: 'unassigned',
        groupConfirmed: false,
        // Blank "Current Month" cells stay null (see the income block above).
        monthActual: toNum(row[1]),
        actualYtd: actualYtd || 0,
        annualBudget: annualBudget || 0,
      });
    }
  }

  // ---- Monthly Transfers / Debits -------------------------------
  // Amount is column A (numeric); the label columns B/C/D are historically
  // misaligned, so they are captured raw and flagged for Admin confirmation.
  const transferItems = [];
  const trHdr = findRow(aoa, (row) => /monthly transfers|monthly transfer\/debit/i.test(low(row[0])));
  if (trHdr >= 0) {
    let misaligned = false;
    for (let r = trHdr + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const amount = toNum(row[0]);
      if (amount == null) {
        if (norm(row[0])) continue;
        // stop at a fully blank row after we've started collecting
        if (transferItems.length) break;
        continue;
      }
      const rawB = norm(row[1]);
      const rawC = norm(row[2]);
      const rawD = norm(row[3]);
      if (rawD && !rawC) misaligned = true;
      transferItems.push({
        amount,
        purpose: rawC || rawB || null,
        source: rawB || null,
        destination: rawD || null,
        rawLabels: [rawB, rawC, rawD].filter(Boolean),
        labelsNeedReview: true,
      });
    }
    if (misaligned || transferItems.some((t) => t.labelsNeedReview)) {
      pushWarn(
        'transfer_labels_misaligned',
        'transfers',
        'Recurring transfer amounts parsed cleanly, but the source / purpose / destination label columns are misaligned in the workbook. Confirm each transfer in Admin.'
      );
    }
  }

  // Did the workbook actually carry any "Current Month" figures for a block,
  // or was that whole column blank? A blank column means the month figure is
  // unknown for this period (shown as "Source value missing"), which is a
  // different thing from an imported value that is genuinely $0.
  const incomeHasMonthColumn = incomeCats.some((c) => c.monthActual != null);
  const expenseHasMonthColumn = groups.some((g) => g.monthActual != null);
  const detailHasMonthColumn = detailCats.some((d) => d.monthActual != null);

  return {
    meta: {
      sheetName,
      titleText,
      cutoffDate,
      suggestedMonth,
      suggestedYear,
    },
    cash: { accounts: cashAccounts, reportedTotal: cashReportedTotal },
    distributions: { entities: distEntities, reportedTotal: distReportedTotal, reportedQuarterTotals: distReportedQuarterTotals },
    income: {
      categories: incomeCats,
      reportedActualTotal: incomeReportedActual,
      reportedBudgetTotal: incomeReportedBudget,
      hasMonthColumn: incomeHasMonthColumn,
    },
    expenseSummary: {
      groups,
      reportedActualTotal: expReportedActual,
      reportedBudgetTotal: expReportedBudget,
      reportedVarianceAmount: expReportedVarianceAmount,
      reportedVariancePct: expReportedVariancePct,
      pacePctProxy,
      hasMonthColumn: expenseHasMonthColumn,
    },
    detail: { categories: detailCats, hasMonthColumn: detailHasMonthColumn },
    transfers: { items: transferItems, reportedTotal: null },
    parseWarnings,
  };
}
