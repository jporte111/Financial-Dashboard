import React from 'react';
import { usePeriodContext } from '@/lib/usePeriod';
import { useEntityByPeriod } from '@/lib/usePeriodEntities';
import SectionHeading from '@/components/SectionHeading';
import CashCard from '@/components/CashCard';
import { fmtCurrency } from '@/lib/finance';

export default function Cash() {
  const { period, periodId } = usePeriodContext();
  const { items: accounts } = useEntityByPeriod('CashAccount', periodId, 'sort_order');
  const list = accounts || [];
  const bank = list.filter((a) => a.account_type !== 'investment');
  const inv = list.filter((a) => a.account_type === 'investment');
  const sum = (arr) => arr.reduce((s, a) => s + Number(a.balance || 0), 0);

  return (
    <div className="space-y-10">
      <SectionHeading title="Cash" subtitle={`Balances as of ${period.label}`} />
      <CashCard total={period.total_cash} accounts={list} defaultOpen />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Bank Accounts</p>
          <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(sum(bank))}</p>
          <p className="text-sm text-stone-500">{bank.length} accounts</p>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Investment Accounts</p>
          <p className="mt-3 font-display text-2xl tabular-nums">{fmtCurrency(sum(inv))}</p>
          <p className="text-sm text-stone-500">{inv.length} accounts</p>
        </div>
      </div>
    </div>
  );
}