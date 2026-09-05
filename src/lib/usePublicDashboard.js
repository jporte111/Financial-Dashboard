import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { buildBvaDashboard } from '@/lib/bvaDashboard';

// Public (no-login) client view data. Everything comes from the
// publicDashboard backend function, which serves published periods only and
// strips internal fields — anonymous visitors can never read entities
// directly. The records are fed into buildBvaDashboard, the same view-model
// builder the logged-in Dashboard uses, so figures are identical.
export function usePublicDashboard() {
  const [selectedId, setSelectedId] = useState(null);
  const [state, setState] = useState({ loading: true, data: null, error: false });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    base44.functions
      .invoke('publicDashboard', { period_id: selectedId || undefined })
      .then((res) => {
        if (!cancelled) setState({ loading: false, data: res.data || res, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, data: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const data = state.data;

  const vm = useMemo(() => {
    if (!data || !data.period) return null;
    return buildBvaDashboard(
      {
        period: data.period,
        budgetLines: data.budgetLines || [],
        cashAccounts: data.cashAccounts || [],
        distributions: data.distributions || [],
        transfers: data.transfers || [],
        savingsSpends: data.savingsSpends || [],
      },
      { month: false }
    );
  }, [data]);

  return {
    loading: state.loading,
    error: state.error,
    vm,
    periods: data?.periods || [],
    period: data?.period || null,
    selectedId,
    setSelectedId,
  };
}