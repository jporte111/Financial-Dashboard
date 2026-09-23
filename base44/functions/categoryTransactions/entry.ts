import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { handleCategoryTransactionsRequest } from '../../shared/publicDashboardCore.ts';

// Signed-in category drill-down (admin Spending Detail). Admins can open any
// period, including drafts under review. Any other signed-in user gets exactly
// the public rules: published + final periods only, line resolved server-side,
// public row fields. The shared core reads only stored Transaction / Account
// records and always excludes QuickBooks-sourced records.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch { user = null; }
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { status, body: out } = await handleCategoryTransactionsRequest(base44, body, user);
    return Response.json(out, { status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
