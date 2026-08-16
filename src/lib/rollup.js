// Budget roll-up engine for the QuickBooks account hierarchy.
// A transaction belongs to one account. An account either has its own budget
// (has_own_budget = true) or rolls up into a budget parent. A budget account's
// Actual YTD = sum of all transactions on accounts whose budget resolution
// lands on that budget account, walking up the budget_parent_id chain.

// Map of id -> account
export function indexById(accounts) {
  return Object.fromEntries(accounts.map((a) => [a.id, a]));
}

// Resolve the budget account an account rolls into (may be itself).
// Returns null if no budget account is found in the chain.
export function resolveBudgetAccount(account, byId, seen = new Set()) {
  if (!account || seen.has(account.id)) return null; // guard against cycles
  if (account.has_own_budget) return account;
  if (!account.budget_parent_id) return null;
  seen.add(account.id);
  return resolveBudgetAccount(byId[account.budget_parent_id], byId, seen);
}

// Descendants of an account in the parent_account_id tree (structural children).
export function descendantsOf(accountId, accounts) {
  const out = [];
  const stack = [accountId];
  while (stack.length) {
    const cur = stack.pop();
    const kids = accounts.filter((a) => a.parent_account_id === cur);
    for (const k of kids) {
      out.push(k);
      stack.push(k.id);
    }
  }
  return out;
}

// Sum transactions into each budget account.
// Returns { [budgetAccountId]: { actual, count } }.
// Transactions without a resolvable budget account are returned in unmatched.
export function rollUpByBudgetAccount(accounts, transactions) {
  const byId = indexById(accounts);
  const totals = {};
  for (const a of accounts) {
    if (a.has_own_budget) totals[a.id] = { actual: 0, count: 0 };
  }
  const unmatched = [];
  for (const t of transactions) {
    const acc = t.account_id ? byId[t.account_id] : null;
    if (!acc) {
      unmatched.push(t);
      continue;
    }
    const bp = resolveBudgetAccount(acc, byId);
    if (bp && totals[bp.id]) {
      totals[bp.id].actual += Number(t.amount || 0);
      totals[bp.id].count += 1;
    } else {
      unmatched.push(t);
    }
  }
  return { totals, unmatched, byId };
}

// Budget performance for a single budget account.
export function budgetPerformance(account, actual, monthsElapsed) {
  const annual = Number(account.annual_budget || 0);
  let expected;
  if (account.pace_method === 'none') expected = annual;
  else if (account.pace_method === 'custom' && account.expected_ytd_override != null)
    expected = Number(account.expected_ytd_override);
  else expected = (annual * monthsElapsed) / 12;
  const remaining = annual - actual;
  const pctUsed = annual ? (actual / annual) * 100 : 0;
  const variance = expected - actual;
  const status = variance >= 0 ? (expected > 0 && variance / expected < 0.05 ? 'near' : 'under') : 'over';
  return { annual, actual, expected, remaining, pctUsed, variance, status };
}

// Build a nested tree from the flat account list using parent_account_id.
// Roots are accounts with no parent_account_id (or whose parent is not in the list).
export function buildTree(accounts) {
  const byId = indexById(accounts);
  const childrenOf = {};
  const roots = [];
  for (const a of accounts) {
    const parent = a.parent_account_id ? byId[a.parent_account_id] : null;
    if (!parent) {
      roots.push(a);
    } else {
      (childrenOf[parent.id] = childrenOf[parent.id] || []).push(a);
    }
  }
  const sortKids = (list) => {
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.account_code || '').localeCompare(String(b.account_code || '')));
    for (const a of list) if (childrenOf[a.id]) sortKids(childrenOf[a.id]);
  };
  sortKids(roots);
  return { roots, childrenOf };
}