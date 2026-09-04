import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import BvaImportCenter from '@/components/admin/BvaImportCenter';
import BvaReview from '@/components/admin/BvaReview';

// The BVA workbook is the only financial-data source for this app — there is
// no QuickBooks importer here any more. Two subtabs: importing a new monthly
// workbook, and reviewing past imports. The active subtab is kept in the URL
// (?import=bva|bva-review) so it is linkable and survives a reload.
const SUBTABS = [
  ['bva', 'BVA Import'],
  ['bva-review', 'BVA Review'],
];
const DEFAULT_SUBTAB = 'bva';

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
    </Tabs>
  );
}
