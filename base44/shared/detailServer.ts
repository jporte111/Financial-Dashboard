// Phase 5b, server side: attach transaction detail to a report version, and
// read it back. Called by periodTransition (stage_detail, commit_detail,
// check, finalize) and the drill-down endpoints. The pure rules live in
// detailReport.ts.
//
// Attaching is allowed only to a version that is not published, not
// superseded and not discarded (a draft, an open correction, or a final but
// unpublished report); a correction's copy must be verified first. Published
// and superseded versions' detail is frozen: never written again, whatever
// QuickBooks later says. Staged chunks become the version's detail only when
// commit_detail has re-checked everything and switched
// ReportingPeriod.detail_import to that import in ONE write; readers use only
// the attached import, so a half-staged upload is never visible.
import {
  readDetailReport, validateDetailReport, buildDetailRows, reconcileDetail, modelFromPackage, normPath, CHUNK_ROWS,
} from './detailReport.ts';
import { isRevision, isSuperseded, isDiscarded } from './periodVersions.ts';

const listOf = (res: any) => (Array.isArray(res) ? res : (res && res.items) || []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const detailOptions = { readDelaysMs: [300, 700, 1500, 3000] };

export function attachRefusal(period: any) {
  if (!period) return { code: 'not_found', message: 'Report version not found.' };
  if (period.published) return { code: 'detail_frozen', message: 'This report is published, so its transaction detail is frozen. To change it, upload the updated BVA workbook (a correction) and attach the detail to the correction.' };
  if (isSuperseded(period)) return { code: 'detail_frozen', message: 'This version was replaced by a newer one; its transaction detail is frozen.' };
  if (isDiscarded(period)) return { code: 'detail_frozen', message: 'This version was discarded.' };
  if (isRevision(period) && period.copy_status !== 'verified') return { code: 'revision_copy_unverified', message: 'This correction is still being copied from the published report; attach the detail once the copy is verified.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(period.reporting_cutoff_date || ''))) return { code: 'detail_no_cutoff', message: 'This report version has no confirmed cutoff date; import its BVA workbook first.' };
  return null;
}

const ROW_KEYS = ['r', 'd', 'a', 'p', 'ok'];
function badRow(row: any) {
  if (!row || typeof row !== 'object') return 'not an object';
  for (const k of ROW_KEYS) if (row[k] === undefined) return `missing ${k}`;
  if (!Number.isInteger(row.a)) return 'amount must be whole cents';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.d))) return 'bad date';
  return null;
}

const chunksOf = async (svc: any, periodId: string, importId: string | null = null) =>
  listOf(await svc.entities.TransactionDetailChunk.filter(importId ? { period_id: periodId, import_id: importId } : { period_id: periodId }, 'seq', 2000));

// One chunk of an import. Safe to repeat (a retried call replaces the chunk).
export async function stageDetail(svc: any, period: any, body: any) {
  const refusal = attachRefusal(period);
  if (refusal) return { status: 409, body: { ok: false, blockers: [{ ...refusal, overridable: false }] } };
  const { import_id, seq, rows } = body || {};
  if (!/^\d{13}-[a-z0-9]{6,}$/.test(String(import_id || ''))) return { status: 400, body: { error: 'import_id required' } };
  if (!Number.isInteger(seq) || seq < 0) return { status: 400, body: { error: 'seq required' } };
  if (!Array.isArray(rows) || !rows.length || rows.length > CHUNK_ROWS) return { status: 400, body: { error: `rows: 1-${CHUNK_ROWS} required` } };
  const bad = rows.map(badRow).find(Boolean);
  if (bad) return { status: 400, body: { error: `invalid row: ${bad}` } };
  const existing = (await chunksOf(svc, period.id, import_id)).filter((c: any) => c.seq === seq);
  for (const c of existing) await svc.entities.TransactionDetailChunk.delete(c.id).catch(() => {});
  await svc.entities.TransactionDetailChunk.create({ period_id: period.id, import_id, seq, rows });
  return { status: 200, body: { ok: true, action: 'stage_detail', period_id: period.id, import_id, seq, rows: rows.length } };
}

const confirmedMap = async (svc: any) => new Map<string, string>(
  listOf(await svc.entities.DetailAccountMap.list('-created_date', 5000)).filter((m: any) => m.account_path && m.plain_name).map((m: any) => [normPath(m.account_path), String(m.plain_name)])
);
const sameRow = (a: any, b: any) => a.r === b.r && a.d === b.d && a.a === b.a && a.p === b.p && !!a.ok === !!b.ok && (a.ac || '') === (b.ac || '') && (a.g || '') === (b.g || '') && (a.n || '') === (b.n || '');

// Check the file again from its compact package, rebuild the version's rows
// with the CONFIRMED mappings on record, require the staged rows to match them
// exactly, reconcile against the version's own BVA lines, then switch the
// version to this import in one write.
export async function commitDetail(svc: any, period: any, body: any, who: string, now: Date) {
  const { import_id, file } = body || {};
  if (!/^\d{13}-[a-z0-9]{6,}$/.test(String(import_id || ''))) return { status: 400, body: { error: 'import_id required' } };
  // A refused commit removes what its upload staged (never the attached import).
  const refuse = async (code: string, message: string, extra: any = {}) => {
    if (period?.detail_import?.import_id !== import_id) {
      for (const c of await chunksOf(svc, period.id, import_id).catch(() => [])) await svc.entities.TransactionDetailChunk.delete(c.id).catch(() => {});
    }
    return { status: 409, body: { ok: false, action: 'commit_detail', blockers: [{ code, message, overridable: false }], ...extra } };
  };
  const refusal = attachRefusal(period);
  if (refusal) return refuse(refusal.code, refusal.message);
  const read = readDetailReport(modelFromPackage(body.package));
  const checks = validateDetailReport(read);
  if (!checks.ok) return refuse('detail_checks_failed', 'The transaction report did not pass its checks, so nothing was attached.', { checks: checks.checks });
  const maps = await confirmedMap(svc);
  const built = buildDetailRows(read, { cutoff: period.reporting_cutoff_date, year: period.year }, maps);
  if (built.issues.length) return refuse('detail_period_mismatch', built.issues.join(' '));
  // staged chunks (reads can lag the writes just made)
  let chunks: any[] = [];
  for (const ms of [0, ...detailOptions.readDelaysMs]) {
    if (ms) await sleep(ms);
    chunks = await chunksOf(svc, period.id, import_id);
    if (chunks.reduce((n: number, c: any) => n + (c.rows || []).length, 0) >= built.rows.length) break;
  }
  const staged = chunks.sort((a: any, b: any) => a.seq - b.seq).flatMap((c: any) => c.rows || []).sort((a: any, b: any) => a.r - b.r);
  const expected = [...built.rows].sort((a: any, b: any) => a.r - b.r);
  if (staged.length !== expected.length || staged.some((row: any, i: number) => !sameRow(row, expected[i]))) {
    const first = staged.findIndex((row: any, i: number) => !expected[i] || !sameRow(row, expected[i]));
    return refuse('detail_staged_mismatch', `The uploaded rows do not match the report (${staged.length} staged, ${expected.length} expected${first >= 0 ? `; first difference at sheet row ${staged[first]?.r ?? expected[first]?.r}` : ''}). Nothing was attached; import the file again.`);
  }
  const lines = listOf(await svc.entities.BudgetLine.filter({ period_id: period.id }, undefined, 5000));
  const reconciliation = reconcileDetail(staged, lines);
  const at = now.toISOString();
  const detail_import = {
    import_id, status: 'attached', attached_by: who, attached_at: at,
    file_name: String(file?.name || '').slice(0, 200), file_sha256: String(file?.sha256 || '').slice(0, 64),
    title: read.meta.title, report_period: read.meta.period, basis: read.meta.basis, run_at: read.meta.run_at,
    cutoff: period.reporting_cutoff_date, rows_total: read.transactions.length, rows_stored: staged.length,
    after_cutoff: built.after, chunks: chunks.length, checks: checks.checks, reconciliation, reconciled_at: at,
  };
  await svc.entities.ReportingPeriod.update(period.id, { detail_import });
  const removed = await cleanupDetail(svc, period.id);
  return { status: 200, body: { ok: true, action: 'commit_detail', period_id: period.id, detail_import, removed_chunks: removed } };
}

// Remove chunks of this version's OLDER imports (the import id starts with its
// creation time), never those of the attached import or of a newer one.
export async function cleanupDetail(svc: any, periodId: string) {
  let current: any = null;
  try { current = await svc.entities.ReportingPeriod.get(periodId); } catch { current = null; }
  const cur = current?.detail_import?.import_id;
  if (!cur || current.published || isSuperseded(current)) return 0;
  const curTs = Number(String(cur).slice(0, 13));
  let n = 0;
  for (const c of await chunksOf(svc, periodId)) {
    const ts = Number(String(c.import_id || '').slice(0, 13));
    if (c.import_id !== cur && Number.isFinite(ts) && ts < curTs) {
      await svc.entities.TransactionDetailChunk.delete(c.id).then(() => n++).catch(() => {});
    }
  }
  return n;
}

// The attached detail rows of a version, or null when none is attached.
// Refuses to return a partial set (all chunks must be readable).
export async function attachedDetailRows(svc: any, period: any) {
  const di = period?.detail_import;
  if (!di || di.status !== 'attached' || !di.import_id) return null;
  let rows: any[] = [];
  for (const ms of [0, ...detailOptions.readDelaysMs.slice(0, 2)]) {
    if (ms) await sleep(ms);
    const chunks = (await chunksOf(svc, period.id, di.import_id)).sort((a: any, b: any) => a.seq - b.seq);
    rows = chunks.flatMap((c: any) => c.rows || []);
    if (rows.length === di.rows_stored) return rows;
  }
  throw Object.assign(new Error('The transaction detail is not fully readable yet; try again in a moment.'), { code: 'detail_incomplete' });
}

// Live reconciliation of the attached detail against the version's lines.
export async function liveReconciliation(svc: any, period: any, lines: any[]) {
  const rows = await attachedDetailRows(svc, period).catch(() => null);
  return rows ? reconcileDetail(rows, lines) : null;
}
