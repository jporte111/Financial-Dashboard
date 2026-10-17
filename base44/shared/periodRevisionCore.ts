// Draft revisions: copy a final or published report into a new draft version,
// verify the copy, and discard a revision. Used by periodTransition (service
// role). Publishing a revision is in periodTransitionCore.ts.
//
// The copy runs in batches and can be resumed: each copied line record names
// its source in `copied_from`, so a resumed copy skips rows already copied.
// When every row is copied, the copy is VERIFIED -- every source row has
// exactly one copy, every copied value equals its source, every copy belongs
// to the revision, and the transactions' categories still resolve to budget
// lines -- and the result is stored on the revision (copy_status). A revision
// cannot be finalized until its copy is verified. Verification proves only that
// the initial copy was complete and faithful; later edits and corrected imports
// go through the normal finalization checks like any draft.

// TransactionDetailChunk: Phase 5b transaction detail; a correction starts with
// a copy of the published version's detail (replaced if detail is re-attached).
export const COPY_ENTITIES = ['BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend', 'Transaction', 'TransactionDetailChunk'];

// Server-written version fields of a ReportingPeriod.
export const REVISION_FIELDS = [
  'revision_of', 'revision_number', 'supersedes', 'superseded', 'superseded_by', 'superseded_at',
  'revision_reason', 'revision_created_by', 'revision_created_at', 'revision_status', 'copy_status', 'copy_verification',
];

// Record fields Base44 manages.
const SYSTEM = new Set(['id', 'created_date', 'updated_date', 'created_by', 'created_by_id', 'is_sample', 'app_id']);
// Period fields that describe state, publication or versions -- never copied.
const NOT_COPIED = new Set([
  ...SYSTEM, ...REVISION_FIELDS,
  'status', 'published', 'bva_import_status', 'finalized_at', 'finalized_by', 'reopen_log',
  'publication_date', 'reviewed_by', 'checklist', 'checklist_confirmations', 'last_updated',
]);

// The deployed entity schema lacks the draft-revision fields (a partial
// deployment: functions newer than the schemas).
export class SchemaOutOfDate extends Error {
  constructor(field: string) {
    super(`The data schema does not have ${field} yet (the entity schemas are older than the backend functions). Publish the entity schemas, then try again.`);
  }
}
export const REQUIRED_REVISION_FIELDS = ['supersedes', 'revision_number', 'copy_status', 'revision_status'];

// visibleDelaysMs / verifyDelaysMs: Base44 reads can lag rows just created.
// After copying an entity the copy waits (these pauses) until the new rows are
// visible, so a resumed copy never copies them twice; and a verification that
// finds rows only MISSING (nothing duplicated, extra, changed or misplaced) is
// repeated after these pauses before the copy is declared failed.
export const copyOptions = { batchSize: 50, budgetMs: 60 * 1000, attempts: 5, firstDelayMs: 500, visibleDelaysMs: [300, 600, 1200, 2000], verifyDelaysMs: [500, 1000, 2000, 3000, 4000] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withoutNulls = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const listOf = (res: any) => (Array.isArray(res) ? res : (res && res.items) || []);

// A rate-limited call was refused, so it is safe to make again.
const rateLimited = (e: any) => (e?.status ?? e?.response?.status) === 429 || /rate limit/i.test(String(e?.message || ''));
async function retrying(fn: () => Promise<any>) {
  let delay = copyOptions.firstDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!rateLimited(e) || attempt >= copyOptions.attempts) throw e;
      // Visible in the function logs: how often Base44 rate-limits a revision.
      console.warn(`[revision] rate limited (attempt ${attempt}); retrying in ${delay} ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

const rowsOf = async (svc: any, entity: string, periodId: string) =>
  listOf(await retrying(() => svc.entities[entity].filter({ period_id: periodId }, undefined, 5000)));

export function periodCopy(source: any) {
  return withoutNulls(Object.fromEntries(Object.entries(source).filter(([k]) => !NOT_COPIED.has(k))));
}
const rowCopy = (row: any, revisionId: string) =>
  withoutNulls({
    ...Object.fromEntries(Object.entries(row).filter(([k]) => !SYSTEM.has(k) && k !== 'period_id' && k !== 'copied_from')),
    period_id: revisionId,
    copied_from: row.id,
  });

// The new draft version record (copy not yet started).
export function revisionRecord(source: any, { reason, by, now }: { reason: string; by: string; now: Date }) {
  return {
    ...periodCopy(source),
    status: 'draft',
    bva_import_status: 'draft',
    published: false,
    finalized_at: '',
    finalized_by: '',
    checklist: {},
    checklist_confirmations: {},
    revision_of: source.revision_of || source.id,
    revision_number: (Number(source.revision_number) || 1) + 1,
    supersedes: source.id,
    revision_reason: reason,
    revision_created_by: by,
    revision_created_at: now.toISOString(),
    revision_status: 'open',
    copy_status: 'copying',
    last_updated: now.toISOString().slice(0, 10),
  };
}

// Copy what is not yet copied, within the time budget; verify when complete.
// Wait until `expected` rows of `entity` are visible for the revision.
async function awaitVisible(svc: any, entity: string, revisionId: string, expected: number) {
  for (const ms of copyOptions.visibleDelaysMs || []) {
    if ((await rowsOf(svc, entity, revisionId)).length >= expected) return;
    await sleep(ms);
  }
}
// A failed verification caused only by rows not visible yet.
const onlyMissing = (report: any) =>
  !report.period?.changed &&
  Object.values(report.entities || {}).every((e: any) => !e.duplicates && !e.extra && !e.changed && !e.wrong_period);

export async function copyStep(svc: any, revision: any, source: any) {
  const started = Date.now();
  const copied: Record<string, number> = {};
  for (const entity of COPY_ENTITIES) {
    const sources = await rowsOf(svc, entity, source.id);
    const have = new Set((await rowsOf(svc, entity, revision.id)).map((r: any) => r.copied_from));
    const todo = sources.filter((s: any) => !have.has(s.id));
    for (let i = 0; i < todo.length; i += copyOptions.batchSize) {
      // Every call copies at least one batch, so a resumed copy always progresses.
      if (Object.keys(copied).length && Date.now() - started > copyOptions.budgetMs) {
        if (copied[entity]) await awaitVisible(svc, entity, revision.id, have.size + copied[entity]);
        return { done: false, copied };
      }
      const batch = todo.slice(i, i + copyOptions.batchSize).map((s: any) => rowCopy(s, revision.id));
      await retrying(() => svc.entities[entity].bulkCreate(batch));
      // Base44 drops fields its schema does not declare: if copied_from did not
      // stick (read back from storage, not from the create response), the
      // entity schema is out of date and the copy cannot be tracked.
      if (!copied[entity]) {
        const stored = await rowsOf(svc, entity, revision.id);
        if (stored.length && stored.every((r: any) => !r.copied_from)) throw new SchemaOutOfDate(`${entity}.copied_from`);
      }
      copied[entity] = (copied[entity] || 0) + batch.length;
    }
    if (copied[entity]) await awaitVisible(svc, entity, revision.id, have.size + copied[entity]);
  }
  let report = await verifyCopy(svc, revision, source);
  for (const ms of copyOptions.verifyDelaysMs || []) {
    if (report.ok || !onlyMissing(report)) break;
    await sleep(ms);
    report = await verifyCopy(svc, revision, source);
  }
  await retrying(() => svc.entities.ReportingPeriod.update(revision.id, { copy_status: report.ok ? 'verified' : 'failed', copy_verification: report }));
  return { done: true, verified: report.ok, copied, report };
}

const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const LIMIT = 20; // how many offending ids a report lists

// Compare the revision's copy with its source: rows, values, relationships.
export async function verifyCopy(svc: any, revision: any, source: any) {
  const report: any = { checked_at: new Date().toISOString(), entities: {}, period: {}, relationships: {} };
  let ok = true;
  const copyOf: Record<string, any[]> = {};
  for (const entity of COPY_ENTITIES) {
    const sources = await rowsOf(svc, entity, source.id);
    const copies = await rowsOf(svc, entity, revision.id);
    copyOf[entity] = copies;
    const bySource = new Map<string, any[]>();
    for (const c of copies) {
      const k = String(c.copied_from || '');
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k)!.push(c);
    }
    const sourceIds = new Set(sources.map((s: any) => s.id));
    const missing = sources.filter((s: any) => !bySource.has(s.id)).map((s: any) => s.id);
    const duplicates = [...bySource].filter(([k, list]) => sourceIds.has(k) && list.length > 1).map(([k]) => k);
    const extra = copies.filter((c: any) => !sourceIds.has(c.copied_from)).map((c: any) => c.id);
    const changed: any[] = [];
    for (const s of sources) {
      const c = (bySource.get(s.id) || [])[0];
      if (!c) continue;
      const keys = new Set([...Object.keys(s), ...Object.keys(c)].filter((k) => !SYSTEM.has(k) && k !== 'period_id' && k !== 'copied_from'));
      const fields = [...keys].filter((k) => !same(s[k], c[k]));
      if (fields.length) changed.push({ source: s.id, copy: c.id, fields });
    }
    const wrongPeriod = copies.filter((c: any) => c.period_id !== revision.id).map((c: any) => c.id);
    const bad = missing.length + duplicates.length + extra.length + changed.length + wrongPeriod.length;
    if (bad) ok = false;
    report.entities[entity] = {
      source: sources.length,
      copies: copies.length,
      ...(missing.length ? { missing: missing.slice(0, LIMIT) } : {}),
      ...(duplicates.length ? { duplicates: duplicates.slice(0, LIMIT) } : {}),
      ...(extra.length ? { extra: extra.slice(0, LIMIT) } : {}),
      ...(changed.length ? { changed: changed.slice(0, LIMIT) } : {}),
      ...(wrongPeriod.length ? { wrong_period: wrongPeriod.slice(0, LIMIT) } : {}),
    };
  }
  // Period figures, parsed workbook and adjustments.
  const fresh = (await retrying(() => svc.entities.ReportingPeriod.get(revision.id))) || revision;
  const wanted = periodCopy(source);
  const periodChanged = Object.keys(wanted).filter((k) => !same(wanted[k], fresh[k]));
  if (periodChanged.length) ok = false;
  report.period = periodChanged.length ? { changed: periodChanged } : { fields: Object.keys(wanted).length };
  // Transactions refer to budget lines by category name: every category that
  // resolved to a budget line in the source must resolve in the revision.
  const sourceLines = new Set((await rowsOf(svc, 'BudgetLine', source.id)).map((l: any) => l.category));
  const revisionLines = new Set(copyOf.BudgetLine.map((l: any) => l.category));
  const unresolved = [...new Set(copyOf.Transaction.map((t: any) => t.category).filter((c: any) => c && sourceLines.has(c) && !revisionLines.has(c)))];
  if (unresolved.length) ok = false;
  report.relationships = unresolved.length ? { unresolved_categories: unresolved.slice(0, LIMIT) } : { transactions_to_lines: 'resolve as in the source' };
  report.ok = ok;
  return report;
}

// Remove an unpublished revision: mark it discarded first (so every reader
// ignores it at once), then delete its rows and the record. Resumable.
export async function discardStep(svc: any, revision: any) {
  const started = Date.now();
  if (revision.revision_status !== 'discarded') {
    await retrying(() => svc.entities.ReportingPeriod.update(revision.id, { revision_status: 'discarded' }));
  }
  for (const entity of COPY_ENTITIES) {
    for (const row of await rowsOf(svc, entity, revision.id)) {
      if (Date.now() - started > copyOptions.budgetMs) return { done: false };
      await retrying(() => svc.entities[entity].delete(row.id));
    }
  }
  await retrying(() => svc.entities.ReportingPeriod.delete(revision.id));
  return { done: true };
}
