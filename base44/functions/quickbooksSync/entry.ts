import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// QuickBooks is company-scoped; the company realm id comes from connectionConfig.realmId.
function qbBase(realmId) {
  return `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
}

// Strip QuickBooks' leading "- " label prefix.
function cleanName(name) {
  return String(name || '').replace(/^[\s-]+/, '').trim();
}

// QuickBooks Classification -> our account_type
function mapType(classification) {
  if (classification === 'Expense') return 'expense';
  if (classification === 'Revenue') return 'income';
  return 'other';
}

// Infer our budget group from the QuickBooks Classification + the top-most ancestor's label.
// Revenue accounts are always 'income'; expense accounts fall into fixed/variable/discretionary
// by their numbered section ancestor, defaulting to discretionary.
function groupFromChain(chain, classification) {
  const top = chain[0]?.Name?.toLowerCase() || '';
  if (top.includes('saving') || top.includes('snvs') || top.includes('distribution')) return 'savings';
  if (classification === 'Revenue') return 'income';
  if (/^1\b/.test(top) || top.includes('fixed')) return 'fixed';
  if (/^2\b/.test(top) || top.includes('variable')) return 'variable';
  if (/^3\b/.test(top) || top.includes('discretionary')) return 'discretionary';
  return 'discretionary';
}

async function pullAccounts(accessToken, realmId) {
  const url = `${qbBase(realmId)}/query?query=` + encodeURIComponent('SELECT * FROM Account MAXRESULTS 1000');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QuickBooks accounts query failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data?.QueryResponse?.Account || [];
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const { accessToken, connectionConfig } = await base44.asServiceRole.connectors.getConnection('quickbooks');
    const realmId = connectionConfig?.realmId;
    if (!realmId) return Response.json({ error: 'QuickBooks realm id missing' }, { status: 500 });

    const qbAccounts = await pullAccounts(accessToken, realmId);
    // Only sync P&L accounts (Expense / Revenue); skip Asset / Liability / Equity.
    const pAndL = qbAccounts.filter((a) => a.Classification === 'Expense' || a.Classification === 'Revenue');

    // Build id->account map and ancestor chains for hierarchy reconstruction.
    const byId = new Map(qbAccounts.map((a) => [String(a.Id), a]));
    const chainOf = (a) => {
      const chain = [];
      let cur = a;
      const seen = new Set();
      while (cur && !seen.has(String(cur.Id))) {
        seen.add(String(cur.Id));
        chain.unshift(cur);
        const pid = cur.ParentRef?.value;
        cur = pid ? byId.get(String(pid)) : null;
      }
      return chain;
    };
    const pathOf = (a) =>
      chainOf(a)
        .filter((x) => x.AcctNum)
        .map((x) => `${x.AcctNum} - ${cleanName(x.Name)}`)
        .join(':');

    // Index QuickBooks accounts by their account number for matching.
    const qbByCode = new Map();
    for (const a of pAndL) {
      if (a.AcctNum) qbByCode.set(String(a.AcctNum), a);
    }

    // Load all existing app Accounts (service role — admin operation).
    const existing = await base44.asServiceRole.entities.Account.filter({});
    const byCode = new Map(existing.filter((a) => a.account_code).map((a) => [String(a.account_code), a]));

    let matched = 0;
    const updates = [];
    for (const [code, qb] of qbByCode) {
      const app = byCode.get(code);
      if (!app) continue;
      const patch = { quickbooks_account_id: String(qb.Id), account_type: mapType(qb.Classification), active: qb.Active !== false, source: 'quickbooks' };
      // Re-classify auto-created accounts so fixes to the inference propagate; leave manually-created groups alone.
      if (app.source === 'quickbooks') patch.top_level_group = groupFromChain(chainOf(qb), qb.Classification);
      updates.push(base44.asServiceRole.entities.Account.update(app.id, patch));
      matched++;
    }
    if (updates.length) await Promise.all(updates);

    // Create QuickBooks accounts that have no matching app record (section headers without codes are skipped).
    const existingIds = new Set(existing.map((a) => a.quickbooks_account_id).filter(Boolean));
    const toCreate = [];
    for (const qb of pAndL) {
      if (!qb.AcctNum) continue;
      if (existingIds.has(String(qb.Id))) continue;
      if (byCode.has(String(qb.AcctNum))) continue;
      toCreate.push({
        account_code: String(qb.AcctNum),
        account_name: cleanName(qb.Name),
        full_account_path: pathOf(qb),
        account_type: mapType(qb.Classification),
        top_level_group: groupFromChain(chainOf(qb), qb.Classification),
        has_own_budget: false,
        active: qb.Active !== false,
        source: 'quickbooks',
        quickbooks_account_id: String(qb.Id),
      });
    }
    let created = 0;
    if (toCreate.length) {
      await base44.asServiceRole.entities.Account.bulkCreate(toCreate);
      created = toCreate.length;
    }

    return Response.json({
      status: 'ok',
      realmId,
      quickbooksAccounts: pAndL.length,
      matchedExisting: matched,
      createdNew: created,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}