import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { decisionOptions, applyWarningDecision, MIN_REASON } from '@/lib/warningDecisions';
import { parseBlankQuarters } from '@/lib/bvaDashboard';

const btn =
  'rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] transition disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = `${btn} border-stone-900 bg-stone-900 text-white hover:bg-stone-700`;
const btnGhost = `${btn} border-stone-200 bg-white text-stone-500 hover:bg-stone-100 hover:text-stone-700`;
const input =
  'w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none';

// Inline decision controls for one unresolved validation warning: the admin
// records the decision (and the required written reason) right here, without
// leaving the Dashboard.
export default function WarningDecision({ warning, period }) {
  const options = decisionOptions(warning);
  const [open, setOpen] = useState(null); // the chosen decision mode, when its form is expanded
  const [reason, setReason] = useState('');
  const [amounts, setAmounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!options.length || !period) return null;
  const blanks = parseBlankQuarters(warning.message);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applyWarningDecision({ period, warning, mode: open, reason, amounts });
      // Reopen -> write -> finalize -> (re)publish all happened; reload so
      // every section re-derives from the fresh records.
      window.location.reload();
    } catch (e) {
      setError(e?.message || 'The decision could not be applied.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      {open === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {options.map((o) => (
            <button key={o.mode} className={o.mode === 'confirm_zero' ? btnPrimary : btnGhost} onClick={() => { setOpen(o.mode); setError(null); }}>
              {o.label}
            </button>
          ))}
          <Link to="/admin" className="text-xs font-medium uppercase tracking-[0.14em] text-stone-400 underline decoration-stone-300 underline-offset-4 hover:text-stone-700">
            Open Admin
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            {open === 'confirm_zero'
              ? 'Confirm none was received'
              : open === 'enter_amounts'
                ? 'Enter the amounts received'
                : 'Accept this exception'}
          </p>
          {open === 'enter_amounts' && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {blanks.map(({ entity, quarter }) => (
                <label key={`${entity}:${quarter}`} className="block">
                  <span className="text-xs text-stone-500">
                    {entity} · {quarter.toUpperCase()}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className={`${input} mt-1`}
                    value={amounts[`${entity}:${quarter}`] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [`${entity}:${quarter}`]: e.target.value })}
                    placeholder="0.00"
                  />
                </label>
              ))}
            </div>
          )}
          <label className="mt-3 block">
            <span className="text-xs text-stone-500">
              Reason (required, at least {MIN_REASON} characters — recorded on the period&apos;s audit trail)
            </span>
            <textarea
              rows={2}
              className={`${input} mt-1`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                open === 'confirm_zero'
                  ? 'e.g. Confirmed with the client: no Sample Bank distributions were received in Q1 or Q2.'
                  : open === 'enter_amounts'
                    ? 'e.g. Amounts confirmed against the receiving account statements.'
                    : 'e.g. Discrepancy reviewed and accepted; the calculated figure is correct.'
              }
            />
          </label>
          {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button className={btnPrimary} onClick={apply} disabled={busy}>
              {busy ? 'Applying…' : open === 'enter_amounts' ? 'Record amounts' : 'Apply decision'}
            </button>
            <button className={btnGhost} onClick={() => { setOpen(null); setError(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
          <p className="mt-2 text-xs text-stone-400">
            Applying this reopens the period (logged), writes the decision, and finalizes{period.published ? ' and re-publishes' : ''} it again.
          </p>
        </div>
      )}
    </div>
  );
}