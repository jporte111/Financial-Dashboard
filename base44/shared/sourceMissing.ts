// Missing source values without null.
//
// Base44 rejects `null` in number and string fields (HTTP 422), and its schema
// has no nullable types. So a missing value is never written as null -- and
// never as 0, which would read as a confirmed $0.00. Instead:
//
//   - on create, a missing field is simply left out (it reads back as absent);
//   - a ReportingPeriod also lists its missing fields by name in
//     `source_missing_fields`. That covers the one case omission cannot: a
//     re-import (or an admin edit) where a field that held a value becomes
//     missing, which Base44 cannot clear. Readers treat a listed field as
//     missing whatever number is stored.
//
// Child records (budget lines, cash accounts, ...) have no marker: when a
// re-import turns one of their values into a missing one, the import planner
// replaces the row instead (see src/lib/bvaImport.js).
//
// Shared by the browser code and the backend functions.

export const MISSING_MARKER = 'source_missing_fields';

export const markedMissing = (record) =>
  new Set(Array.isArray(record?.[MISSING_MARKER]) ? record[MISSING_MARKER].filter((f) => typeof f === 'string') : []);

const blank = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));

// Is this field's source value missing (absent, blank, or listed as missing)?
export const isSourceMissing = (record, field) => blank(record?.[field]) || markedMissing(record).has(field);

// The record as readers should see it: every listed field is null.
export function effectiveRecord(record) {
  const marked = markedMissing(record);
  if (!record || !marked.size) return record;
  const out = { ...record };
  for (const f of marked) out[f] = null;
  return out;
}

// A write payload Base44 accepts: null / undefined values are left out.
export const withoutNulls = (data) =>
  Object.fromEntries(Object.entries(data || {}).filter(([, v]) => v !== null && v !== undefined));

// Update a period's missing-field list for the fields this write owns: owned
// fields that are null become missing, owned fields with a value stop being
// missing, and fields owned by someone else keep their current status.
export function nextMissingList(current, ownedFields, data) {
  const out = new Set([...markedMissing(current)].filter((f) => !ownedFields.includes(f)));
  for (const f of ownedFields) if (data[f] === null || data[f] === undefined) out.add(f);
  return [...out].sort();
}
