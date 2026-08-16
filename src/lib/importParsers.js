import * as XLSX from 'xlsx';
import { parse as parseDateFns, format } from 'date-fns';

const SKIP_LABELS = /^(Gross Profit|Net Income|Net Ordinary Income|Net Operating Income|Cost of Goods Sold|Total Cost of Goods Sold)\b/i;

function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$,\s]/g, '').replace(/[()]/g, '');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}
const isBlank = (v) => v == null || String(v).trim() === '';

function sectionFromLabel(label) {
  const l = label.toLowerCase();
  if (l.includes('saving') || l.includes('snvs') || l.includes('distribution')) return 'savings';
  if (l.startsWith('1') || l.includes('fixed')) return 'fixed';
  if (l.startsWith('2') || l.includes('variable')) return 'variable';
  if (l.startsWith('3') || l.includes('discretionary')) return 'discretionary';
  if (l.includes('income') && !l.includes('net')) return 'income';
  return null;
}

/**
 * Parse the QuickBooks Budget Overview CSV into a flat list of accounts
 * (parents + sub-accounts) with full colon-delimited paths and YTD budget.
 */
export function parseBudgetCsv(text) {
  const wb = XLSX.read(text, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const accounts = [];
  let section = 'income';
  let currentParent = null;

  for (let i = 2; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const label = String(row[0] || '').trim();
    if (!label) continue;

    if (label.startsWith('Total for')) {
      currentParent = null;
      continue;
    }
    if (SKIP_LABELS.test(label)) continue;

    // Section headers: numbered ("1. FIXED COSTS") or named (Income / Expenses).
    // These can carry $0.00 values, so detect by label pattern, not blank cells.
    if (/^\d+\.\s+/.test(label) || /^(Income|Expenses|Savings)\s*$/i.test(label)) {
      const s = sectionFromLabel(label);
      if (s) section = s;
      continue;
    }

    const total = num(row[row.length - 1]);
    let group = label.toLowerCase().includes('snvs') || label.toLowerCase().includes('saving') ? 'savings' : section;
    const parentMatch = label.match(/^(\d{4})\s*[-–]\s*(.+)$/);

    if (parentMatch) {
      const code = parentMatch[1];
      const name = parentMatch[2].trim();
      currentParent = { code, name, path: label };
      accounts.push({
        account_code: code,
        account_name: name,
        full_account_path: label,
        top_level_group: group,
        annual_budget: total,
        parent_path: null,
        is_sub: false,
      });
    } else {
      const subMatch = label.match(/^(\d{4})\s+(.+)$/);
      const code = subMatch ? subMatch[1] : null;
      const parentPath = currentParent ? currentParent.path : null;
      const path = parentPath ? `${parentPath}:${label}` : label;
      accounts.push({
        account_code: code,
        account_name: label,
        full_account_path: path,
        top_level_group: group,
        annual_budget: total,
        parent_path: parentPath,
        is_sub: !!parentPath,
      });
    }
  }
  return accounts;
}

function txType(t) {
  const l = (t || '').toLowerCase();
  if (l.includes('deposit') || l.includes('income') || l.includes('contribution')) return 'income';
  if (l.includes('distribution')) return 'distribution';
  if (l.includes('transfer')) return 'transfer';
  if (l.includes('refund')) return 'refund';
  return 'expense';
}

/**
 * Parse the QuickBooks Transaction Report XLSX into transaction rows,
 * skipping the title row, header row, and per-account section dividers.
 */
export function parseTransactionXlsx(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const txns = [];
  for (let i = 2; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const dateStr = String(row[1] || '').trim();
    if (!dateStr) continue; // section divider / blank
    let d;
    try { d = parseDateFns(dateStr, 'MM/dd/yyyy', new Date()); } catch { d = null; }
    if (!d || isNaN(d.getTime())) continue;

    const name = String(row[4] || '').trim();
    const desc = String(row[5] || '').trim();
    const acct = String(row[6] || '').trim();
    if (!acct && !name && !desc) continue;

    txns.push({
      date: format(d, 'yyyy-MM-dd'),
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      transaction_type: txType(String(row[2] || '')),
      num: String(row[3] || '').trim(),
      vendor: name,
      description: desc,
      account_path: acct,
      split_account: String(row[7] || '').trim(),
      amount: num(row[8]),
      balance: num(row[9]),
    });
  }
  return txns;
}