import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import BvaImportCenter from '@/components/admin/BvaImportCenter';
import BvaReview from '@/components/admin/BvaReview';
import ImportCenter from '@/components/admin/ImportCenter';

// Single "Import" area with three subtabs. The BVA workflow and the legacy
// QuickBooks importer are both reachable here; neither replaces the other.
// The active subtab is kept in the URL (?import=bva|bva-review|quickbooks) so
// it is linkable and survives a reload.
const SUBTABS = [
  ['bva', 'BVA Import'],
  ['bva-review', 'BVA Review'],
  ['quickbooks', 'QuickBooks Import'],
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
      <TabsContent value="quickbooks">
        <ImportCenter />
      </TabsContent>
    </Tabs>
  );
}
