// Shared account-hierarchy builder for the drill-downs. From transaction rows
// it builds a nested tree of accounts: each node carries its own transactions,
// its sub-accounts, and a signed total (e.g. Travel → Lodging, Airfare).
// A row's path comes from `tree` (client rows: cleaned display names, the top
// cost group already removed) or `full_account_path` (admin rows); a leading
// numbered top-level cost group ("3. DISCRETIONARY COSTS") is dropped so the
// tree starts at the account level. Rows with no path fall back to their
// plain account name, then "Uncategorized".

const TOP_GROUP = /^\d\.\s*(?:fixed|variable|discretionary)/i;

export const cleanSegment = (seg) =>
  String(seg || '')
    .replace(/^\d{4}\s*-?\s*/, '')
    .replace(/\(deleted\)/gi, '')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function accountSegments(t) {
  let segs = Array.isArray(t.tree) ? t.tree.map(cleanSegment) : [];
  if (!segs.length && t.full_account_path) {
    segs = String(t.full_account_path).split(':').map(cleanSegment);
    if (segs.length && TOP_GROUP.test(segs[0])) segs = segs.slice(1);
  }
  if (!segs.length && t.account) segs = [cleanSegment(t.account)];
  return segs.filter(Boolean);
}

export function buildAccountTree(rows) {
  const root = { name: '', txns: [], children: new Map() };
  for (const t of rows) {
    const segs = accountSegments(t);
    let node = root;
    for (const seg of segs.length ? segs : ['Uncategorized']) {
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, txns: [], children: new Map() });
      node = node.children.get(seg);
    }
    node.txns.push(t);
  }
  const finish = (node) => {
    node.txns.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    node.children = [...node.children.values()].map(finish).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    node.total = node.txns.reduce((s, t) => s + Number(t.amount || 0), 0) + node.children.reduce((s, c) => s + c.total, 0);
    node.count = node.txns.length + node.children.reduce((s, c) => s + c.count, 0);
    return node;
  };
  return finish(root).children;
}