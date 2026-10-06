// An in-memory Base44 service role for server tests (fictional data only).
// Every write is logged in order. `hook(entity, op, args, phase)` may throw:
// phase 'before' = the write is refused; 'after' = it happened, the response
// was lost.
export const ENTITIES = ['ReportingPeriod', 'BudgetLine', 'CashAccount', 'Distribution', 'RecurringTransfer', 'SavingsSpend', 'Transaction', 'Account'];
const clone = (x) => (x === undefined ? x : structuredClone(x));

export function fakeService(seed = {}, { hook = null } = {}) {
  const tables = Object.fromEntries(ENTITIES.map((e) => [e, new Map((seed[e] || []).map((r) => [r.id, clone(r)]))]));
  const log = [];
  let n = 0;
  const run = async (entity, op, args, phase) => { if (hook) await hook(entity, op, args, phase); };
  const rejectNulls = (data) => {
    const k = Object.keys(data).find((key) => data[key] === null);
    if (k) throw Object.assign(new Error(`Error in field ${k}: Input should be a valid string`), { status: 422 });
  };
  const matches = (r, q) => Object.entries(q || {}).every(([k, v]) => r[k] === v);
  const entity = (name) => ({
    get: async (id) => {
      const r = tables[name].get(id);
      if (!r) throw Object.assign(new Error('Object not found'), { status: 404 });
      return clone(r);
    },
    filter: async (q) => [...tables[name].values()].filter((r) => matches(r, q)).map(clone),
    list: async () => [...tables[name].values()].map(clone),
    create: async (data) => {
      await run(name, 'create', { data }, 'before');
      rejectNulls(data);
      const rec = { ...clone(data), id: `${name}-${++n}`, created_date: new Date(Date.UTC(2026, 9, 6, 0, 0, n)).toISOString() };
      tables[name].set(rec.id, rec);
      log.push({ entity: name, op: 'create', id: rec.id, data: clone(data) });
      await run(name, 'create', { data, id: rec.id }, 'after');
      return clone(rec);
    },
    bulkCreate: async (list) => {
      await run(name, 'bulkCreate', { list }, 'before');
      const out = [];
      for (const data of list) {
        rejectNulls(data);
        const rec = { ...clone(data), id: `${name}-${++n}`, created_date: new Date(Date.UTC(2026, 9, 6, 0, 0, n)).toISOString() };
        tables[name].set(rec.id, rec);
        out.push(clone(rec));
      }
      log.push({ entity: name, op: 'bulkCreate', count: list.length });
      await run(name, 'bulkCreate', { list }, 'after');
      return out;
    },
    update: async (id, data) => {
      await run(name, 'update', { id, data }, 'before');
      rejectNulls(data);
      if (!tables[name].has(id)) throw Object.assign(new Error('Object not found'), { status: 404 });
      Object.assign(tables[name].get(id), clone(data));
      log.push({ entity: name, op: 'update', id, data: clone(data) });
      await run(name, 'update', { id, data }, 'after');
    },
    delete: async (id) => {
      await run(name, 'delete', { id }, 'before');
      if (!tables[name].has(id)) throw Object.assign(new Error('Object not found'), { status: 404 });
      tables[name].delete(id);
      log.push({ entity: name, op: 'delete', id });
      await run(name, 'delete', { id }, 'after');
    },
  });
  const svc = { entities: Object.fromEntries(ENTITIES.map((e) => [e, entity(e)])) };
  return { base44: { asServiceRole: svc }, tables, log, rows: (name) => [...tables[name].values()] };
}
