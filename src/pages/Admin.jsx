import React from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PeriodTotalsForm from '@/components/admin/PeriodTotalsForm';
import BudgetLinesEditor from '@/components/admin/BudgetLinesEditor';
import SupportingDataEditor from '@/components/admin/SupportingDataEditor';
import PublishPanel from '@/components/admin/PublishPanel';
import ReviewQueue from '@/components/admin/ReviewQueue';
import PeriodsManager from '@/components/admin/PeriodsManager';
import TransactionsEditor from '@/components/admin/TransactionsEditor';
import AccountHierarchyManager from '@/components/admin/AccountHierarchyManager';
import ImportHub from '@/components/admin/ImportHub';

export default function Admin() {
  const { user, isAdmin, period, periodId, periods, setPeriodId, reload } = usePeriodContext();
  const lines = useEntityByPeriod('BudgetLine', periodId);
  const cash = useEntityByPeriod('CashAccount', periodId, 'sort_order');
  const dists = useEntityByPeriod('Distribution', periodId);
  const transfers = useEntityByPeriod('RecurringTransfer', periodId);
  const savings = useEntityByPeriod('SavingsSpend', periodId);

  if (!isAdmin)
    return <p className="rounded-2xl border border-stone-200 bg-white p-12 text-center text-sm text-stone-500">This area is restricted to the internal team.</p>;

  return (
    <Tabs defaultValue={period ? 'data' : 'import'} className="space-y-6">
      {!period && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No reporting period exists yet. Use <strong>Import</strong> to import a BVA workbook — it creates the
          period for you — or use <strong>Periods</strong> to create one manually.
        </div>
      )}
      <TabsList className="flex h-auto flex-wrap justify-start gap-1 rounded-2xl">
        <TabsTrigger value="data" className="rounded-full">Monthly Data</TabsTrigger>
        <TabsTrigger value="transactions" className="rounded-full">Transactions</TabsTrigger>
        <TabsTrigger value="accounts" className="rounded-full">Accounts</TabsTrigger>
        <TabsTrigger value="import" className="rounded-full">Import</TabsTrigger>
        <TabsTrigger value="review" className="rounded-full">Review & Publish</TabsTrigger>
        <TabsTrigger value="periods" className="rounded-full">Periods</TabsTrigger>
      </TabsList>

      <TabsContent value="data" className="space-y-5">
        <PeriodTotalsForm period={period} reload={reload} />
        <BudgetLinesEditor periodId={periodId} lines={lines.items} reload={lines.reload} />
        <SupportingDataEditor
          title="Cash Accounts"
          entityName="CashAccount"
          periodId={periodId}
          items={cash.items}
          reload={cash.reload}
          defaults={{ name: 'New Account', account_type: 'bank' }}
          fields={[
            { key: 'name', label: 'Account', wide: true },
            { key: 'balance', label: 'Balance', type: 'number' },
            { key: 'as_of_date', label: 'As-of date', type: 'date' },
            { key: 'account_type', label: 'bank / investment' },
          ]}
        />
        <SupportingDataEditor
          title="Distributions by Entity"
          entityName="Distribution"
          periodId={periodId}
          items={dists.items}
          reload={dists.reload}
          defaults={{ entity_name: 'New Entity' }}
          fields={[
            { key: 'entity_name', label: 'Entity', wide: true },
            { key: 'q1', label: 'Q1', type: 'number' },
            { key: 'q2', label: 'Q2', type: 'number' },
            { key: 'q3', label: 'Q3', type: 'number' },
            { key: 'q4', label: 'Q4', type: 'number' },
          ]}
        />
        <SupportingDataEditor
          title="Savings-Funded Expenses"
          entityName="SavingsSpend"
          periodId={periodId}
          items={savings.items}
          reload={savings.reload}
          defaults={{ category: 'New Category' }}
          fields={[
            { key: 'category', label: 'Category', wide: true },
            { key: 'ytd_amount', label: 'YTD amount', type: 'number' },
          ]}
        />
        <SupportingDataEditor
          title="Recurring Transfers"
          entityName="RecurringTransfer"
          periodId={periodId}
          items={transfers.items}
          reload={transfers.reload}
          defaults={{ purpose: 'New Transfer' }}
          fields={[
            { key: 'amount', label: 'Amount', type: 'number' },
            { key: 'source', label: 'Source' },
            { key: 'purpose', label: 'Purpose / Destination', wide: true },
          ]}
        />
      </TabsContent>

      <TabsContent value="transactions">
        <TransactionsEditor periodId={periodId} lines={lines.items} />
      </TabsContent>

      <TabsContent value="accounts">
        <AccountHierarchyManager />
      </TabsContent>

      <TabsContent value="import">
        <ImportHub />
      </TabsContent>

      <TabsContent value="review" className="space-y-5">
        <PublishPanel period={period} user={user} reload={reload} />
        <ReviewQueue periodId={periodId} />
      </TabsContent>

      <TabsContent value="periods">
        <PeriodsManager periods={periods} reload={reload} onSelect={setPeriodId} />
      </TabsContent>
    </Tabs>
  );
}