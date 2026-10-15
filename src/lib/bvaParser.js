// Parser for the monthly BVA ("Budget vs Actual") Excel workbook.
//
// The workbook's layout drifts from month to month: a single flat sheet with
// labelled blocks, a simplified sheet with no section headers, or the same
// blocks split across several sheets (e.g. a second "Detail & Notes" sheet).
// So nothing is read by fixed position:
//
//   - every sheet is scanned, and each block is located by its label;
//   - columns are located by their header labels;
//   - the header-less fallbacks (bare FIXED / VARIABLE / DISCRETIONARY rows,
//     code-prefixed detail rows, label-first transfer rows) run only when the
//     workbook has no labelled block of that kind anywhere;
//   - every numeric cell a section reads is recorded. Numbers that no section
//     accounts for are reported (never silently dropped), as are additional
//     sheets and duplicate sections. Duplicate sections that disagree are
//     never combined or chosen between: the section is left empty and the
//     conflict blocks finalization.
//
// Missing vs zero: a blank cell is `null`, never 0. A cell holding 0 stays 0.
//
// Only primary figures are read (Current Month, Actual YTD, Annual Budget,
// balances, quarters, amounts). Derived columns (Remaining, % of Budget,
// pace, variance) are recomputed by src/lib/bvaValidation.js, because the
// workbook's formula cells have historically been shifted or wrong.

import * as XLSX from 'xlsx';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function toNum(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const neg = /^\s*\(.*\)\s*$/.test(String(v)) || /^\s*-/.test(String(v));
  const s = String(v).replace(/[$,\s]/g, '').replace(/[()]/g, '').replace(/^-/, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const x = Number(s);
  if (!Number.isFinite(x)) return null;
  return neg ? -x : x;
}

const norm = (v) => String(v == null ? '' : v).trim();
// Lower-case, typographic dashes / quotes normalized, whitespace collapsed.
const canon = (v) =>
  norm(v).toLowerCase().replace(/[‘’`]/g, "'").replace(/[—–−]/g, '-').replace(/\s+/g, ' ');
const isNumericCell = (v) => !(v instanceof Date) && toNum(v) != null;
const isTextCell = (v) => typeof v === 'string' && norm(v) !== '' && toNum(v) == null;

const pad = (x) => String(x).padStart(2, '0');

function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  // Excel serial date number
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  }
  // Only clearly date-shaped strings -- never a generic `new Date()` fallback,
  // which would misread account names like "Acme Bank - 1234".
  const s = norm(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  // "Sept 30 2026" / "September 30, 2026" — month-name headers, including the
  // abbreviated "Sept" the workbook uses. Matched by the month's first three
  // letters, so a day and year are still required (never a generic fallback
  // that could misread an account name).
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) {
    const prefix = m[1].toLowerCase().slice(0, 3); // 'sept' -> 'sep'
    const mon = MONTHS.findIndex((mo) => mo.startsWith(prefix));
    if (mon >= 0) return `${m[3]}-${pad(mon + 1)}-${pad(m[2])}`;
  }
  return null;
}

// "4030 - Interest Income" -> { code: '4030', name: 'Interest Income' }.
// Only a 3-6 digit prefix is an account code; "1. FIXED" keeps its full label.
function splitCode(label) {
  const s = norm(label);
  const m = s.match(/^(\d{3,6})\s*[.\-–:]?\s*(.*)$/);
  if (m) return { code: m[1], name: norm(m[2]) || s };
  return { code: null, name: s };
}

const groupKey = (label) => {
  const l = canon(label);
  if (/\bfixed\b/.test(l)) return 'fixed';
  if (/\bvariable\b/.test(l)) return 'variable';
  if (/\bdiscretionary\b/.test(l)) return 'discretionary';
  return null;
};
// "1. FIXED COSTS" -> "FIXED COSTS"
const groupName = (label) => norm(label).replace(/^\d+\s*[.)]\s*/, '').replace(/\s+/g, ' ');

// ---- Anchors -----------------------------------------------------------
// Column-A labels that start a block. Order matters: "cash accounts outside
// total cash" must not be read as the cash block.
/** @type {Array<[string, (a: string, row?: any[]) => boolean]>} */
const ANCHORS = [
  ['cash_outside', (a) => /outside '?total cash'?/.test(a)],
  ['cash', (a) => /^cash\b/.test(a)],
  ['income', (a) => a === 'income'],
  ['expenseSummary', (a) => /^expenses?$/.test(a)],
  ['detail', (a) => /^detail\b/.test(a) || /^watch ?list\b/.test(a)],
  ['transfers', (a) => /monthly transfers?\b|recurring debits?\b|monthly transfer\/debit/.test(a)],
  ['over_under', (a, row) => /^over ?\/? ?under budget/.test(a) && !row.slice(1).some(isNumericCell)],
  ['notes', (a) => /^(report )?notes$/.test(a)],
];
// Blocks that are recognized but deliberately not imported.
const INFORMATIONAL = new Set(['cash_outside', 'over_under', 'notes']);

function anchorOf(row, prevAnchors) {
  const a = canon(row[0]);
  if (!a) return null;
  // "Current Bank Balances" on its own starts the cash block only when a
  // "CASH" label does not already sit just above it.
  if (/^current bank balances/.test(a)) return prevAnchors.some((p) => p === 'cash') ? null : 'cash';
  for (const [type, test] of ANCHORS) if (test(a, row)) return type;
  return null;
}

// Header cell -> column role.
function headerRole(cell) {
  const h = canon(cell);
  if (!h) return null;
  if (/^(current month|month actual|month|current month amount)$/.test(h)) return h === 'current month amount' ? 'amount' : 'month';
  if (/^(actual ytd|ytd actual|ytd)$/.test(h)) return 'ytd';
  if (/^(annual budget|budget)$/.test(h)) return 'budget';
  if (h === 'code') return 'code';
  if (h === 'category' || h === 'item') return 'name';
  if (/^(qbo account|account|source)$/.test(h)) return 'account';
  if (h === 'amount') return 'amount';
  if (/^over ?\/? ?under/.test(h)) return 'overUnder';
  return null;
}
const isHeaderRow = (row) => row.some((c) => headerRole(c) && ['month', 'ytd', 'budget', 'code', 'amount'].includes(headerRole(c)));

/**
 * @param {ArrayBuffer|Uint8Array} data  raw .xlsx bytes
 * @returns parsed structure consumed by validateBva()
 */
export function parseBvaWorkbook(data) {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheets = wb.SheetNames.map((name, index) => {
    const ws = wb.Sheets[name];
    let aoa = [];
    if (ws && ws['!ref']) {
      // Read from row 1 so reported row numbers match the sheet.
      const range = XLSX.utils.decode_range(ws['!ref']);
      range.s.r = 0;
      aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true, range });
      // Leading columns that are empty on every row are dropped, so a sheet
      // laid out from column B reads with its labels in the first column.
      const lead = Math.min(...aoa.map((row) => {
        const i = (row || []).findIndex((v) => norm(v) !== '');
        return i === -1 ? Infinity : i;
      }));
      if (Number.isFinite(lead) && lead > 0) aoa = aoa.map((row) => (row || []).slice(lead));
    }
    return { index, name, aoa };
  });

  const warnings = [];
  const pushWarn = (code, section, message, opts = {}) =>
    warnings.push({ code, section, message, requiresAdminReview: true, blocksFinalize: false, overridable: true, ...opts });

  // Every numeric cell a section reads (or deliberately recognizes) is claimed.
  const claims = sheets.map(() => new Map());
  const claim = (s, r, c0, c1) => {
    const m = claims[s];
    if (!m.has(r)) m.set(r, []);
    m.get(r).push([c0, c1]);
  };
  const claimRow = (s, r) => claim(s, r, 0, Infinity);
  const claimed = (s, r) => claims[s].has(r);
  const cell = (s, r, c) => ((sheets[s].aoa[r] || [])[c]);
  const src = (s, r) => ({ sheet: s, row: r + 1 });

  // ---- Locate anchors on every sheet -------------------------------------
  const anchors = []; // { type, sheet, row }
  for (const sh of sheets) {
    const prev = [];
    sh.aoa.forEach((row, r) => {
      const t = anchorOf(row || [], prev.slice(-2));
      prev.push(t);
      if (t) anchors.push({ type: t, sheet: sh.index, row: r });
    });
  }
  // A block ends at the next anchor on the same sheet.
  const blockEnd = (s, r) => {
    const next = anchors.find((a) => a.sheet === s && a.row > r);
    return next ? next.row : sheets[s].aoa.length;
  };
  const findRowIn = (s, from, to, pred) => {
    for (let r = from; r < to; r++) if (pred(sheets[s].aoa[r] || [], r)) return r;
    return -1;
  };

  // ---- Meta: title and cutoff date ---------------------------------------
  const titleText = norm(cell(0, 0, 0));
  let titleMonth = null;
  let titleYear = null;
  const tm = canon(titleText).match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
  if (tm) {
    titleMonth = MONTHS.indexOf(tm[1]) + 1;
    titleYear = Number(tm[2]);
  }
  const cutoffSources = [];
  const addCutoff = (date, source, s, r) => date && cutoffSources.push({ date, source, ...src(s, r) });
  for (const sh of sheets) {
    for (let r = 0; r < Math.min(3, sh.aoa.length); r++) {
      const t = canon((sh.aoa[r] || [])[0]);
      let m = t.match(/reporting cutoff date[:\s]*([\d/-]+)/);
      if (m) addCutoff(toISODate(m[1]), 'meta: reporting cutoff date', sh.index, r);
      m = t.match(/data through (january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2}),? (\d{4})/);
      if (m) addCutoff(`${m[3]}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(m[2])}`, 'meta: data through', sh.index, r);
    }
  }

  // ---- Section parsers ---------------------------------------------------
  // Each returns { status, data, sheet, row, layout } where status is
  // 'parsed' | 'empty' | 'unparsed'.

  function parseCash(s, r0) {
    const end = blockEnd(s, r0);
    claim(s, r0, 0, 2);
    const accounts = [];
    let reportedTotal = null;
    let totalFound = false;
    let balanceCol = 1; // set to the dated column when the block has a header row
    for (let r = r0 + 1; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[0]);
      const c = canon(row[0]);
      const date = toISODate(row[0]);
      if (date) {
        addCutoff(date, 'cash block date', s, r);
        claim(s, r, 0, 2);
        continue;
      }
      if (/^current bank balances/.test(c)) {
        addCutoff(toISODate(row[1]), 'cash header date', s, r);
        claim(s, r, 0, 2);
        continue;
      }
      // A cash header row: no balances on it, and its columns are labels —
      // e.g. "Bank | Last Month | Sept 30 2026" or "Account | 08/31/2026".
      // The balances for this report live under the DATE column, never under
      // "Last Month", and a date header is itself a cutoff-date source.
      if (!row.some(isNumericCell)) {
        const dateCols = [];
        let headerish = /^(bank|account)$/.test(c);
        for (let i = 1; i <= 4; i++) {
          const h = row[i];
          if (h == null || norm(h) === '') continue;
          // The header cell may be a real Excel date (read as a Date object
          // under cellDates) or text like "Sept 30 2026" — both accepted.
          const d = toISODate(h);
          if (d) dateCols.push([i, d]);
          if (/^(last month|current)$/.test(canon(h))) headerish = true;
        }
        if (headerish || dateCols.length) {
          if (dateCols.length) {
            const [dc, d] = dateCols[dateCols.length - 1]; // the latest date column is this report's "as of"
            balanceCol = dc;
            addCutoff(d, 'cash header date', s, r);
          }
          claim(s, r, 0, 2);
          continue;
        }
      }
      if (/^total\s*cash/.test(c)) {
        reportedTotal = toNum(row[balanceCol]);
        totalFound = true;
        claim(s, r, 0, 2);
        break;
      }
      if (!label) continue; // blank row, or unlabeled figures (left unclaimed -> reported)
      accounts.push({ name: label, balance: toNum(row[balanceCol]), src: src(s, r) });
      claim(s, r, 0, 2);
    }
    if (!totalFound) pushWarn('cash_total_row_missing', 'cash', 'The cash block has no "Total Cash" row; the calculated total is used.');
    return { status: accounts.length ? 'parsed' : 'empty', data: { accounts, reportedTotal } };
  }

  function parseDistributions(s, r0, cE) {
    const hrow = sheets[s].aoa[r0] || [];
    let cYtd = -1;
    for (let c = cE + 1; c < hrow.length; c++) if (canon(hrow[c]).includes('ytd')) { cYtd = c; break; }
    const qCols = [];
    for (let c = cE + 1; c < (cYtd === -1 ? hrow.length : cYtd); c++) if (canon(hrow[c])) qCols.push(c);
    if (cYtd === -1 || qCols.length === 0) return { status: 'unparsed', data: { entities: [], reportedTotal: null, reportedQuarterTotals: null } };
    const cEnd = cYtd;
    claim(s, r0, cE, cEnd);
    const entities = [];
    let reportedTotal = null;
    let reportedQuarterTotals = null;
    const q4 = (row) => [0, 1, 2, 3].map((i) => (qCols[i] == null ? null : toNum(row[qCols[i]])));
    // The block sits beside the cash block, so it ends at its own "Total" row
    // or at the next column-A section label.
    const end = blockEnd(s, r0);
    for (let r = r0 + 1; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const name = norm(row[cE]);
      if (!name) continue; // blank, or unlabeled figures (left unclaimed -> reported)
      claim(s, r, cE, cEnd);
      const q = q4(row);
      if (/^total$/i.test(name)) {
        reportedTotal = toNum(row[cYtd]);
        // The Total row's own per-quarter cells, kept so a disagreement can be
        // traced to one quarter (and one entity) -- the workbook has had a
        // manually typed column range that skipped an entity's row.
        if (q.some((v) => v != null)) reportedQuarterTotals = { q1: q[0], q2: q[1], q3: q[2], q4: q[3] };
        break;
      }
      entities.push({ name, q1: q[0], q2: q[1], q3: q[2], q4: q[3], reportedYtd: toNum(row[cYtd]), src: src(s, r) });
    }
    return { status: entities.length ? 'parsed' : 'empty', data: { entities, reportedTotal, reportedQuarterTotals } };
  }

  // Column map from the anchor row plus up to two header rows beneath it.
  function headerMap(s, r0) {
    const map = {};
    let last = r0;
    let span = 0;
    for (let r = r0; r <= r0 + 2 && r < sheets[s].aoa.length; r++) {
      const row = sheets[s].aoa[r] || [];
      if (r > r0 && !isHeaderRow(row)) break;
      row.forEach((c, i) => {
        const role = headerRole(c);
        if (role && map[role] == null) map[role] = i;
        if (norm(c)) span = Math.max(span, i);
      });
      last = r;
      claim(s, r, 0, Infinity);
    }
    if (map.name == null) map.name = 0;
    return { map, headerEnd: last, span };
  }

  function lineValues(row, map) {
    return {
      monthActual: map.month == null ? null : toNum(row[map.month]),
      actualYtd: toNum(row[map.ytd]),
      annualBudget: toNum(row[map.budget]),
    };
  }

  let incomeCols = null; // reused by the header-less layout
  let incomeLoc = null;

  function parseIncome(s, r0) {
    const { map, headerEnd, span } = headerMap(s, r0);
    if (map.ytd == null || map.budget == null) return { status: 'unparsed', data: null };
    incomeCols = map;
    const end = blockEnd(s, r0);
    const categories = [];
    let reportedActualTotal = null;
    let reportedBudgetTotal = null;
    let pacePctProxy = null;
    let totalRow = -1;
    for (let r = headerEnd + 1; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[map.name]);
      if (!label) continue;
      if (/^total\s*income/i.test(label)) {
        reportedActualTotal = toNum(row[map.ytd]);
        reportedBudgetTotal = toNum(row[map.budget]);
        claim(s, r, 0, span);
        totalRow = r;
        break;
      }
      const { code, name } = map.code != null ? { code: norm(row[map.code]) || null, name: label } : splitCode(label);
      const cat = { code, name, ...lineValues(row, map), src: src(s, r) };
      categories.push(cat);
      claim(s, r, 0, span);
      // Pace proxy = the recurring "monthly" income line's share received.
      if (/monthly/i.test(name) && cat.annualBudget && cat.actualYtd != null) pacePctProxy = cat.actualYtd / cat.annualBudget;
    }
    incomeLoc = { sheet: s, totalRow };
    if (totalRow === -1) pushWarn('income_total_row_missing', 'income', 'The income block has no "Total Income" row.');
    return {
      status: categories.length ? 'parsed' : 'empty',
      data: { categories, reportedActualTotal, reportedBudgetTotal, pacePctProxy },
    };
  }

  function groupRows(s, from, to, map, span, onOther) {
    const groups = [];
    let totalRow = -1;
    let totals = { actual: null, budget: null };
    for (let r = from; r < to; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[map.name]);
      if (!label) continue;
      if (/^total\s*expense/i.test(label)) {
        totals = { actual: toNum(row[map.ytd]), budget: toNum(row[map.budget]) };
        claim(s, r, 0, span);
        totalRow = r;
        break;
      }
      const key = groupKey(label);
      if (!key) {
        if (onOther) onOther(r);
        continue; // figures on an unrecognized row stay unclaimed -> reported
      }
      groups.push({ key, name: groupName(label), ...lineValues(row, map), src: src(s, r) });
      claim(s, r, 0, span);
    }
    return { groups, totalRow, totals };
  }

  let expenseLoc = null;

  function parseExpenseSummary(s, r0) {
    const { map, headerEnd, span } = headerMap(s, r0);
    if (map.ytd == null || map.budget == null) return { status: 'unparsed', data: null };
    // With an "Over/Under" column the workbook's shifted formula cells and
    // its side summary (label in that column, figure to its right) belong to
    // the block, so its rows are accounted for in full.
    const sideSpan = map.overUnder != null ? Infinity : span;
    const end = blockEnd(s, r0);
    const { groups, totalRow, totals } = groupRows(s, headerEnd + 1, end, map, sideSpan);
    if (map.overUnder != null && groups.some((g) => isTextCell((sheets[s].aoa[g.src.row - 1] || [])[map.overUnder]))) {
      informational.push({ type: 'over_under', ...src(s, r0), figures: null, note: 'over/under side summary beside the expense groups' });
    }
    let reportedVarianceAmount = null;
    let reportedVariancePct = null;
    if (totalRow >= 0) {
      const ou = findRowIn(s, totalRow + 1, Math.min(end, totalRow + 4), (row) => /^over ?\/? ?under budget/.test(canon(row[0])));
      if (ou >= 0) {
        const row = sheets[s].aoa[ou];
        reportedVariancePct = toNum(row[1]);
        reportedVarianceAmount = toNum(row[2]);
        claimRow(s, ou);
      }
    } else {
      pushWarn('expense_total_row_missing', 'expenses', 'The expense block has no "Total Expenses" row.');
    }
    expenseLoc = { sheet: s, totalRow };
    return {
      status: groups.length ? 'parsed' : 'empty',
      layout: 'labelled',
      data: { groups, reportedActualTotal: totals.actual, reportedBudgetTotal: totals.budget, reportedVarianceAmount, reportedVariancePct },
    };
  }

  // Header-less layout: bare FIXED / VARIABLE / DISCRETIONARY rows between
  // "Total Income" and "Total Expenses", in the income block's columns.
  function parseExpenseSummaryHeaderless() {
    if (!incomeLoc || incomeLoc.totalRow < 0 || !incomeCols) return null;
    const s = incomeLoc.sheet;
    const te = findRowIn(s, incomeLoc.totalRow + 1, blockEnd(s, incomeLoc.totalRow), (row) => /^total\s*expense/i.test(norm(row[0])));
    if (te < 0) return null;
    const span = Math.max(...Object.values(incomeCols));
    const { groups, totals } = groupRows(s, incomeLoc.totalRow + 1, te + 1, incomeCols, span);
    expenseLoc = { sheet: s, totalRow: te, headerless: true };
    return {
      status: groups.length ? 'parsed' : 'empty',
      sheet: s,
      row: incomeLoc.totalRow + 2,
      layout: 'header-less (after Total Income)',
      data: { groups, reportedActualTotal: totals.actual, reportedBudgetTotal: totals.budget, reportedVarianceAmount: null, reportedVariancePct: null },
    };
  }

  // A labelled detail row with no Month / YTD / Budget figure at all.
  const blankFigures = (row, map) => [map.month, map.ytd, map.budget].every((c) => c == null || norm(row[c]) === '');

  function detailRow(s, r, map, code, name) {
    return { code, name, group: 'unassigned', groupConfirmed: false, ...lineValues(sheets[s].aoa[r] || [], map), src: src(s, r) };
  }

  let detailEndLoc = null; // where header-less transfers may start

  function parseDetail(s, r0) {
    const hdr = findRowIn(s, r0, Math.min(r0 + 3, sheets[s].aoa.length), (row) => isHeaderRow(row));
    if (hdr < 0) return { status: 'unparsed', data: null };
    claim(s, r0, 0, Infinity);
    const { map, headerEnd, span } = headerMap(s, hdr);
    if (map.ytd == null || map.budget == null) return { status: 'unparsed', data: null };
    const rowSpan = map.overUnder != null ? Infinity : span;
    const end = blockEnd(s, r0);
    const categories = [];
    for (let r = headerEnd + 1; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[map.name]);
      const rawCode = map.code != null ? norm(row[map.code]) : '';
      if (!label && !rawCode) {
        if (row.some(isNumericCell) && categories.length) {
          // An unlabeled figures-only row directly under the detail rows: the
          // workbook's shifted-formula residue. Not imported, but shown.
          claim(s, r, 0, rowSpan);
          pushWarn('detail_orphan_row', 'detail', `Detail row ${r + 1} has figures but no category label; it was not imported. Confirm it is a spreadsheet artifact.`, { sheet: s });
        }
        continue;
      }
      if (/^total\b/i.test(label)) {
        claim(s, r, 0, rowSpan);
        break;
      }
      const { code, name } = map.code != null ? { code: rawCode || null, name: label || rawCode } : splitCode(label);
      if (blankFigures(sheets[s].aoa[r] || [], map)) {
        claim(s, r, 0, rowSpan);
        pushWarn(`detail_row_blank:${r + 1}`, 'detail', `Watch-list category "${name}" has no figures in the workbook; it was not imported.`);
        continue;
      }
      if (!code) pushWarn(`detail_code_missing:${r + 1}`, 'detail', `Detail row "${name}" has no account code, so a confirmed group cannot be carried over.`);
      categories.push(detailRow(s, r, map, code, name));
      claim(s, r, 0, rowSpan);
    }
    detailEndLoc = null;
    return { status: categories.length ? 'parsed' : 'empty', data: { categories } };
  }

  // Header-less layout: code-prefixed rows directly after "Total Expenses",
  // in the income block's columns. A row without a code is still a detail row
  // when it carries figures in those columns (and is flagged); a row with text
  // in the month column is the first transfer row.
  // Only in the simplified layout (header-less expense summary too).
  function parseDetailHeaderless() {
    if (!expenseLoc || !expenseLoc.headerless || expenseLoc.totalRow < 0 || !incomeCols) return null;
    const s = expenseLoc.sheet;
    const map = incomeCols;
    const span = Math.max(...Object.values(map));
    const end = blockEnd(s, expenseLoc.totalRow);
    const categories = [];
    let r = expenseLoc.totalRow + 1;
    for (; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[0]);
      if (!label || claimed(s, r)) continue;
      const { code, name } = splitCode(label);
      const figures = [map.month, map.ytd, map.budget].filter((c) => c != null && isNumericCell(row[c])).length;
      if (code && blankFigures(row, map)) {
        claim(s, r, 0, span);
        pushWarn(`detail_row_blank:${r + 1}`, 'detail', `Watch-list category "${name}" has no figures in the workbook; it was not imported.`);
        continue;
      }
      if (!code) {
        if (map.month != null && isTextCell(row[map.month])) break; // transfers start here
        if (figures < 2) break;
        pushWarn(`detail_code_missing:${r + 1}`, 'detail', `Detail row "${name}" has no account code, so a confirmed group cannot be carried over.`);
      }
      categories.push(detailRow(s, r, map, code, name));
      claim(s, r, 0, span);
    }
    detailEndLoc = { sheet: s, row: r };
    if (!categories.length) return null;
    return { status: 'parsed', sheet: s, row: expenseLoc.totalRow + 2, layout: 'header-less (after Total Expenses)', data: { categories } };
  }

  /**
   * @param {number} s
   * @param {number} r
   * @param {{ amount: any, source?: any, purpose?: any, destination?: any, rawLabels: any[] }} fields
   */
  function transferItem(s, r, { amount, source, purpose, destination, rawLabels }) {
    return {
      amount,
      source: source || null,
      purpose: purpose || null,
      destination: destination || null,
      rawLabels: rawLabels.filter(Boolean),
      labelsNeedReview: true,
      src: src(s, r),
    };
  }

  function parseTransfers(s, r0) {
    claim(s, r0, 0, Infinity);
    const end = blockEnd(s, r0);
    const sub = findRowIn(s, r0 + 1, Math.min(r0 + 3, end), (row) => row.some((c) => headerRole(c) === 'amount'));
    const items = [];
    let reportedTotal = null;
    let misaligned = false;
    let started = false;
    /** @type {Record<string, number> | null} */
    let map = null;
    if (sub >= 0) {
      map = {};
      (sheets[s].aoa[sub] || []).forEach((c, i) => {
        const role = headerRole(c);
        if (role && map[role] == null) map[role] = i;
      });
      claim(s, sub, 0, Infinity);
    }
    for (let r = (sub >= 0 ? sub : r0) + 1; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const nums = row.map((v, i) => (isNumericCell(v) ? i : -1)).filter((i) => i >= 0);
      const texts = row.map((v, i) => (isTextCell(v) ? i : -1)).filter((i) => i >= 0);
      if (!nums.length && !texts.length) {
        if (started) break;
        continue;
      }
      if (/^total\b/i.test(norm(row[0])) || /^total\b/i.test(norm(row[1]))) {
        reportedTotal = toNum(row[nums[nums.length - 1]]);
        claimRow(s, r);
        break;
      }
      if (map && map.amount != null) {
        // Labelled columns: Item | Account | Amount.
        const item = norm(row[map.name ?? 0]);
        if (!item && !isNumericCell(row[map.amount])) continue;
        const acct = map.account != null ? norm(row[map.account]) : '';
        items.push(transferItem(s, r, { amount: toNum(row[map.amount]), source: acct, purpose: item, rawLabels: [item, acct] }));
      } else if (isNumericCell(row[0])) {
        // Amount first, then source / purpose / destination labels (which are
        // historically misaligned in this layout).
        const rawB = norm(row[1]);
        const rawC = norm(row[2]);
        const rawD = norm(row[3]);
        if (rawD && !rawC) misaligned = true;
        items.push(transferItem(s, r, { amount: toNum(row[0]), source: rawB, purpose: rawC || rawB, destination: rawD, rawLabels: [rawB, rawC, rawD] }));
      } else if (isTextCell(row[0])) {
        // Label first; the amount is the first figure in columns B-E. Text
        // further right is a note.
        const amountCol = nums.find((i) => i >= 1 && i <= 4);
        const label = norm(row[0]);
        const purpose = [1, 2].map((i) => norm(row[i])).find((v) => v && toNum(v) == null) || null;
        items.push(transferItem(s, r, { amount: amountCol == null ? null : toNum(row[amountCol]), source: label, purpose, rawLabels: [label, purpose] }));
        if (amountCol != null) claim(s, r, amountCol, amountCol);
      } else {
        continue; // figures without a label stay unclaimed -> reported
      }
      started = true;
      claim(s, r, 0, 4);
    }
    return { status: items.length ? 'parsed' : 'empty', data: { items, reportedTotal, misaligned } };
  }

  // Header-less layout: label-first rows after the detail rows, e.g.
  // ["Acct A", "Tax Savings", "", 500]. Only runs when a "Total Expenses" row
  // anchors the region (so cash / income rows can never be taken as transfers).
  function parseTransfersHeaderless() {
    if (!expenseLoc || !expenseLoc.headerless) return null;
    const start = detailEndLoc || (expenseLoc.totalRow >= 0 ? { sheet: expenseLoc.sheet, row: expenseLoc.totalRow + 1 } : null);
    if (!start) return null;
    const s = start.sheet;
    const end = blockEnd(s, start.row - 1);
    const items = [];
    let reportedTotal = null;
    let started = false;
    for (let r = start.row; r < end; r++) {
      const row = sheets[s].aoa[r] || [];
      const label = norm(row[0]);
      const nums = row.map((v, i) => (isNumericCell(v) ? i : -1)).filter((i) => i >= 1);
      if (!label && !nums.length) {
        if (started) break;
        continue;
      }
      if (claimed(s, r) || !label || splitCode(label).code || !nums.length) continue; // left unclaimed -> reported
      if (/^total\b/i.test(label)) {
        reportedTotal = toNum(row[nums[nums.length - 1]]);
        claimRow(s, r);
        break;
      }
      const amountCol = nums[nums.length - 1];
      const rawB = norm(row[1]);
      const rawC = norm(row[2]);
      items.push(
        transferItem(s, r, {
          amount: toNum(row[amountCol]),
          source: label,
          purpose: (toNum(rawB) == null && rawB) || (toNum(rawC) == null && rawC) || null,
          destination: rawC && toNum(rawC) == null ? rawC : null,
          rawLabels: [label, rawB, rawC],
        })
      );
      claimRow(s, r);
      started = true;
    }
    if (!items.length) return null;
    return { status: 'parsed', sheet: s, row: start.row + 1, layout: 'header-less (after the detail rows)', data: { items, reportedTotal, misaligned: false } };
  }

  // ---- Run the parsers ---------------------------------------------------
  const informational = [];
  const found = { cash: [], distributions: [], income: [], expenseSummary: [], detail: [], transfers: [] };
  const run = (type, a, fn) => found[type].push({ ...fn(), sheet: a.sheet, row: a.row + 1, layout: 'labelled' });

  // Cash / income first (their locations anchor the header-less fallbacks).
  for (const a of anchors.filter((x) => x.type === 'cash')) run('cash', a, () => parseCash(a.sheet, a.row));
  for (const sh of sheets) {
    sh.aoa.forEach((row, r) => {
      const cE = (row || []).findIndex((c) => canon(c) === 'entity');
      if (cE >= 0) run('distributions', { sheet: sh.index, row: r }, () => parseDistributions(sh.index, r, cE));
    });
  }
  for (const a of anchors.filter((x) => x.type === 'income')) run('income', a, () => parseIncome(a.sheet, a.row));
  for (const a of anchors.filter((x) => x.type === 'expenseSummary')) run('expenseSummary', a, () => parseExpenseSummary(a.sheet, a.row));
  if (!found.expenseSummary.length) {
    const h = parseExpenseSummaryHeaderless();
    if (h) found.expenseSummary.push(h);
  }
  for (const a of anchors.filter((x) => x.type === 'detail')) run('detail', a, () => parseDetail(a.sheet, a.row));
  if (!found.detail.length) {
    const h = parseDetailHeaderless();
    if (h) found.detail.push(h);
  }
  for (const a of anchors.filter((x) => x.type === 'transfers')) run('transfers', a, () => parseTransfers(a.sheet, a.row));
  if (!found.transfers.length && !anchors.some((a) => a.type === 'transfers' || a.type === 'detail')) {
    const h = parseTransfersHeaderless();
    if (h) found.transfers.push(h);
  }

  // Informational blocks: recognized, claimed, reported, not imported.
  for (const a of anchors.filter((x) => INFORMATIONAL.has(x.type))) {
    const end = blockEnd(a.sheet, a.row);
    let figures = 0;
    for (let r = a.row; r < end; r++) {
      const row = sheets[a.sheet].aoa[r] || [];
      if (a.type !== 'notes') {
        figures += row.filter(isNumericCell).length;
        claimRow(a.sheet, r);
      }
    }
    informational.push({ type: a.type, ...src(a.sheet, a.row), figures });
  }

  // ---- Resolve each section: one, none, duplicates, conflicts -----------
  const sheetLabel = (s) => `sheet ${s + 1} ("${sheets[s].name}")`;
  const strip = (x) => JSON.stringify(x, (k, v) => (k === 'src' ? undefined : v));
  const sections = {};
  const pick = (type, emptyData) => {
    const cands = found[type];
    if (!cands.length) {
      sections[type] = { status: 'absent' };
      return emptyData;
    }
    const first = cands[0];
    const loc = { sheet: first.sheet, row: first.row, layout: first.layout };
    for (const c of cands.filter((x) => x.status === 'unparsed')) {
      pushWarn(`section_unparsed:${type}`, type, `The ${type} block on ${sheetLabel(c.sheet)} row ${c.row} was found, but its columns could not be identified; nothing was imported from it.`, { blocksFinalize: true, overridable: false });
    }
    const usable = cands.filter((x) => x.status !== 'unparsed');
    if (!usable.length) {
      sections[type] = { status: 'unparsed', ...loc };
      return emptyData;
    }
    if (usable.length > 1) {
      const same = usable.every((x) => strip(x.data) === strip(usable[0].data));
      const where = usable.map((x) => `${sheetLabel(x.sheet)} row ${x.row}`).join(' and ');
      if (!same) {
        pushWarn(`duplicate_section_conflict:${type}`, type, `The workbook has more than one ${type} block (${where}) and their figures differ. Nothing was imported from them; correct the workbook so it has one.`, { blocksFinalize: true, overridable: false });
        sections[type] = { status: 'conflict', ...loc, count: usable.length };
        return emptyData;
      }
      pushWarn(`duplicate_section_identical:${type}`, type, `The workbook repeats the ${type} block (${where}) with identical figures; it was imported once.`);
    }
    const chosen = usable[0];
    sections[type] = { status: chosen.status, sheet: chosen.sheet, row: chosen.row, layout: chosen.layout, count: usable.length };
    return chosen.data;
  };

  const cash = pick('cash', { accounts: [], reportedTotal: null });
  const distributions = pick('distributions', { entities: [], reportedTotal: null, reportedQuarterTotals: null });
  const income = pick('income', null) || { categories: [], reportedActualTotal: null, reportedBudgetTotal: null, pacePctProxy: null };
  const expense = pick('expenseSummary', null) || { groups: [], reportedActualTotal: null, reportedBudgetTotal: null, reportedVarianceAmount: null, reportedVariancePct: null };
  const detail = pick('detail', null) || { categories: [] };
  const transfers = pick('transfers', null) || { items: [], reportedTotal: null, misaligned: false };

  if (transfers.items.length) {
    const withDestination = transfers.items.filter((t) => t.destination).length;
    pushWarn(
      'transfer_labels_misaligned',
      'transfers',
      transfers.misaligned
        ? 'Recurring transfer amounts parsed cleanly, but the source / purpose / destination label columns are misaligned in the workbook. Confirm each transfer in Admin.'
        : withDestination
          ? `Recurring transfers parsed as amount, source, purpose and destination account (${withDestination} of ${transfers.items.length} rows carry a destination). The workbook does not label these columns; confirm each transfer in Admin.`
          : 'Recurring transfer labels vary between workbook layouts; confirm the source and purpose of each transfer in Admin.'
    );
  }

  // ---- Cutoff date -------------------------------------------------------
  const cutoffDates = [...new Set(cutoffSources.map((c) => c.date))];
  let cutoffDate = null;
  if (cutoffDates.length === 1) cutoffDate = cutoffDates[0];
  else if (cutoffDates.length > 1) {
    pushWarn('cutoff_date_conflict', 'meta', `The workbook states different cutoff dates (${cutoffDates.join(', ')}). Correct the workbook; no cutoff date was taken from it.`, { blocksFinalize: true, overridable: false });
  } else {
    pushWarn('cutoff_date_missing', 'meta', 'Could not read a reporting cutoff date from the workbook; confirm it manually.');
  }

  // ---- Everything numeric must be accounted for -------------------------
  const sheetSummary = sheets.map((sh) => {
    const unrecognizedRows = [];
    sh.aoa.forEach((row, r) => {
      const ranges = claims[sh.index].get(r) || [];
      const loose = (row || []).some((v, c) => isNumericCell(v) && !ranges.some(([a, b]) => c >= a && c <= b));
      if (loose) unrecognizedRows.push(r + 1);
    });
    const secs = Object.entries(sections).filter(([, v]) => v.sheet === sh.index).map(([k]) => k);
    const infos = informational.filter((i) => i.sheet === sh.index).map((i) => i.type);
    return { index: sh.index, name: sh.name, rows: sh.aoa.length, sections: secs, informational: infos, unrecognizedRows };
  });
  for (const sh of sheetSummary) {
    if (sh.unrecognizedRows.length) {
      pushWarn(
        `unrecognized_content:${sh.index + 1}`,
        'workbook',
        `${sheetLabel(sh.index)} has figures outside every recognized section (row${sh.unrecognizedRows.length > 1 ? 's' : ''} ${sh.unrecognizedRows.join(', ')}); they were not imported. Confirm they are not financial data the dashboard needs.`,
        { blocksFinalize: true, overridable: true }
      );
    }
  }
  if (sheets.length > 1) {
    const desc = sheetSummary
      .map((sh) => `${sheetLabel(sh.index)}: ${[...sh.sections, ...sh.informational.map((i) => `${i} (not imported)`)].join(', ') || 'no recognized sections'}`)
      .join('; ');
    pushWarn('additional_sheets', 'workbook', `The workbook has ${sheets.length} sheets. ${desc}.`);
  }

  const incomeCats = income.categories;
  const groups = expense.groups;
  const detailCats = detail.categories;
  return {
    meta: {
      sheetName: sheets[0] ? sheets[0].name : '',
      sheetNames: sheets.map((s) => s.name),
      titleText,
      titleMonth,
      titleYear,
      // The workbook title names the report month. It is only a suggestion
      // for the confirm step; validation compares it with the cutoff date.
      suggestedMonth: titleMonth,
      suggestedYear: titleYear,
      cutoffDate,
      cutoffSources,
    },
    cash: { accounts: cash.accounts, reportedTotal: cash.reportedTotal },
    distributions: {
      entities: distributions.entities,
      reportedTotal: distributions.reportedTotal,
      reportedQuarterTotals: distributions.reportedQuarterTotals,
    },
    income: {
      categories: incomeCats,
      reportedActualTotal: income.reportedActualTotal,
      reportedBudgetTotal: income.reportedBudgetTotal,
      hasMonthColumn: incomeCats.some((c) => c.monthActual != null),
    },
    expenseSummary: {
      groups,
      reportedActualTotal: expense.reportedActualTotal,
      reportedBudgetTotal: expense.reportedBudgetTotal,
      reportedVarianceAmount: expense.reportedVarianceAmount,
      reportedVariancePct: expense.reportedVariancePct,
      pacePctProxy: income.pacePctProxy ?? null,
      hasMonthColumn: groups.some((g) => g.monthActual != null),
    },
    detail: { categories: detailCats, hasMonthColumn: detailCats.some((d) => d.monthActual != null) },
    transfers: { items: transfers.items, reportedTotal: transfers.reportedTotal },
    sections: { ...sections, informational },
    workbook: { sheets: sheetSummary },
    parseWarnings: warnings,
  };
}