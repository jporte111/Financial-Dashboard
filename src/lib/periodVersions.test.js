// Which version of a month is the report (base44/shared/periodVersions.ts).
// Fictional records only.
import { describe, it, expect } from 'vitest';
import { monthState, currentPublished, isCurrentPublished, versionLabel } from '../../base44/shared/periodVersions.ts';

const v = (id, extra = {}) => ({ id, label: 'September 2026', month: 9, year: 2026, status: 'final', bva_import_status: 'final', published: false, ...extra });
const S = v('s', { published: true, publication_date: '2026-10-01' });

describe('monthState', () => {
  it('a single published version is current', () => {
    const st = monthState([S]);
    expect(st.current.id).toBe('s');
    expect(st.conflict).toBe(null);
    expect(st.pendingCleanup).toEqual([]);
  });

  it('an open revision is not shown to clients; the published original stays current', () => {
    const r = v('r', { status: 'draft', bva_import_status: 'draft', supersedes: 's', revision_number: 2, revision_status: 'open', copy_status: 'verified' });
    const st = monthState([S, r]);
    expect(st.current.id).toBe('s');
    expect(st.openRevisions.map((x) => x.id)).toEqual(['r']);
  });

  it('AWAITING CLEANUP: a published revision and the published version it replaced -- the revision is current, no conflict', () => {
    const r = v('r', { published: true, supersedes: 's', revision_number: 2 });
    const st = monthState([S, r]);
    expect(st.current.id).toBe('r');
    expect(st.conflict).toBe(null);
    expect(st.pendingCleanup.map((x) => x.id)).toEqual(['s']);
  });

  it('awaiting cleanup through a chain (rev 3 replaced rev 2 which replaced the original)', () => {
    const r2 = v('r2', { published: true, supersedes: 's', revision_number: 2 });
    const r3 = v('r3', { published: true, supersedes: 'r2', revision_number: 3 });
    const st = monthState([S, r2, r3]);
    expect(st.current.id).toBe('r3');
    expect(st.conflict).toBe(null);
    expect(st.pendingCleanup.map((x) => x.id).sort()).toEqual(['r2', 's']);
  });

  it('CONFLICT: two revisions of the same version both published -- detected, not resolved by the display order', () => {
    const a = v('a', { published: true, supersedes: 's', revision_number: 2, publication_date: '2026-10-05' });
    const b = v('b', { published: true, supersedes: 's', revision_number: 2, publication_date: '2026-10-06' });
    const st = monthState([S, a, b]);
    expect(st.conflict.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(st.pendingCleanup.map((x) => x.id)).toEqual(['s']);
    expect(st.current.id).toBe('b'); // displayed, but flagged as a conflict
  });

  it('superseded and discarded versions are never current', () => {
    const old = v('s', { published: false, superseded: true, superseded_by: 'r' });
    const r = v('r', { published: true, supersedes: 's', revision_number: 2 });
    const gone = v('x', { published: true, revision_status: 'discarded', revision_number: 9 });
    const st = monthState([old, r, gone]);
    expect(st.current.id).toBe('r');
    expect(st.versions.map((x) => x.id).sort()).toEqual(['r', 's']);
  });

  it('nothing published: the working version is the latest final one (not an open revision)', () => {
    const orig = v('o');
    const r = v('r', { status: 'draft', bva_import_status: 'draft', supersedes: 'o', revision_number: 2 });
    const st = monthState([orig, r]);
    expect(st.current).toBe(null);
    expect(st.working.id).toBe('o');
  });
});

describe('one report per month for clients', () => {
  it('currentPublished serves one version per month, most recent month first', () => {
    const aug = v('aug', { label: 'August 2026', month: 8, published: true });
    const r = v('r', { published: true, supersedes: 's', revision_number: 2 });
    const list = currentPublished([aug, S, r, v('draft', { status: 'draft', published: false })]);
    expect(list.map((x) => x.id)).toEqual(['r', 'aug']);
  });

  it('isCurrentPublished is false for a version awaiting cleanup', () => {
    const r = v('r', { published: true, supersedes: 's', revision_number: 2 });
    expect(isCurrentPublished([S, r], S)).toBe(false);
    expect(isCurrentPublished([S, r], r)).toBe(true);
  });

  it('labels show the version only when there is more than one', () => {
    expect(versionLabel(S)).toBe('September 2026');
    expect(versionLabel(v('r', { revision_number: 2, status: 'draft', bva_import_status: 'draft' }))).toBe('September 2026 · revision 2 (draft)');
    expect(versionLabel(v('s', { superseded: true }))).toBe('September 2026 · revision 1 (superseded)');
  });
});
