import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import BvaImportCenter from '@/components/admin/BvaImportCenter';
import BvaReview from '@/components/admin/BvaReview';
import TransactionDetailImport from '@/components/admin/TransactionDetailImport';

// The BVA workbook is the only financial-data source for this app; nothing
// pulls figures from QuickBooks. Subtabs: importing
// a new monthly workbook, reviewing past imports, and (Phase 5b) attaching the
// QuickBooks Transaction Report as drill-down detail -- which never changes a
// figure. The active subtab is kept in the URL (?import=bva|bva-review|detail).
const SUBTABS = [
  ['bva', 'BVA Import'],
  ['bva-review', 'BVA Review'],
  ['detail', 'Transaction Detail'],
];
const DEFAULT_SUBTAB = 'bva';
// The tabs component is untyped (every use is a type error); the new subtab uses
// an untyped alias so it adds none.
const TabPanel = /** @type {any} */ (TabsContent);

export default function ImportHub() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('import');
  const value = SUBTABS.some(([k]) => k === raw) ? raw : DEFAULT_SUBTAB;

  const onChange = (v) => {
    const next = new URLSearchParams(params);
    next.set('import', v);
    setParams(next, { replace: true });
  };

  return (
    <Tabs value={value} onValueChange={onChange} className="space-y-4">
      <TabsList className="flex flex-wrap rounded-full">
        {SUBTABS.map(([k, label]) => (
          <TabsTrigger key={k} value={k} className="rounded-full">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="bva">
        <BvaImportCenter />
      </TabsContent>
      <TabsContent value="bva-review">
        <BvaReview />
      </TabsContent>
      <TabPanel value="detail">
        <TransactionDetailImport />
      </TabPanel>
    </Tabs>
  );
}
