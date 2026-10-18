// @vitest-environment jsdom
// Phase 9a: orientation and safety -- the month and state are unmistakable,
// Admin opens on what clients see, and publishing needs a named confirmation.
// FICTIONAL data only.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { periodState, pickerLabel, clientVisibility, defaultAdminPeriodId, reportName } from '@/lib/periodState';
import { initialPeriodId, PERIOD_STORAGE_KEY } from '@/lib/usePeriod';
import { publishExpectation } from '../../base44/shared/periodVersions.ts';

const state = vi.hoisted(() => ({ calls: [], periods: [] }));
vi.mock('@/lib/periodTransition', () => ({
  periodTransition: async (action, id, extra) => { state.calls.push([action, id, extra]); return action === 'check' ? { ok: true, publish: { blockers: [] }, checklist: { items: [] }, review: null } : { ok: true }; },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/api/base44Client', () => ({
  base44: {
    auth: { me: () => Promise.resolve({ role: 'admin', email: 'admin@example.invalid' }), logout: () => {} },
    entities: { ReportingPeriod: { list: () => Promise.resolve(state.periods) } },
  },
}));

import ContextBar from './ContextBar';
import PublishPanel, { publishSummary } from './admin/PublishPanel';
import Layout from './Layout';

const AUG = { id: 'aug', label: 'August 9102', month: 8, year: 9102, status: 'final', bva_import_status: 'final', finalized_at: '9102-09-02T00:00:00Z', published: true, publication_date: '9102-09-03' };
const SEP1 = { id: 'sep1', label: 'September 9102', month: 9, year: 9102, status: 'final', bva_import_status: 'final', finalized_at: '9102-10-02T00:00:00Z', published: true, publication_date: '9102-10-03' };
const SEP2 = { id: 'sep2', label: 'September 9102', month: 9, year: 9102, revision_number: 2, supersedes: 'sep1', status: 'final', bva_import_status: 'final', finalized_at: '9102-10-17T00:00:00Z', published: false, copy_status: 'verified' };
const OCT = { id: 'oct', label: 'October 9102', month: 10, year: 9102, status: 'draft', published: false };
const ALL = [OCT, SEP2, SEP1, AUG]; // newest first, as Admin lists them

// An in-memory localStorage (this test environment has none).
const mem = new Map();
Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() } });
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); state.calls = []; });

describe('one set of state names', () => {
  it('names every state as approved', () => {
    const cases = [
      [OCT, 'Draft'], [{ ...OCT, status: 'final' }, 'Final — not published'], [AUG, 'Published'],
      [{ ...SEP2, status: 'draft', bva_import_status: 'draft' }, 'Draft correction'], [SEP2, 'Final correction — not published'],
      [{ ...SEP2, published: true, publication_date: '9102-10-18' }, 'Published correction'],
      [{ ...SEP1, superseded: true, published: false }, 'Replaced'], [{ ...SEP2, revision_status: 'discarded' }, 'Discarded'],
    ];
    for (const [p, label] of cases) expect(periodState(p).label).toBe(label);
  });
  it('a published correction adds "Corrected <date>"; nothing else does', () => {
    expect(periodState({ ...SEP2, published: true, publication_date: '9102-10-18' }).secondary).toBe('Corrected Oct 18');
    expect(periodState(AUG).secondary).toBeNull();
  });
  it('the month picker and the action labels name the month', () => {
    expect(pickerLabel(OCT)).toBe('October 9102 · Draft');
    expect(pickerLabel(SEP2)).toBe('September 9102 · Final correction — not published');
    expect(reportName(SEP2)).toBe('September 9102 correction');
    expect(reportName(OCT)).toBe('October 9102');
  });
});

describe('Admin opens on what clients see', () => {
  it('the default is the latest published month -- not the newest draft', () => {
    expect(defaultAdminPeriodId(ALL)).toBe('sep1');
    expect(defaultAdminPeriodId([OCT])).toBe('oct'); // nothing published yet
  });
  it('the URL wins, then the month this browser last chose; unknown ids are ignored', () => {
    expect(initialPeriodId(ALL, { url: 'oct', remembered: 'aug' })).toBe('oct');
    expect(initialPeriodId(ALL, { url: 'gone', remembered: 'aug' })).toBe('aug');
    expect(initialPeriodId(ALL, { url: null, remembered: 'gone' })).toBe('sep1');
  });
  it('what clients see, per version', () => {
    expect(clientVisibility(ALL, SEP1)).toMatchObject({ visible: true });
    expect(clientVisibility(ALL, SEP2)).toMatchObject({ visible: false, monthCurrent: { id: 'sep1' }, clientDefault: { id: 'sep1' } });
    expect(clientVisibility(ALL, OCT)).toMatchObject({ visible: false, monthCurrent: null, clientDefault: { id: 'sep1' } });
  });
});

describe('the context bar', () => {
  it('the month clients see: plain, no warning', () => {
    render(<ContextBar periods={ALL} period={SEP1} onSwitch={() => {}} />);
    expect(screen.getByTestId('context-bar').getAttribute('data-visible')).toBe('yes');
    expect(screen.getByTestId('context-month').textContent).toBe('September 9102');
    expect(screen.getByTestId('state-chip').textContent).toBe('Status: Published');
    expect(screen.getByTestId('context-visibility').textContent).toMatch(/Clients see this report — the client page opens on it/);
    expect(screen.queryByTestId('context-switch')).toBeNull();
  });
  it('the October draft: says clients do not see it, and offers a switch to what they do see', () => {
    const onSwitch = vi.fn();
    render(<ContextBar periods={ALL} period={OCT} onSwitch={onSwitch} />);
    expect(screen.getByTestId('context-bar').getAttribute('data-visible')).toBe('no');
    expect(screen.getByTestId('context-visibility').textContent).toBe("Clients don't see this version. October 9102 isn't on the client page yet — the client page opens on September 9102.");
    fireEvent.click(screen.getByTestId('context-switch'));
    expect(onSwitch).toHaveBeenCalledWith('sep1');
  });
  it('a correction not yet published: clients see the published version of that month', () => {
    render(<ContextBar periods={ALL} period={SEP2} onSwitch={() => {}} />);
    expect(screen.getByTestId('context-visibility').textContent).toBe("Clients don't see this version. For September 9102 they see the published version.");
    expect(screen.getByTestId('context-switch').textContent).toBe('Switch to what clients see (September 9102)');
  });
  it('is a labelled region for screen readers', () => {
    render(<ContextBar periods={ALL} period={OCT} onSwitch={() => {}} />);
    expect(screen.getByRole('region', { name: 'Report you are working on' })).toBeTruthy();
  });
});

describe('publishing needs a named confirmation (and sends the confirmed version)', () => {
  it('the button names the month; clicking it only opens the dialog', async () => {
    render(<PublishPanel period={SEP2} periods={ALL} reload={() => {}} />);
    const open = await screen.findByTestId('publish-open');
    expect(open.textContent).toBe('Publish September 9102 correction to client page…');
    fireEvent.click(open);
    const dialog = await screen.findByTestId('publish-dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('Publish September 9102 correction to the client page?');
    expect(dialog.textContent).toMatch(/Clients will see this corrected September 9102 report instead of the one published Oct 3/);
    expect(dialog.textContent).toMatch(/not the Base44 Builder Publish/);
    expect(state.calls.some(([a]) => a === 'publish')).toBe(false);
  });
  it('focus starts on Cancel; Cancel publishes nothing', async () => {
    render(<PublishPanel period={SEP2} periods={ALL} reload={() => {}} />);
    fireEvent.click(await screen.findByTestId('publish-open'));
    const dialog = await screen.findByTestId('publish-dialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByTestId('publish-dialog')).toBeNull());
    expect(state.calls.some(([a]) => a === 'publish')).toBe(false);
  });
  it('"Publish September 9102 correction" sends exactly this month and version (B1)', async () => {
    render(<PublishPanel period={SEP2} periods={ALL} reload={() => {}} />);
    fireEvent.click(await screen.findByTestId('publish-open'));
    const confirm = await screen.findByTestId('publish-dialog-confirm');
    expect(confirm.textContent).toBe('Publish September 9102 correction');
    fireEvent.click(confirm);
    await waitFor(() => expect(state.calls.find(([a]) => a === 'publish')).toBeTruthy());
    const [, id, extra] = state.calls.find(([a]) => a === 'publish');
    expect(id).toBe('sep2');
    expect(extra).toEqual({ expect: publishExpectation(SEP2) });
    expect(extra.expect).toEqual({ period_id: 'sep2', month: 9, year: 9102, revision_number: 2, replaces: 'sep1' });
  });
  it('an older month: says the client page still opens on the latest one', () => {
    const jul = { id: 'jul', label: 'July 9102', month: 7, year: 9102, status: 'final', bva_import_status: 'final', published: false };
    expect(publishSummary(jul, [...ALL, jul])).toEqual(['Clients will see July 9102 on the client page.', 'The client page still opens on September 9102; clients choose July 9102 from the month list.']);
  });
});

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
function renderLayout(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Where />} />
          <Route path="/admin" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('the selected month in Admin pages', () => {
  it('opens on what clients see, and puts it in the URL', async () => {
    state.periods = ALL;
    renderLayout('/admin?tab=review');
    await waitFor(() => expect(screen.getByTestId('context-month').textContent).toBe('September 9102'));
    expect(screen.getByTestId('state-chip').getAttribute('data-state')).toBe('published');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin?tab=review&period=sep1'));
  });
  it('a link naming a month opens that month', async () => {
    state.periods = ALL;
    renderLayout('/?period=oct');
    await waitFor(() => expect(screen.getByTestId('context-month').textContent).toBe('October 9102'));
    expect(screen.getByTestId('context-bar').getAttribute('data-visible')).toBe('no');
  });
  it('a deliberate switch is remembered in this browser and kept in the URL; page links carry it', async () => {
    state.periods = ALL;
    renderLayout('/admin');
    await waitFor(() => expect(screen.getByTestId('context-month').textContent).toBe('September 9102'));
    // switch via the context bar's offer from a draft, then back via a link
    cleanup();
    renderLayout('/admin?period=oct');
    await waitFor(() => expect(screen.getByTestId('context-month').textContent).toBe('October 9102'));
    fireEvent.click(screen.getByTestId('context-switch'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin?period=sep1'));
    expect(window.localStorage.getItem(PERIOD_STORAGE_KEY)).toBe('sep1');
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/?period=sep1');
    expect(screen.getByRole('link', { name: 'Admin' }).getAttribute('aria-current')).toBe('page');
  });
});
