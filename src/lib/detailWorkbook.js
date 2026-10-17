import * as XLSX from 'xlsx';

// Phase 5b: read a QuickBooks "Transaction Report" Excel export into the sheet
// model base44/shared/detailReport.ts checks:
//   { rows: [{ r, A..J }], formulas: { [row]: [rows a column-I total adds up] } }
// Cell values are taken as stored; a column-I formula's references are kept so
// every subtotal can be recomputed (never trusted as a stored number alone).
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

// "I7+I8+I9", "SUM(I7:I9)", "I290+I1338" -> [7, 8, 9] / [7, 8, 9] / [290, 1338]
export function formulaRows(f) {
  const out = [];
  const src = String(f || '').replace(/\$/g, '');
  for (const m of src.matchAll(/I(\d+)(?::I(\d+))?/gi)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let r = Math.min(a, b); r <= Math.max(a, b); r++) out.push(r);
  }
  return out;
}

export function sheetModel(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const rows = [];
  const formulas = {};
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = { r: r + 1 };
    let any = false;
    COLS.forEach((c, i) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: i })];
      const v = cell ? cell.v : null;
      row[c] = v === undefined ? null : v;
      if (v !== null && v !== undefined && v !== '') any = true;
      if (c === 'I' && cell && cell.f) formulas[r + 1] = formulaRows(cell.f);
    });
    if (any) rows.push(row);
  }
  return { rows, formulas };
}

export async function parseDetailWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellFormula: true, cellDates: false, raw: false });
  if (wb.SheetNames.length !== 1) throw new Error(`Expected one sheet (the Transaction Report); found ${wb.SheetNames.length}.`);
  return sheetModel(wb.Sheets[wb.SheetNames[0]]);
}
