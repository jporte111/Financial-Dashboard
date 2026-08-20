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

// Fuzzy de-duplication helpers — match an incoming QuickBooks line against an
// existing imported transaction that carries no qb_transaction_id, so re-syncing
// after an Excel import doesn't create a duplicate record for the same payment.
function normVendor(v) {
  return (v || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
function codeFromPath(path) {
  if (!path) return '';
  const leaf = path.split(':').pop().trim();
  const m = leaf.match(/^(\d+)/);
  return m ? m[1] : '';
}
function fuzzyKey(date, vendor, amount, code) {
  return `${(date || '').slice(0, 10)}|${normVendor(vendor)}|${Number(amount || 0)}|${code || ''}`;
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
    if (!period || !period.year) return Response.json({ error: 'Reporting period missing year' }, { status: 400 });

    // Pull the full year-to-date range (Jan 1 → selected period end) so YTD
    // figures are complete, not just the selected month.
    const rangeStart = `${period.year}-01-01`;
    const rangeEnd = period.end_date || `${period.year}-12-31`;

    const { accessToken, connectionConfig } = await base44.asServiceRole.connectors.getConnection('quickbooks');
    const realmId = connectionConfig?.realmId;
    if (!realmId) return Response.json({ error: 'QuickBooks realm id missing' }, { status: 500 });

    // All reporting periods for the year — used to route each transaction into
    // the period whose date range contains its TxnDate.
    const yearPeriods = await base44.asServiceRole.entities.ReportingPeriod.filter({ year: period.year }, 'month');
    const periodForDate = (dateStr) => {
      for (const p of yearPeriods) {
        if (p.start_date && p.end_date && dateStr >= p.start_date && dateStr <= p.end_date) return p.id;
      }
      return periodId; // fallback if no matching period exists yet
    };

    const accounts = await base44.asServiceRole.entities.Account.filter({});
    const byQbId = new Map(accounts.filter((a) => a.quickbooks_account_id).map((a) => [String(a.quickbooks_account_id), a]));

    // Existing transactions across the whole YTD range — dedup by qb_transaction_id.
    const ytdPeriodIds = yearPeriods.filter((p) => p.month <= period.month).map((p) => p.id);
    const existingBatches = ytdPeriodIds.length
      ? await Promise.all(ytdPeriodIds.map((pid) => base44.asServiceRole.entities.Transaction.filter({ period_id: pid }, '-date', 5000)))
      : [];
    const existing = existingBatches.flat();
    const seenTxn = new Set(existing.filter((t) => t.qb_transaction_id).map((t) => t.qb_transaction_id));

    // Index existing non-QuickBooks records (imports / manual) by fuzzy key so an
    // incoming QBO line can recognize an already-imported payment and convert it
    // instead of creating a duplicate.
    const fuzzyIndex = new Map();
    for (const t of existing) {
      if (t.source === 'quickbooks' || t.qb_transaction_id) continue;
      const code = codeFromPath(t.full_account_path);
      fuzzyIndex.set(fuzzyKey(t.date, t.vendor, t.amount, code), t);
    }

    // One-time cleanup: existing imports that already have a QuickBooks twin
    // (same date + vendor + amount + account code) are duplicates from a prior
    // sync that ran before fuzzy matching existed. Delete the import copy and
    // keep the QuickBooks-linked record. Idempotent — nothing to do once clean.
    const byKey = new Map();
    for (const t of existing) {
      const code = codeFromPath(t.full_account_path);
      const k = fuzzyKey(t.date, t.vendor, t.amount, code);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(t);
    }
    const cleanupDeleteIds = [];
    for (const group of byKey.values()) {
      const hasQb = group.some((t) => t.source === 'quickbooks' || t.qb_transaction_id);
      if (!hasQb) continue;
      for (const t of group) {
        if (t.source !== 'quickbooks' && !t.qb_transaction_id) cleanupDeleteIds.push(t.id);
      }
    }

    const entities = ['Purchase', 'Deposit', 'JournalEntry', 'Bill'];
    const collected = [];
    const conversions = [];
    let pulled = 0;

    for (const entity of entities) {
      const txns = await pullEntity(accessToken, realmId, entity, rangeStart, rangeEnd);
      pulled += txns.length;
      for (const txn of txns) {
        const txnId = String(txn.Id);
        const vendor = txn.EntityRef?.name || '';
        const date = (txn.TxnDate || '').slice(0, 10);
        const doc = txn.DocNumber || '';
        const targetPeriodId = periodForDate(date);
        for (const line of linesOf(txn)) {
          const acctId = accountRefValue(line);
          if (!acctId) continue;
          const account = byQbId.get(acctId);
          if (!account) continue; // only post P&L lines we track
          const lineKey = `${txnId}#${line.Id || ''}`;
          if (seenTxn.has(lineKey)) continue; // idempotent across re-runs
          const isIncome = account.account_type === 'income';
          const amount = Number(line.Amount || 0);
          if (amount === 0) continue;
          // Fuzzy match: if an imported record already represents this payment,
          // convert it to a QuickBooks-linked record instead of creating a dup.
          const fkey = fuzzyKey(date, vendor, amount, account.account_code || '');
          const fuzzyHit = fuzzyIndex.get(fkey);
          if (fuzzyHit) {
            conversions.push({
              id: fuzzyHit.id,
              qb_transaction_id: lineKey,
              source: 'quickbooks',
              account_id: account.id,
              full_account_path: account.full_account_path || account.account_name,
              category: account.account_name,
              budget_group: account.top_level_group,
              treatment: account.top_level_group === 'savings' ? 'snvs' : 'personal',
            });
            fuzzyIndex.delete(fkey);
            seenTxn.add(lineKey);
            continue;
          }
          collected.push({
            period_id: targetPeriodId,
            qb_transaction_id: lineKey,
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
          seenTxn.add(lineKey);
        }
      }
    }

    let created = 0;
    if (collected.length) {
      for (let i = 0; i < collected.length; i += 500) {
        const batch = collected.slice(i, i + 500);
        await base44.asServiceRole.entities.Transaction.bulkCreate(batch);
        created += batch.length;
      }
    }

    let converted = 0;
    if (conversions.length) {
      for (let i = 0; i < conversions.length; i += 500) {
        const batch = conversions.slice(i, i + 500);
        await base44.asServiceRole.entities.Transaction.bulkUpdate(batch);
        converted += batch.length;
      }
    }

    let cleaned = 0;
    if (cleanupDeleteIds.length) {
      await base44.asServiceRole.entities.Transaction.deleteMany({ id: { $in: cleanupDeleteIds } });
      cleaned = cleanupDeleteIds.length;
    }

    return Response.json({
      status: 'ok',
      period_id: periodId,
      period: period.label,
      rangeStart,
      rangeEnd,
      quickbooksTransactions: pulled,
      importedLines: created,
      convertedImports: converted,
      duplicatesRemoved: cleaned,
      existingBeforeSync: existing.length,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}