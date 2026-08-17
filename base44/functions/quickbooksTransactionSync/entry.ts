import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function qbBase(realmId) {
  return `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
}

// Query a QuickBooks posting entity type across a date range with pagination.
async function pullEntity(accessToken, realmId, entity, startDate, endDate) {
  const all = [];
  let start = 1;
  const page = 500;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = `SELECT * FROM ${entity} WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' STARTPOSITION ${start} MAXRESULTS ${page}`;
    const url = `${qbBase(realmId)}/query?query=` + encodeURIComponent(q);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`QuickBooks ${entity} query failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    const items = data?.QueryResponse?.[entity] || [];
    all.push(...items);
    if (items.length < page) break;
    start += page;
  }
  return all;
}

// Extract posting lines (those with an AccountRef) from a QB transaction object.
function linesOf(txn) {
  return Array.isArray(txn.Line) ? txn.Line : [];
}

function accountRefValue(line) {
  const d = line.AccountBasedExpenseLineDetail || line.DepositLineDetail || line.JournalEntryLineDetail || line.AccountBasedPurchaseLineDetail;
  return d?.AccountRef?.value ? String(d.AccountRef.value) : null;
}

function txnTypeFor(account, isIncomeAccount) {
  if (isIncomeAccount) return 'income';
  if (account?.top_level_group === 'savings') return 'distribution';
  return 'expense';
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const periodId = body.period_id;
    if (!periodId) return Response.json({ error: 'period_id required' }, { status: 400 });

    const period = await base44.asServiceRole.entities.ReportingPeriod.get(periodId);
    if (!period || !period.start_date || !period.end_date) {
      return Response.json({ error: 'Reporting period missing start/end date' }, { status: 400 });
    }

    const { accessToken, connectionConfig } = await base44.asServiceRole.connectors.getConnection('quickbooks');
    const realmId = connectionConfig?.realmId;
    if (!realmId) return Response.json({ error: 'QuickBooks realm id missing' }, { status: 500 });

    // Index our accounts by quickbooks_account_id for linking.
    const accounts = await base44.asServiceRole.entities.Account.filter({});
    const byQbId = new Map(accounts.filter((a) => a.quickbooks_account_id).map((a) => [String(a.quickbooks_account_id), a]));

    // Existing transactions for the period — dedup by qb_transaction_id.
    const existing = await base44.asServiceRole.entities.Transaction.filter({ period_id: periodId }, '-date', 5000);
    const seenTxn = new Set(existing.filter((t) => t.qb_transaction_id).map((t) => t.qb_transaction_id));

    const entities = ['Purchase', 'Deposit', 'JournalEntry', 'Bill'];
    const collected = [];
    let pulled = 0;

    for (const entity of entities) {
      const txns = await pullEntity(accessToken, realmId, entity, period.start_date, period.end_date);
      pulled += txns.length;
      for (const txn of txns) {
        const txnId = String(txn.Id);
        // If we already have ANY line from this QB txn, skip the whole txn.
        if (seenTxn.has(`${txnId}`)) continue;
        const vendor = txn.EntityRef?.name || '';
        const date = (txn.TxnDate || '').slice(0, 10);
        const doc = txn.DocNumber || '';
        for (const line of linesOf(txn)) {
          const acctId = accountRefValue(line);
          if (!acctId) continue;
          const account = byQbId.get(acctId);
          // Only post P&L lines (accounts we track). Skip balance-sheet splits.
          if (!account) continue;
          const isIncome = account.account_type === 'income';
          const amount = Number(line.Amount || 0);
          if (amount === 0) continue;
          collected.push({
            period_id: periodId,
            qb_transaction_id: `${txnId}#${line.Id || ''}`,
            date,
            vendor,
            description: line.Description || doc || '',
            amount,
            transaction_type: txnTypeFor(account, isIncome),
            account_id: account.id,
            full_account_path: account.full_account_path || account.account_name,
            category: account.account_name,
            budget_group: account.top_level_group,
            treatment: account.top_level_group === 'savings' ? 'snvs' : 'personal',
            source: 'quickbooks',
            review_status: 'unreviewed',
            review_flags: [],
          });
        }
        seenTxn.add(`${txnId}`);
      }
    }

    let created = 0;
    if (collected.length) {
      // Bulk create in batches of 500.
      for (let i = 0; i < collected.length; i += 500) {
        const batch = collected.slice(i, i + 500);
        await base44.asServiceRole.entities.Transaction.bulkCreate(batch);
        created += batch.length;
      }
    }

    return Response.json({
      status: 'ok',
      period_id: periodId,
      period: period.label,
      quickbooksTransactions: pulled,
      importedLines: created,
      existingBeforeSync: existing.length,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}