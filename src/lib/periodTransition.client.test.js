// @vitest-environment jsdom
// The client helper must surface the server's refusal reasons. Function calls
// reject with a raw AxiosError (body at error.response.data), unlike entity
// calls (Base44Error, body at error.data) -- observed on a local Base44 server.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let invoke;
vi.mock('@/api/base44Client', () => ({ base44: { functions: { invoke: (...a) => invoke(...a) } } }));
import { periodTransition } from './periodTransition.js';

const blockers = [{ code: 'not_final', message: 'Only a finalized period can be published.', overridable: false }];

describe('periodTransition client helper', () => {
  beforeEach(() => { invoke = null; });

  it('returns the server response on success', async () => {
    invoke = async () => ({ data: { ok: true, action: 'publish', period_id: 'p1' } });
    expect(await periodTransition('publish', 'p1')).toMatchObject({ ok: true, period_id: 'p1' });
  });

  it('reads blockers from an AxiosError (function calls)', async () => {
    invoke = async () => { throw Object.assign(new Error('Request failed with status code 409'), { name: 'AxiosError', status: 409, response: { status: 409, data: { ok: false, blockers } } }); };
    expect(await periodTransition('publish', 'p1')).toEqual({ ok: false, status: 409, blockers, error: 'Request failed with status code 409' });
  });

  it('reads blockers from a Base44Error (e.data)', async () => {
    invoke = async () => { throw Object.assign(new Error('x'), { status: 409, data: { blockers } }); };
    expect((await periodTransition('publish', 'p1')).blockers).toEqual(blockers);
  });

  it('surfaces a server error message when there are no blockers', async () => {
    invoke = async () => { throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { ok: false, error: 'initialization_failed', message: 'The period could not be initialized and was removed. Nothing was created.' } } }); };
    const r = await periodTransition('create', null, { data: {} });
    expect(r).toMatchObject({ ok: false, status: 500, blockers: [] });
    expect(r.error).toMatch(/could not be initialized/);
  });
});
