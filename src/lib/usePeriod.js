import { useEffect, useState, createContext, useContext, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { currentPublished, isDiscarded, revisionNumber } from '../../base44/shared/periodVersions.ts';
import { defaultAdminPeriodId } from './periodState.js';

const PeriodContext = createContext(null);
export const PeriodProvider = PeriodContext.Provider;
export const usePeriodContext = () => useContext(PeriodContext);

// Phase 9a: which month Admin works on. The URL (?period=) wins, then the
// month this browser last switched to deliberately, then the month clients
// currently see -- never silently the newest draft.
export const PERIOD_URL_PARAM = 'period';
export const PERIOD_STORAGE_KEY = 'sonia.admin.period';
const stored = () => { try { return window.localStorage.getItem(PERIOD_STORAGE_KEY); } catch { return null; } };
const store = (id) => { try { if (id) window.localStorage.setItem(PERIOD_STORAGE_KEY, id); } catch { /* storage unavailable: the URL still carries it */ } };

export function initialPeriodId(visible, { url = null, remembered = null } = {}) {
  const known = (id) => !!id && visible.some((p) => p.id === id);
  if (known(url)) return url;
  if (known(remembered)) return remembered;
  return defaultAdminPeriodId(visible);
}

export function usePeriodData() {
  const [params, setParams] = useSearchParams();
  const [user, setUser] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [periodId, setPeriodIdState] = useState(null);
  const [ytdMode, setYtdMode] = useState(true);
  const [loading, setLoading] = useState(true);
  const urlPeriod = params.get(PERIOD_URL_PARAM);

  const load = async () => {
    const me = await base44.auth.me();
    const all = await base44.entities.ReportingPeriod.list('-year');
    const isAdmin = me?.role === 'admin';
    // Admins see every version (draft revisions and superseded versions
    // included, discarded ones not); everyone else one current published
    // report per month (see base44/shared/periodVersions.ts).
    const visible = isAdmin
      ? all
          .filter((p) => !isDiscarded(p))
          .sort((a, b) => b.year - a.year || b.month - a.month || revisionNumber(b) - revisionNumber(a))
      : currentPublished(all);
    setUser(me);
    setPeriods(visible);
    setPeriodIdState((prev) => (prev && visible.some((p) => p.id === prev) ? prev : initialPeriodId(visible, { url: urlPeriod, remembered: stored() })));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const writeUrl = useCallback((id) => {
    setParams((prev) => {
      if (prev.get(PERIOD_URL_PARAM) === id) return prev;
      const next = new URLSearchParams(prev);
      next.set(PERIOD_URL_PARAM, id);
      return next;
    }, { replace: true });
  }, [setParams]);

  // A deliberate switch (the month picker, opening a month from Periods or
  // History, the month an import just wrote): remembered in this browser and
  // kept in the URL.
  const setPeriodId = useCallback((id) => {
    if (!id) return;
    setPeriodIdState(id);
    store(id);
    writeUrl(id);
  }, [writeUrl]);

  // Keep the URL and the selection in step: a link or back/forward that
  // names another known month switches to it; a page without ?period= gets it.
  useEffect(() => {
    if (loading || !periodId) return;
    if (urlPeriod && urlPeriod !== periodId && periods.some((p) => p.id === urlPeriod)) { setPeriodIdState(urlPeriod); store(urlPeriod); return; }
    if (urlPeriod !== periodId) writeUrl(periodId);
  }, [loading, urlPeriod, periodId, periods, writeUrl]);

  const period = periods.find((p) => p.id === periodId) || null;
  return { user, isAdmin: user?.role === 'admin', periods, period, periodId, setPeriodId, ytdMode, setYtdMode, loading, reload: load };
}
