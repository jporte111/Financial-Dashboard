import React from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import CashCard from '@/components/CashCard';
import { fmtCurrency, isMissingNumber, formatDateOnly } from '@/lib/finance';
import { effectiveRecord } from '../../base44/shared/sourceMissing.ts';

export default function Cash() {
  const { period, periodId } = usePeriodContext();
  const { items: accounts } = useEntityByPeriod('CashAccount', periodId, 'sort_order');
  const list = accounts || [];
  const bank = list.filter((a) => a.account_type !== 'investment');
  const inv = list.filter((a) => a.account_type === 'investment');
  // Known balances only; a subtotal that leaves out a missing balance says so.
  const sum = (arr) => {
    const knownRows = arr.filter((a) => !isMissingNumber(a.balance));
    return { value: knownRows.length ? knownRows.reduce((s, a) => s + Number(a.balance), 0) : null, partial: knownRows.length < arr.length };
  };
  const bankSum = sum(bank);
  const invSum = sum(inv);
  const totalCash = effectiveRecord(period || {}).total_cash;

  return (
    <div className="space-y-10">
      <SectionHeading
        title="Cash"
        subtitle={period?.reporting_cutoff_date ? `${period.label} report · balances as of ${formatDateOnly(period.reporting_cutoff_date)}` : `${period.label} report`}
      />
      <CashCard total={totalCash} reportedTotal={period?.printed_totals === true ? totalCash : null} accounts={list} defaultOpen />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Bank Accounts</p>
          <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(bankSum.value)}</p>
          {bankSum.partial && bankSum.value != null && <p className="text-xs text-amber-700">Partial — an account has no balance in the source</p>}
          <p className="text-sm text-stone-500">{bank.length} accounts</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Investment Accounts</p>
          <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(invSum.value)}</p>
          {invSum.partial && invSum.value != null && <p className="text-xs text-amber-700">Partial — an account has no balance in the source</p>}
          <p className="text-sm text-stone-500">{inv.length} accounts</p>
        </div>
      </div>
    </div>
  );
}