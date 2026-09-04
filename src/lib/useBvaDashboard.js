import { useMemo } from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import { buildBvaDashboard } from '@/lib/bvaDashboard';

// Loads every BVA entity for the selected reporting period and builds the
// dashboard view model. Shared by the main Dashboard and the Budget (Excel)
// page so both render identical, corrected figures.
export function useBvaDashboard() {
  const { period, periodId, ytdMode } = usePeriodContext();
  const { items: budgetLines } = useEntityByPeriod('BudgetLine', periodId);
  const { items: cashAccounts } = useEntityByPeriod('CashAccount', periodId, 'sort_order');
  const { items: distributions } = useEntityByPeriod('Distribution', periodId);
  const { items: transfers } = useEntityByPeriod('RecurringTransfer', periodId);
  const { items: savingsSpends } = useEntityByPeriod('SavingsSpend', periodId);

  const loading = budgetLines == null || cashAccounts == null;

  const vm = useMemo(
    () =>
      buildBvaDashboard(
        {
          period: period || {},
          budgetLines: budgetLines || [],
          cashAccounts: cashAccounts || [],
          distributions: distributions || [],
          transfers: transfers || [],
          savingsSpends: savingsSpends || [],
        },
        { month: !ytdMode }
      ),
    [period, budgetLines, cashAccounts, distributions, transfers, savingsSpends, ytdMode]
  );

  return { vm, loading, periodId, ytdMode, period };
}
