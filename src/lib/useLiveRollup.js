import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

// Loads the live (QuickBooks) layer for a period:
//   rows         — Spending Detail comparison rows (one per BudgetLine).
//   liveAccounts — per-QBO-account live totals (Live QuickBooks page).
export function useLiveRollup(periodId) {
  const [data, setData] = useState({ rows: null, liveAccounts: null, notice: null, loading: true });

  useEffect(() => {
    if (!periodId) return;
    let alive = true;
    setData({ rows: null, liveAccounts: null, notice: null, loading: true });
    base44.functions
      .invoke('liveRollup', { period_id: periodId })
      .then((res) => {
        if (!alive) return;
        const d = res.data || {};
        setData({ rows: d.rows || [], liveAccounts: d.liveAccounts || [], notice: d.notice || null, loading: false });
      })
      .catch(() => {
        if (alive) setData({ rows: [], liveAccounts: [], notice: null, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [periodId]);

  return data;
}