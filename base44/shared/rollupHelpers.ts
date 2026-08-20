// Shared helpers for the live (QuickBooks) layer.
// The live layer sums transactions directly by their linked QBO account_id.
// Excel (BudgetLine) is the report of record; QBO Account + Transaction are a
// standalone live layer paired to it by normalized account NAME (not account
// code — the Excel codes and QBO codes are different schemes that collide).

export function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

// Normalize a name for matching: lowercase, alphanumerics only.
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
//   byName — QBO accounts (source=quickbooks) grouped by normalized account_name
export function buildIndexes(accounts) {
  const byId = indexById(accounts);
  const byName = {};
  for (const a of accounts) {
    if (a.source !== 'quickbooks') continue;
    const k = norm(a.account_name);
    if (!k) continue;
    (byName[k] = byName[k] || []).push(a);
  }
  return { byId, byName };
}

// Resolve the QBO accounts a BudgetLine rolls up: its category name plus any
// extra names in qb_account_names, matched by normalized account_name.
// Returns a de-duplicated list (by id).
export function accountsForNames(category, extraNames, byName) {
  const keys = [norm(category), ...(Array.isArray(extraNames) ? extraNames : []).map(norm)].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    const group = byName[k];
    if (!group) continue;
    for (const a of group) {
      if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
    }
  }
  return out;
}