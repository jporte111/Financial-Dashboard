import { useEffect, useState, createContext, useContext } from 'react';
import { base44 } from '@/api/base44Client';

const PeriodContext = createContext(null);
export const PeriodProvider = PeriodContext.Provider;
export const usePeriodContext = () => useContext(PeriodContext);

export function usePeriodData() {
  const [user, setUser] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [periodId, setPeriodId] = useState(null);
  const [ytdMode, setYtdMode] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const me = await base44.auth.me();
    const all = await base44.entities.ReportingPeriod.list('-year');
    const isAdmin = me?.role === 'admin';
    const visible = all
      .filter((p) => isAdmin || (p.published && p.status === 'final'))
      .sort((a, b) => b.year - a.year || b.month - a.month);
    setUser(me);
    setPeriods(visible);
    setPeriodId((prev) => prev || visible[0]?.id || null);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const period = periods.find((p) => p.id === periodId) || null;
  return { user, isAdmin: user?.role === 'admin', periods, period, periodId, setPeriodId, ytdMode, setYtdMode, loading, reload: load };
}