import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

// Loads a category drill-down from a backend function and reports WHAT
// happened, so a failed request is never shown as "no transactions":
//   loading      the request is in flight
//   error        the request failed (after one automatic retry for a transient
//                failure); `error` holds a message and `retry()` tries again
//   unavailable  the server answered: transaction detail is not offered here
//   empty        the server answered: no transactions for this category
//   rows         `rows` holds the transactions
// `data` is the whole answer (e.g. the Phase 5b reconciliation note).
export const drilldownOptions = { retryDelayMs: 800 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e) => e?.response?.status ?? e?.status;
// No response, a rate limit or a server error: worth one more try.
const transient = (e) => { const s = statusOf(e); return s === undefined || s === 429 || s >= 500; };
const messageOf = (e) => e?.response?.data?.error || e?.data?.error || 'Transaction detail could not be loaded.';

export function useDrilldownTransactions(fnName, body, deps) {
  const [state, setState] = useState({ status: 'loading', rows: [], error: null, data: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!body) return undefined;
    let cancelled = false;
    setState({ status: 'loading', rows: [], error: null, data: null });
    (async () => {
      for (let tries = 1; ; tries += 1) {
        try {
          const res = await base44.functions.invoke(fnName, body);
          const data = res?.data ?? res ?? {};
          const rows = Array.isArray(data.transactions) ? data.transactions : [];
          if (cancelled) return;
          if (data.detail_available === false) setState({ status: 'unavailable', rows: [], error: null, data });
          else setState({ status: rows.length ? 'rows' : 'empty', rows, error: null, data });
          return;
        } catch (e) {
          if (cancelled) return;
          if (tries < 2 && transient(e)) { await sleep(drilldownOptions.retryDelayMs); continue; }
          setState({ status: 'error', rows: [], error: messageOf(e), data: null });
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [...deps, attempt]);

  return { ...state, retry };
}
