import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

// Loads live (QuickBooks-rolled-up) spending rows for a period, merged with the
// stored BudgetLine snapshots so Spending Detail can show both side by side.
export function useLiveRollup(periodId) {
  const [data, setData] = useState({ rows: null, notice: null, loading: true });

  useEffect(() => {
    if (!periodId) return;
    let alive = true;
    setData({ rows: null, notice: null, loading: true });
    base44.functions
      .invoke('liveRollup', { period_id: periodId })
      .then((res) => {
        if (!alive) return;
        const d = res.data || {};
        setData({ rows: d.rows || [], notice: d.notice || null, loading: false });
      })
      .catch(() => {
        if (alive) setData({ rows: [], notice: null, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [periodId]);

  return data;
}