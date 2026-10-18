// Phase 9a (B1): a publish request names the month and version the admin
// confirmed. Test helpers add it from the stored record, as the publish dialog
// does from the record it shows; tests of the guard itself pass `expect`.
import { publishExpectation } from '../../../base44/shared/periodVersions.ts';

// `entities`: the service's entities (tests) or an admin client's (scripts).
export async function withPublishExpect(entities, body) {
  if (body?.action !== 'publish' || 'expect' in body || !body.period_id) return body;
  let p = null;
  try { p = await entities.ReportingPeriod.get(body.period_id); } catch { p = null; }
  return p ? { ...body, expect: publishExpectation(p) } : body;
}
