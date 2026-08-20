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

    // Load existing app Accounts. The QBO chart of accounts is maintained by
    // quickbooks_account_id — create once, update on later runs. Import-source
    // accounts are never matched or touched here (they're a separate layer).
    const existing = await base44.asServiceRole.entities.Account.filter({});
    const byQbId = new Map(
      existing.filter((a) => a.quickbooks_account_id && a.source === 'quickbooks').map((a) => [String(a.quickbooks_account_id), a])
    );

    // Update existing QBO accounts (re-classify so fixes to the inference propagate).
    const updates = [];
    let matched = 0;
    for (const qb of pAndL) {
      if (!qb.AcctNum) continue;
      const app = byQbId.get(String(qb.Id));
      if (!app) continue;
      updates.push(
        base44.asServiceRole.entities.Account.update(app.id, {
          account_name: cleanName(qb.Name),
          full_account_path: pathOf(qb),
          account_type: mapType(qb.Classification),
          top_level_group: groupFromChain(chainOf(qb), qb.Classification),
          active: qb.Active !== false,
        })
      );
      matched++;
    }
    if (updates.length) await Promise.all(updates);

    // Create QBO accounts not yet tracked (by quickbooks_account_id).
    const toCreate = [];
    for (const qb of pAndL) {
      if (!qb.AcctNum) continue;
      if (byQbId.has(String(qb.Id))) continue;
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