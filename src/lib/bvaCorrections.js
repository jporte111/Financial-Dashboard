// Corrections and override reasons for a BVA import draft.
//
// A correction is a recorded, reversible adjustment made in the BVA Import
// screen against a parsed workbook, persisted on the ReportingPeriod draft
// (bva_corrections) so it survives refreshes and failed finalization:
//
//   { id, kind, target, path, original_value, value, reason, by, at }
//     kind: 'source'       — a corrected workbook-extracted value (patched by path)
//           'zero_confirm' — a blank distribution quarter confirmed as $0 received
//           'transfer'     — a corrected transfer label (source / purpose)
//           'group'        — a watch-list category mapped to a budget group
//           'savings'      — a manually entered savings figure (not in the workbook)
//           'override'     — an override reason for an open reconciliation
//
// The original parsed workbook (bva_parsed_source) is never modified: the
// corrections are applied as a layer over it at read time, so dependent totals
// stay CALCULATED from the corrected primitives and validation is re-run
// against the adjusted workbook. A correction whose original value no longer
// matches the workbook at its path (the source changed) is skipped as stale.

// Same marker the shared backend module uses (frontend copy — src/ cannot
// import from base44/); see base44/shared/sourceMissing.ts.
const MISSING_MARKER = 'source_missing_fields';

const normCode = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The key a watch-list (DETAIL) row's confirmed group is stored and looked up
// by: its normalized account code, or -- for a row the workbook gives no code
// (an account without a QuickBooks number of its own) -- its exact normalized
// name, prefixed so it can never collide with a code (owner, 2026-10-18).
export const detailGroupKey = (code, name) => (normCode(code) ? normCode(code) : normCode(name) ? `name:${normCode(name)}` : '');

// Which workbook value a mismatch warning can be corrected against.
export const WARNING_SOURCE_PATHS = {
  cash_total_mismatch: 'cash.reportedTotal',
  income_actual_mismatch: 'income.reportedActualTotal',
  income_budget_workbook_mismatch: 'income.reportedBudgetTotal',
  expense_actual_mismatch: 'expenseSummary.reportedActualTotal',
  expense_budget_mismatch: 'expenseSummary.reportedBudgetTotal',
  transfers_total_mismatch: 'transfers.reportedTotal',
  distribution_workbook_total_corrected: 'distributions.reportedTotal',
  pace_proxy_divergence: 'expenseSummary.pacePctProxy',
};

export const SAVINGS_FIELDS = ['savings_in_ytd', 'savings_spend_ytd'];
export const GROUP_OPTIONS = ['unassigned', 'fixed', 'variable', 'discretionary', 'savings'];
const PATCH_KINDS = ['source', 'zero_confirm', 'transfer'];

export const correctionKey = (c) => `${c.kind}:${c.path || c.target || ''}`;

export function getPath(obj, path) {
  return String(path || '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Immutable set-by-path: clones only along the path.
export function setPath(root, path, value) {
  const keys = String(path || '').split('.');
  const walk = (node, i) => {
    if (i === keys.length) return value;
    const clone = Array.isArray(node) ? [...node] : { ...node };
    clone[keys[i]] = walk(node == null ? undefined : node[keys[i]], i + 1);
    return clone;
  };
  return walk(root, 0);
}

export function makeCorrection({ kind, target, path = null, originalValue = null, value, reason = '', by = '', at = null }) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    target: target == null ? null : String(target),
    path: path == null ? null : String(path),
    original_value: originalValue === undefined ? null : originalValue,
    value: value === undefined ? null : value,
    reason: String(reason || ''),
    by: String(by || ''),
    at: at || new Date().toISOString(),
  };
}

// Apply the corrections layer to a parsed workbook without mutating it. Later
// corrections for the same key win. A patch is skipped when the workbook value
// at its path no longer equals the original it was recorded against.
export function applyCorrections(parsed, corrections) {
  if (!parsed) return parsed;
  const byKey = new Map();
  for (const c of corrections || []) if (c && c.kind) byKey.set(correctionKey(c), c);
  let out = parsed;
  for (const c of byKey.values()) {
    if (!PATCH_KINDS.includes(c.kind) || !c.path) continue;
    if (getPath(out, c.path) !== c.original_value) continue; // stale: the workbook changed
    out = setPath(out, c.path, c.value);
  }
  return out;
}

export const isStaleCorrection = (parsed, c) =>
  !!c && PATCH_KINDS.includes(c.kind) && !!c.path && getPath(parsed, c.path) !== c.original_value;

// { warningCode: { reason, by, at } } — the same shape validateBva and the
// finalize transition expect.
export function overridesFromCorrections(corrections) {
  const out = {};
  for (const c of corrections || []) {
    if (c && c.kind === 'override' && c.target && c.reason && String(c.reason).trim()) {
      out[c.target] = { reason: String(c.reason).trim(), by: c.by || '', at: c.at || '' };
    }
  }
  return out;
}

// { normalizedCategoryCode: group } for watch-list detail rows.
export function groupMapFromCorrections(corrections) {
  const out = {};
  for (const c of corrections || []) {
    if (c && c.kind === 'group' && c.target && c.value && c.value !== 'unassigned') {
      out[normCode(c.target)] = c.value;
    }
  }
  return out;
}

// { savings_in_ytd?: number, savings_spend_ytd?: number } — only finite
// numbers count; an explicit 0 is a confirmed zero.
export function savingsFromCorrections(corrections) {
  const out = {};
  for (const c of corrections || []) {
    if (c && c.kind === 'savings' && SAVINGS_FIELDS.includes(c.target) && typeof c.value === 'number' && Number.isFinite(c.value)) {
      out[c.target] = c.value;
    }
  }
  return out;
}

// Merge the import plan's period write with the corrections layer: the stored
// parsed source stays the ORIGINAL workbook, savings entries become period
// values (and leave the missing list), and the corrections ride along so they
// survive Apply and Finalize.
export function periodWriteWithCorrections(plan, parsedOriginal, corrections) {
  const savings = savingsFromCorrections(corrections);
  const missing = new Set(plan?.periodWrite?.[MISSING_MARKER] || []);
  for (const f of Object.keys(savings)) missing.delete(f);
  return {
    ...plan?.periodWrite,
    ...savings,
    [MISSING_MARKER]: [...missing].sort(),
    bva_corrections: corrections || [],
    bva_parsed_source: parsedOriginal,
  };
}