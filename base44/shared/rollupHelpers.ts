// Shared helpers for the live (QuickBooks) layer.
// The live layer sums transactions directly by their linked QBO account_id —
// no import-hierarchy roll-up is involved. Excel (BudgetLine) is the report
// of record; QBO Account + Transaction are a standalone live layer paired to
// it by BudgetLine.qb_code == QBO Account.account_code at display time.

export function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

// Normalize a name for matching (lowercase, alphanumerics only).
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Sum transactions per linked QBO account_id. Only transactions whose
// account_id points to a tracked QBO account are counted — import/legacy
// transactions with no account_id belong to the Excel snapshot, not the
// live layer, and are ignored here.
export function rollUpByAccount(txns, qboIdSet) {
  const totals = {};
  for (const t of txns) {
    const id = t.account_id;
    if (!id || !qboIdSet.has(id)) continue;
    if (!totals[id]) totals[id] = { actual: 0, count: 0 };
    totals[id].actual += Number(t.amount || 0);
    totals[id].count += 1;
  }
  return totals;
}

// Build lookup indexes from a flat account list.
//   byId   — every account by id
//   byCode — QBO accounts (source=quickbooks) grouped by account_code
export function buildIndexes(accounts) {
  const byId = indexById(accounts);
  const byCode = {};
  for (const a of accounts) {
    if (a.source !== 'quickbooks') continue;
    if (!a.account_code) continue;
    (byCode[a.account_code] = byCode[a.account_code] || []).push(a);
  }
  return { byId, byCode };
}