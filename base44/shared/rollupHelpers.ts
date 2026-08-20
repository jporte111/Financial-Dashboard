// Shared roll-up helpers used by liveRollup and categoryTransactions.
// Plain module — no Deno.serve / default export.

export function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

// Walk the budget_parent_id chain up to an account that carries its own budget.
export function resolveBudgetAccount(account, byId, seen = new Set()) {
  if (!account || seen.has(account.id)) return null;
  if (account.has_own_budget) return account;
  if (!account.budget_parent_id) return null;
  seen.add(account.id);
  return resolveBudgetAccount(byId[account.budget_parent_id], byId, seen);
}

// Normalize a name for matching Excel categories to QBO accounts:
// lowercase, strip everything but alphanumerics ("Beauty / Fitness" -> "beautyfitness").
export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resolve a transaction to the account whose budget it should count toward:
// walk up the budget_parent_id chain to a budget account; if none, use the
// transaction's own account so unconfigured accounts still surface their spend.
export function lineAccountFor(t, byId, byCode, byNormName) {
  let acc = t.account_id ? byId[t.account_id] : null;

  // Fallback for legacy/imported transactions that have no account_id: parse
  // the account code (or name) out of the colon-delimited full_account_path.
  if (!acc) {
    const path = t.full_account_path || '';
    const leaf = path.split(':').pop().trim();
    if (leaf) {
      const m = leaf.match(/^(\d+)/);
      if (m && byCode[m[1]]) acc = byCode[m[1]];
      else {
        const namePart = leaf.replace(/^\d+\s*[-:]?\s*/, '').trim();
        const cand = namePart ? byNormName[norm(namePart)] : null;
        if (cand) acc = cand;
      }
    }
    if (!acc && t.category) {
      const cand = byNormName[norm(t.category)];
      if (cand) acc = cand;
    }
  }
  if (!acc) return null;
  return resolveBudgetAccount(acc, byId) || acc;
}

export function rollUp(txns, byId, byCode, byNormName) {
  const totals = {};
  for (const t of txns) {
    const acc = lineAccountFor(t, byId, byCode, byNormName);
    if (!acc) continue;
    if (!totals[acc.id]) totals[acc.id] = { actual: 0, count: 0 };
    totals[acc.id].actual += Number(t.amount || 0);
    totals[acc.id].count += 1;
  }
  return totals;
}

// Build the lookup indexes used by the roll-up, from a flat account list.
export function buildIndexes(accounts) {
  const byId = indexById(accounts);
  const byCode = {};
  for (const a of accounts) {
    if (a.account_code && !byCode[a.account_code]) byCode[a.account_code] = a;
  }
  const byNormName = {};
  for (const a of accounts) {
    if (!a.has_own_budget) continue;
    byNormName[norm(a.account_name)] = a;
  }
  for (const a of accounts) {
    const key = norm(a.account_name);
    if (!byNormName[key]) byNormName[key] = a;
  }
  return { byId, byCode, byNormName };
}