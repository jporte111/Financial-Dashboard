import { base44 } from '@/api/base44Client';

// Client for the periodTransition backend function -- the only supported way
// to finalize, publish, reopen or re-stage a reporting period. The rules are
// enforced on the server (base44/shared/publishGate.ts); a refusal comes back
// as { ok: false, blockers: [{ code, message, overridable }] } with nothing written.
export async function periodTransition(action, periodId, extra = {}) {
  try {
    const res = await base44.functions.invoke('periodTransition', { action, period_id: periodId, ...extra });
    return { ok: true, ...(res?.data ?? res) };
  } catch (e) {
    // Function calls reject with a raw AxiosError (body at e.response.data);
    // other SDK calls use Base44Error (body at e.data). Read both.
    const data = e?.response?.data ?? e?.data ?? {};
    return {
      ok: false,
      status: e?.response?.status ?? e?.status,
      blockers: Array.isArray(data.blockers) ? data.blockers : [],
      error: data.message || data.error || e?.message || 'Request failed',
    };
  }
}
