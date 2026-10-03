import React, { useEffect, useState, useMemo } from 'react';
import { numericInput, BLANK_INPUT_HINT } from '@/lib/finance';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus, ChevronRight, ChevronDown } from 'lucide-react';
import { buildTree } from '@/lib/rollup';

const GROUPS = ['fixed', 'variable', 'discretionary', 'income', 'savings'];

function Row({ account, accounts, depth, childrenOf, onPatch, onDelete, onToggle }) {
  const [open, setOpen] = useState(true);
  const kids = childrenOf[account.id] || [];
  const budgetParent = account.budget_parent_id
    ? accounts.find((a) => a.id === account.budget_parent_id)
    : null;
  const indent = { paddingLeft: `${depth * 20 + 16}px` };

  return (
    <>
      <div className="grid items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/50 p-3 md:grid-cols-12" style={indent}>
        <div className="md:col-span-4 flex items-center gap-2">
          {kids.length > 0 ? (
            <button onClick={() => setOpen(!open)} className="p-1 text-stone-400 hover:text-stone-700">
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-[24px]" />
          )}
          <div>
            <p className="text-sm font-medium leading-tight">{account.account_name}</p>
            <p className="text-[11px] text-stone-400">{account.full_account_path || account.account_code || '—'}</p>
          </div>
        </div>
        <div className="md:col-span-3">
          <Select value={account.budget_parent_id || 'none'} onValueChange={(v) => onPatch(account.id, { budget_parent_id: v === 'none' ? null : v })}>
            <SelectTrigger className="bg-white h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— rolls into self —</SelectItem>
              {accounts.filter((a) => a.id !== account.id && a.has_own_budget).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.account_name}{a.account_code ? ` (${a.account_code})` : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <Select value={account.top_level_group} onValueChange={(v) => onPatch(account.id, { top_level_group: v })}>
            <SelectTrigger className="bg-white h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{GROUPS.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="md:col-span-1">
          <Input className="bg-white h-8 text-xs" type="number" step="0.01" defaultValue={account.annual_budget ?? ''} title={BLANK_INPUT_HINT} onBlur={(e) => { const v = numericInput(e.target.value); if (v != null && v !== account.annual_budget) onPatch(account.id, { annual_budget: v }); }} />
        </div>
        <div className="md:col-span-1 flex items-center gap-2">
          <button
            onClick={() => onToggle(account, 'has_own_budget')}
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${account.has_own_budget ? 'bg-stone-900 text-white' : 'bg-stone-200 text-stone-500'}`}
            title="Has its own budget"
          >
            {account.has_own_budget ? 'Budget' : 'Rolls up'}
          </button>
        </div>
        <div className="md:col-span-1 flex items-center justify-end gap-2">
          <button
            onClick={() => onToggle(account, 'active')}
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${account.active ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-100 text-stone-400'}`}
            title={account.active ? 'Active' : 'Inactive'}
          >
            {account.active ? 'On' : 'Off'}
          </button>
          <button onClick={() => onDelete(account.id)} className="p-1.5 text-stone-300 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      {open && kids.map((k) => (
        <Row key={k.id} account={k} accounts={accounts} depth={depth + 1} childrenOf={childrenOf} onPatch={onPatch} onDelete={onDelete} onToggle={onToggle} />
      ))}
    </>
  );
}

export default function AccountHierarchyManager() {
  const [accounts, setAccounts] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => { base44.entities.Account.list('account_code').then(setAccounts); };
  useEffect(load, []);

  const { roots, childrenOf } = useMemo(() => (accounts ? buildTree(accounts) : { roots: [], childrenOf: {} }), [accounts]);

  const patch = async (id, data) => { await base44.entities.Account.update(id, data); load(); };
  const toggle = async (account, field) => { await base44.entities.Account.update(account.id, { [field]: !account[field] }); load(); };
  const remove = async (id) => { await base44.entities.Account.delete(id); load(); };
  const add = async () => {
    setBusy(true);
    await base44.entities.Account.create({ account_name: 'New Account', top_level_group: 'discretionary', account_type: 'expense' });
    setBusy(false);
    load();
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-display text-lg">Account Hierarchy</p>
          <p className="text-xs text-stone-400">Set each account's budget parent and whether it carries its own budget. Subaccount activity rolls up to its budget parent.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="rounded-full" onClick={add} disabled={busy}><Plus className="mr-1 h-4 w-4" /> Add Account</Button>
        </div>
      </div>

      <div className="mt-5 hidden grid-cols-12 gap-2 border-b border-stone-100 px-3 pb-2 text-[11px] uppercase tracking-[0.12em] text-stone-400 md:grid">
        <span className="col-span-4">Account</span>
        <span className="col-span-3">Budget Parent</span>
        <span className="col-span-2">Top-level Group</span>
        <span className="col-span-1">Annual Budget</span>
        <span className="col-span-2 text-right">Budget / Roll-up · Active</span>
      </div>

      <div className="mt-2 space-y-2">
        {!accounts ? (
          <p className="py-8 text-sm text-stone-400">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="py-8 text-sm text-stone-500">No accounts yet. Add one manually, or they'll appear here from historical records.</p>
        ) : (
          roots.map((a) => (
            <Row key={a.id} account={a} accounts={accounts} depth={0} childrenOf={childrenOf} onPatch={patch} onDelete={remove} onToggle={toggle} />
          ))
        )}
      </div>
    </div>
  );
}