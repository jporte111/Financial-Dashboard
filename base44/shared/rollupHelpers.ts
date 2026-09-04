// Shared helpers for resolving a BudgetLine/category to its underlying
// Account records by normalized name, used only by the BVA Spending Detail
// transaction drill-down (categoryTransactions). There is no live QuickBooks
// layer any more — the QuickBooks connector, OAuth connection, and the
// liveRollup / quickbooksSync / quickbooksTransactionSync functions that
// used to populate and read "live" data have been removed. This module only
// reads whatever Account/Transaction records already exist locally; it never
// calls out to QuickBooks or any other external API.

export function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

// Normalize a name for matching: lowercase, alphanumerics only.
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build lookup indexes from a flat account list.
//   byId   — every account by id
//   byName — accounts (of any source) grouped by normalized account_name,
//            restricted to source='quickbooks' for backward compatibility
//            with historical account records. This performs no live lookup —
//            it only reads whatever Account rows already exist in the
//            database, which stop changing once QuickBooks is disconnected.
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

// Resolve the accounts a BudgetLine rolls up: its category name plus any
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
