// Versions of a monthly report (Draft revisions).
//
// A month can have several ReportingPeriod records: the original (revision 1)
// and revisions copied from it (revision_number 2, 3, ...; `supersedes` names
// the version each was copied from). When a revision is published it becomes
// the month's current report and the version it replaced is marked
// `superseded` (and unpublished). Superseded versions are kept, not deleted.
//
// Every place that asks "which record is this month's report" uses this
// module: the client dashboard, year-to-date drill-downs, period lists and the
// importer. Shared by the browser code and the backend functions.
//
// Two situations look alike and must not be confused:
//   - AWAITING CLEANUP: a published revision R and the published version S it
//     replaced (R.supersedes leads back to S), when the second write of a
//     publish (marking S superseded) has not happened yet. R is the current
//     report; S only needs finishing.
//   - CONFLICT: two published, unsuperseded versions neither of which replaced
//     the other -- e.g. two revisions of the same report published at once.
//     Base44 offers no way to prevent this (no transactions or conditional
//     writes). It is detected here and must be resolved by an admin. Until
//     then one of them is DISPLAYED by a fixed order (highest revision, then
//     latest publication, then id): that order only makes the display stable;
//     it is not a decision about which report is correct.

export const monthKey = (p: any) => `${Number(p?.year)}-${String(Number(p?.month)).padStart(2, '0')}`;
export const revisionNumber = (p: any) => Number(p?.revision_number) || 1;
export const isDiscarded = (p: any) => p?.revision_status === 'discarded';
export const isSuperseded = (p: any) => !!p?.superseded;
export const isPublishedFinal = (p: any) => !!p && !!p.published && p.status === 'final';
export const isRevision = (p: any) => !!p?.supersedes;
export const isFinal = (p: any) => p?.status === 'final' || p?.bva_import_status === 'final';
// A revision still being worked on: not discarded, superseded, final or published.
export const isOpenRevision = (p: any) => isRevision(p) && !isDiscarded(p) && !isSuperseded(p) && !p.published && !isFinal(p);

// Fixed display order among competing versions -- see the header.
const displayOrder = (a: any, b: any) =>
  revisionNumber(b) - revisionNumber(a) ||
  String(b.publication_date || '').localeCompare(String(a.publication_date || '')) ||
  String(b.id).localeCompare(String(a.id));

export function groupByMonth(periods: any[]) {
  const out = new Map<string, any[]>();
  for (const p of periods || []) {
    if (!p) continue;
    const k = monthKey(p);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(p);
  }
  return out;
}

// The state of one month's versions.
export function monthState(versions: any[]) {
  const live = (versions || []).filter((v) => !isDiscarded(v));
  const byId = new Map(live.map((v) => [v.id, v]));
  const candidates = live.filter((v) => isPublishedFinal(v) && !isSuperseded(v));
  const candidateIds = new Set(candidates.map((c) => c.id));
  // A published version replaced (directly or through a chain) by another
  // published version is only awaiting cleanup.
  const replaced = new Set<string>();
  for (const c of candidates) {
    const seen = new Set<string>([c.id]);
    let s = c.supersedes ? byId.get(c.supersedes) : null;
    while (s && !seen.has(s.id)) {
      seen.add(s.id);
      if (candidateIds.has(s.id)) replaced.add(s.id);
      s = s.supersedes ? byId.get(s.supersedes) : null;
    }
  }
  const current = candidates.filter((c) => !replaced.has(c.id)).sort(displayOrder);
  // The version an admin works from when nothing is published: the latest
  // version that is neither superseded nor an open revision.
  const working =
    current[0] ||
    live.filter((v) => !isSuperseded(v) && !isOpenRevision(v)).sort(displayOrder)[0] ||
    null;
  return {
    current: current[0] || null, // the report clients see (null: nothing published)
    conflict: current.length > 1 ? current : null, // competing published versions
    pendingCleanup: candidates.filter((c) => replaced.has(c.id)), // replaced, not yet marked superseded
    openRevisions: live.filter(isOpenRevision),
    working,
    versions: live,
  };
}

export const monthStates = (periods: any[]) => new Map([...groupByMonth(periods)].map(([k, v]) => [k, monthState(v)]));

// One current published report per month, most recent month first.
export function currentPublished(periods: any[]) {
  return [...monthStates(periods).values()]
    .map((s) => s.current)
    .filter(Boolean)
    .sort((a: any, b: any) => b.year - a.year || b.month - a.month);
}

// Is `p` the version clients currently see for its month?
export const isCurrentPublished = (periods: any[], p: any) =>
  !!p && monthState((periods || []).filter((x) => monthKey(x) === monthKey(p))).current?.id === p.id;

// The label for the normal workflow, in months rather than versions: the
// current report is just its month, a correction not yet published is named
// as such; a replaced or discarded version keeps its revision label.
export function plainLabel(p: any) {
  if (!p) return '';
  if (isSuperseded(p) || isDiscarded(p)) return versionLabel(p);
  if (isRevision(p) && !p.published) return `${p.label} · ${isFinal(p) ? 'final' : 'draft'} correction`;
  return p.label;
}

// A short admin label: "September 2026 · revision 2 (draft)".
export function versionLabel(p: any) {
  if (!p) return '';
  const n = revisionNumber(p);
  const state = isDiscarded(p) ? 'discarded' : isSuperseded(p) ? 'superseded' : p.published ? 'published' : isFinal(p) ? 'final' : 'draft';
  return n > 1 || isSuperseded(p) ? `${p.label} · revision ${n} (${state})` : p.label;
}
