// Phase 9a: one set of names for a report version's state (owner, 2026-10-18),
// used everywhere a month is shown in Admin -- the context bar, the month
// picker, Review & Publish, the Periods list, History & recovery and the
// Transaction Detail screen.
import { format } from 'date-fns';
import { isSuperseded, isDiscarded, isRevision, isFinal, monthKey, monthState, currentPublished } from '../../base44/shared/periodVersions.ts';

export const STATES = {
  draft: { label: 'Draft', tone: 'draft' },
  final: { label: 'Final — not published', tone: 'final' },
  published: { label: 'Published', tone: 'published' },
  draft_correction: { label: 'Draft correction', tone: 'draft' },
  final_correction: { label: 'Final correction — not published', tone: 'final' },
  published_correction: { label: 'Published correction', tone: 'published' },
  replaced: { label: 'Replaced', tone: 'inactive' },
  discarded: { label: 'Discarded', tone: 'inactive' },
};

export const TONE_CLASS = {
  draft: 'border-sky-300 bg-sky-50 text-sky-900',
  final: 'border-amber-300 bg-amber-50 text-amber-900',
  published: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  inactive: 'border-stone-300 bg-stone-100 text-stone-700',
};

export function periodStateKey(p) {
  if (!p) return null;
  if (isDiscarded(p)) return 'discarded';
  if (isSuperseded(p)) return 'replaced';
  const correction = isRevision(p);
  if (p.published) return correction ? 'published_correction' : 'published';
  if (isFinal(p)) return correction ? 'final_correction' : 'final';
  return correction ? 'draft_correction' : 'draft';
}

// "2026-10-18" -> "Oct 18" (a date-only value, read as a calendar date).
export const shortDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(d || ''))) return '';
  return format(new Date(`${String(d).slice(0, 10)}T00:00:00`), 'MMM d');
};

// { key, label, tone, secondary }; secondary: "Corrected Oct 18" on a
// published correction (Admin only).
export function periodState(p) {
  const key = periodStateKey(p);
  if (!key) return null;
  const secondary = key === 'published_correction' && shortDate(p.publication_date) ? `Corrected ${shortDate(p.publication_date)}` : null;
  return { key, ...STATES[key], secondary };
}

// The month picker's text for one version.
export const pickerLabel = (p) => (p ? `${p.label} · ${periodState(p).label}` : '');

// What clients see, relative to version `p`:
//   visible       p is the version clients see for its month
//   monthCurrent  the version clients see for p's month (null: none published)
//   clientDefault the month the client page opens on (the latest published)
export function clientVisibility(periods, p) {
  const all = periods || [];
  const monthCurrent = p ? monthState(all.filter((x) => monthKey(x) === monthKey(p))).current : null;
  const clientDefault = currentPublished(all)[0] || null;
  return { visible: !!p && monthCurrent?.id === p.id, monthCurrent, clientDefault };
}

// The month Admin opens on: the one clients currently see (the latest
// published report); with nothing published yet, the newest version.
export const defaultAdminPeriodId = (periods) => clientVisibility(periods, null).clientDefault?.id || periods?.[0]?.id || null;

// The action labels name the month and, for a correction, say so.
export const reportName = (p) => (p ? `${p.label}${isRevision(p) ? ' correction' : ''}` : 'this report');
