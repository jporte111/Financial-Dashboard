import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

export function useEntityByPeriod(entityName, periodId, sort) {
  const [items, setItems] = useState(null);
  const load = () => {
    if (!periodId) return;
    setItems(null);
    base44.entities[entityName].filter({ period_id: periodId }, sort).then(setItems);
  };
  useEffect(load, [entityName, periodId, sort]);
  return { items, reload: load };
}