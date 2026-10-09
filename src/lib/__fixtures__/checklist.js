// A fully confirmed checklist for a fixture period, built with the same
// fingerprints the server uses (base44/shared/checklistCore.ts). Fictional data.
import { CHECKLIST_KEYS, partHashes, warningCodes, confirmationRecord } from '../../../base44/shared/checklistCore.ts';

export function confirmedChecklist(period, lines = [], children = {}, by = 'admin@example.invalid', at = '2026-08-04T00:00:00Z') {
  const hashes = partHashes({ period, lines, ...children });
  const warnings = warningCodes(period, []);
  return {
    checklist: Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])),
    checklist_confirmations: Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, confirmationRecord(k, hashes, warnings, by, at)])),
  };
}

// Confirm every item through the real server action (one write each).
export async function confirmAll(handle, base44, periodId, user, now) {
  const out = [];
  for (const item of CHECKLIST_KEYS) out.push(await handle(base44, { action: 'confirm_checklist', period_id: periodId, item }, user, now));
  return out;
}
