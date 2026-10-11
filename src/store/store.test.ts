// The data layer end to end, without React: FinanzasStores + QueryClient + the real HTTP client on top of a fake fetch.
// The "server" has two users, each with their own data, and records which X-User header each request arrives with.

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { balances, monthCalc } from '../../shared/calc';
import { seedState, setBudgets } from '../../shared/seed';
import type { AppState, AppUser, Month } from '../../shared/types';
import { USER_HEADER } from '../../shared/users';
import { createApiClient } from '../api/client';
import type { FetchLike } from '../api/client';
import { createActions } from './actions';
import type { Flows } from './actions';
import { FinanzasStores, stateKey } from './store';
import type { FinanzasStore, SaveFailure } from './store';

const OCT = '2026-10';
const FRANK: AppUser = { id: 'frank', name: 'Frank' };
const EDA: AppUser = { id: 'eda', name: 'Eda' };

interface Call {
  method: string;
  path: string;
  /** X-User header it arrived with. */
  user: string | null;
  body: unknown;
  keepalive: boolean;
  ok(): void;
  fail(status: number, code: string): void;
  /** No response: network failure. */
  drop(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Lets promises and 0 ms timers run. */
const tick = () => vi.advanceTimersByTimeAsync(0);

/** Eda starts with the same sample data (same row ids, on purpose) but in Turkish and with a different budget. */
function edaState(): AppState {
  const state = seedState();
  state.language = 'tr';
  setBudgets(state.months[OCT]!, { dr: 50000 });
  return state;
}

async function setup() {
  const server = { state: seedState(), eda: edaState(), gets: 0, holdGets: false };
  /** Writes received; each test decides when and how the "server" responds. */
  const calls: Call[] = [];
  const heldGets: (() => void)[] = [];

  const fetchImpl: FetchLike = (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const method = init.method ?? 'GET';
      const user = new Headers(init.headers).get(USER_HEADER);
      if (method === 'GET' && input === '/api/state') {
        server.gets++;
        const owner = user === EDA.id ? EDA : FRANK;
        const snapshot: AppState = structuredClone(owner === EDA ? server.eda : server.state);
        const respond = () => resolve(json(200, { user: owner, state: snapshot }));
        if (server.holdGets) heldGets.push(respond);
        else respond();
        return;
      }
      calls.push({
        method,
        path: input,
        user,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        keepalive: init.keepalive === true,
        ok: () => resolve(json(200, { ok: true })),
        fail: (status, code) => resolve(json(status, { error: { code, message: 'rejected' } })),
        drop: () => reject(new TypeError('fetch failed')),
      });
    });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stores = new FinanzasStores(qc, createApiClient(fetchImpl));
  const store = stores.for(FRANK.id);
  // An observer, like the app's useQuery: without it invalidateQueries does not refetch anything.
  const observers: (() => void)[] = [];
  const watch = (s: FinanzasStore) => {
    observers.push(new QueryObserver(qc, { queryKey: s.key, queryFn: s.queryFn }).subscribe(() => {}));
  };
  watch(store);
  const failures: SaveFailure[] = [];
  stores.onError((f) => failures.push(f));
  await tick();

  return {
    server,
    calls,
    heldGets,
    qc,
    stores,
    store,
    failures,
    view: () => store.state!,
    tx: (i: number) => store.state!.months[OCT]!.tx[i]!,
    fixed: (name: string) => store.state!.months[OCT]!.fixed.find((f) => f.name === name)!,
    summary: () => calls.map((c) => `${c.method} ${c.path}`),
    /** Switches user like the app: stops watching the previous one and loads the other. Returns its store, already loaded. */
    async switchTo(user: AppUser) {
      observers.splice(0).forEach((stop) => stop());
      const next = stores.for(user.id);
      watch(next);
      await tick();
      return next;
    },
    dispose: () => {
      observers.forEach((stop) => stop());
      qc.clear();
    },
  };
}

let h: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  vi.useFakeTimers();
  h = await setup();
});

afterEach(() => {
  h.dispose();
  vi.useRealTimers();
});

describe('loading', () => {
  it('fetches the state once and leaves it in the cache under ["state", user]', () => {
    expect(h.server.gets).toBe(1);
    expect(h.view()).toEqual(seedState());
    expect(h.store.key).toEqual(['state', 'frank']);
    expect(h.qc.getQueryData(stateKey('frank'))).toEqual({ user: FRANK, state: seedState() });
    expect(h.store.pendingCount).toBe(0);
  });

  it('requests the state with the header of its user', async () => {
    const seen: (string | null)[] = [];
    const api = createApiClient(async (_url, init = {}) => {
      seen.push(new Headers(init.headers).get(USER_HEADER));
      return json(200, { user: EDA, state: edaState() });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const eda = new FinanzasStores(qc, api).for('eda');
    await qc.fetchQuery({ queryKey: eda.key, queryFn: eda.queryFn });
    expect(seen).toEqual(['eda']);
    expect(eda.state!.language).toBe('tr');
    qc.clear();
  });
});

describe('cell edits', () => {
  it('show at once and go out together, in one PATCH per row, after the delay', async () => {
    const id = h.tx(0).id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'Compra' } });
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'Compra quincenal' } });
    h.store.dispatch({ type: 'tx/patch', id, patch: { amount: 5000 } });

    expect(h.tx(0)).toMatchObject({ desc: 'Compra quincenal', amount: 5000 });
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/transactions/${id}`,
      body: { desc: 'Compra quincenal', amount: 5000 },
      keepalive: false,
    });
  });

  it('checkbox and select go out without waiting', () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(1).id, patch: { cat: 'Travel' } });
    expect(h.summary()).toEqual([`PATCH /api/fixed/${netflix.id}`]);
    expect(h.calls[0]!.body).toEqual({ paid: true });
    expect(h.fixed('Netflix').paid).toBe(true);
    // The second one waits for the first to be answered (see "order").
    expect(h.store.pendingCount).toBe(2);
  });

  it('a checkbox takes along whatever the row had waiting', () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { amount: 1200 } });
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ amount: 1200, paid: true });
  });

  it('flush() sends right away what was waiting for its delay', () => {
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000 } } });
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { us: 500 } } });
    expect(h.calls).toEqual([]);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/months/${OCT}`, body: { budgets: { dr: 80000, us: 500 } } });
  });

  it('an empty patch does nothing', () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: {} });
    expect(h.store.pendingCount).toBe(0);
  });
});

describe('order', () => {
  it('requests go out one at a time, in the order of the edits', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/remove', id: h.fixed('Smartfit').id });
    expect(h.calls).toHaveLength(1);

    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/fixed/${netflix.id}`, `PATCH /api/fixed/${cluely.id}`]);

    h.calls[1]!.ok();
    await tick();
    expect(h.calls[2]).toMatchObject({ method: 'DELETE' });
  });

  it('the creation of a row arrives before its edit', async () => {
    const actions = createActions(h.store, OCT, {} as Flows, () => 'tx-new');
    expect(actions.addTx({ date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Card', amount: 850, cur: 'DOP' })).toBe(true);
    actions.patchTx('tx-new', { notes: 'aeropuerto' });
    h.store.flush();

    expect(h.summary()).toEqual(['POST /api/transactions']);
    expect(h.calls[0]!.body).toEqual({
      id: 'tx-new',
      monthKey: OCT,
      date: '2026-10-07',
      desc: 'Uber',
      place: '',
      cat: 'Transport',
      method: 'Card',
      amount: 850,
      cur: 'DOP',
      accountId: 'dr',
      notes: '',
    });
    expect(h.view().months[OCT]!.tx.at(-1)).toMatchObject({ id: 'tx-new', notes: 'aeropuerto' });

    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/transactions', 'PATCH /api/transactions/tx-new']);
  });
});

describe('failures', () => {
  it('undoes only the rejected change and reports it', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });

    h.calls[0]!.fail(409, 'month_closed');
    await tick();

    expect(h.fixed('Netflix').paid).toBe(false);
    expect(h.fixed('Cluely').paid).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.action).toMatchObject({ type: 'fixed/patch', id: netflix.id });
    expect(h.failures[0]!.error).toMatchObject({ name: 'ApiError', status: 409, code: 'month_closed', message: 'rejected' });
    expect(h.failures[0]!.userId).toBe('frank');
  });

  it('a network failure is undone too', async () => {
    const before = h.tx(0).desc;
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'otra cosa' } });
    h.store.flush();
    h.calls[0]!.drop();
    await tick();
    expect(h.tx(0).desc).toBe(before);
    expect(h.failures[0]!.error).toMatchObject({ name: 'NetworkError' });
  });

  it('if the row could not be created, what was queued behind it for that row is not sent', async () => {
    const actions = createActions(h.store, OCT, {} as Flows, () => 'fx-new');
    actions.addFixed({ name: 'Spotify', amount: 6, cur: 'USD' });
    actions.patchFixed('fx-new', { paid: true });
    actions.patchFixed('fx-new', { name: 'Spotify Duo' });
    expect(h.store.pendingCount).toBe(3);

    h.calls[0]!.fail(400, 'validation');
    await tick();

    expect(h.summary()).toEqual(['POST /api/fixed']);
    expect(h.view().months[OCT]!.fixed.some((f) => f.id === 'fx-new')).toBe(false);
    expect(h.failures).toHaveLength(1);
    expect(h.store.pendingCount).toBe(0);
  });

  it('deleting something the server no longer has counts as done', async () => {
    const id = h.tx(0).id;
    const month = h.server.state.months[OCT]!;
    month.tx = month.tx.filter((t) => t.id !== id);
    h.store.dispatch({ type: 'tx/remove', id });
    // Even before the refresh that follows confirms it, the row does not come back.
    h.server.holdGets = true;
    h.calls[0]!.fail(404, 'not_found');
    await tick();
    expect(h.failures).toEqual([]);
    expect(h.view().months[OCT]!.tx.some((t) => t.id === id)).toBe(false);
    h.heldGets[0]!();
    await tick();
    expect(h.view().months[OCT]!.tx.some((t) => t.id === id)).toBe(false);
  });

  it('deleting a row discards the edit it had waiting', async () => {
    const id = h.tx(0).id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'a medias' } });
    h.store.dispatch({ type: 'tx/remove', id });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.summary()).toEqual([`DELETE /api/transactions/${id}`]);
  });
});

describe('refetch', () => {
  it('invalidates its query only once, when nothing is pending anymore', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Cluely').id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'x' } });

    h.calls[0]!.ok();
    await tick();
    h.calls[1]!.ok();
    await tick();
    // The text edit is still waiting for its delay: nothing is requested yet.
    expect(h.server.gets).toBe(1);

    await vi.advanceTimersByTimeAsync(400);
    h.calls[2]!.ok();
    await tick();
    expect(h.server.gets).toBe(2);
    expect(h.store.pendingCount).toBe(0);
  });

  it('also refetches after a failure', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.calls[0]!.fail(500, 'internal');
    await tick();
    expect(h.server.gets).toBe(2);
  });

  it('a refetch does not overwrite unconfirmed edits', async () => {
    const id = h.tx(0).id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'sin guardar' } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });

    // A refresh arrives (e.g. on returning to the tab) with something new from the server and without our edits.
    setBudgets(h.server.state.months[OCT]!, { dr: 75000 });
    await h.store.refetch();

    expect(h.server.gets).toBe(2);
    expect(h.view().months[OCT]!.budgets.dr).toBe(75000);
    expect(h.tx(0).desc).toBe('sin guardar');
    expect(h.fixed('Netflix').paid).toBe(true);
  });

  it('an edit cancels the in-flight GET: its response no longer reaches the cache', async () => {
    setBudgets(h.server.state.months[OCT]!, { dr: 1 });
    h.server.holdGets = true;
    const refetch = h.store.refetch();
    await tick();
    expect(h.heldGets).toHaveLength(1);

    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'nueva' } });
    h.heldGets[0]!();
    await refetch;
    await tick();

    // The snapshot from that GET (budget 1) was dropped along the way…
    expect(h.tx(0).desc).toBe('nueva');
    expect(h.view().months[OCT]!.budgets.dr).toBe(70000);

    // …and what is new on the server arrives with the refresh after saving.
    h.server.holdGets = false;
    h.store.flush();
    h.calls[0]!.ok();
    await tick();
    expect(h.view().months[OCT]!.budgets.dr).toBe(1);
  });

  it('discards the snapshot of a GET that started before an already confirmed write', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });

    // The GET goes out with the first write still in flight: its snapshot does not include it.
    h.server.holdGets = true;
    void h.store.refetch();
    await tick();
    h.calls[0]!.ok();
    await tick();
    h.heldGets[0]!();
    await tick();
    expect(h.fixed('Netflix').paid).toBe(true);

    // And the base did not go back either: when the second one is undone, the first is still there.
    h.calls[1]!.fail(500, 'internal');
    await tick();
    expect(h.fixed('Netflix').paid).toBe(true);
    expect(h.fixed('Cluely').paid).toBe(false);
  });
});

describe('settle and page close', () => {
  it('settle() sends what is pending and waits for the server to answer everything', async () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'x' } });
    let settled = false;
    void h.store.settle().then(() => {
      settled = true;
    });
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(settled).toBe(false);

    h.calls[0]!.ok();
    await tick();
    expect(settled).toBe(true);
  });

  it('settle() with nothing pending resolves right away', async () => {
    await expect(h.store.settle()).resolves.toBeUndefined();
  });

  it('on page close it fires everything all at once, with keepalive', () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Cluely').id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'última' } });
    expect(h.calls).toHaveLength(1);

    h.store.flush({ unload: true });
    expect(h.calls).toHaveLength(3);
    expect(h.calls.map((c) => c.keepalive)).toEqual([false, true, true]);
  });

  it('applyServer merges in what the server returned while keeping what is pending', () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'pendiente' } });
    h.store.applyServer((s) => ({ ...s, defaultRate: 60 }));
    expect(h.view().defaultRate).toBe(60);
    expect(h.tx(0).desc).toBe('pendiente');
  });
});

describe('actions', () => {
  const flows = {} as Flows;

  it('an invalid row is neither added nor sent', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.addTx({ date: '2026-10-07', desc: '', cat: 'Food', method: 'Card', amount: 10, cur: 'DOP' })).toBe(false);
    expect(actions.addFixed({ name: 'Gym', amount: 0, cur: 'DOP' })).toBe(false);
    expect(actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP', accountId: 'gone' })).toBe(false);
    expect(actions.addTransfer({ date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 0, rate: 58 })).toBe(false);
    expect(actions.addTransfer({ date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'us', amount: 100 })).toBe(false);
    expect(actions.addTransfer({ date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'gone', amount: 100 })).toBe(false);
    expect(actions.addIncome({ date: '2026-10-07', amount: 0, cur: 'USD' })).toBe(false);
    expect(actions.addIncome({ date: '2026-10-07', amount: 100, cur: 'USD', accountId: 'gone' })).toBe(false);
    expect(actions.addContribution({ goalId: 'emergency', date: '2026-10-07', amount: 0, cur: 'USD' })).toBe(false);
    expect(actions.addAccount({ name: ' ', currency: 'USD' })).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.view()).toEqual(seedState());
  });

  it('new rows go to the selected month with a client id', () => {
    let n = 0;
    const actions = createActions(h.store, '2026-10', flows, () => `id-${++n}`);
    expect(actions.addTransfer({ date: '2026-10-08', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 200, rate: 57.5 })).toBe(true);
    expect(actions.addContribution({ goalId: 'personal', date: '2026-10-08', amount: 100, cur: 'USD' })).toBe(true);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/transfers' });
    expect(h.calls[0]!.body).toEqual({
      id: 'id-1',
      monthKey: OCT,
      date: '2026-10-08',
      via: 'PayPal',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 200,
      rate: 57.5,
      budget: false,
      fee: 0,
    });
    expect(h.view().contribs.at(-1)).toEqual({ id: 'id-2', goalId: 'personal', date: '2026-10-08', amount: 100, cur: 'USD', rate: null, accountId: null });
  });

  it('generates a UUID by default', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' });
    expect((h.calls[0]!.body as { id: string }).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reopenMonth reopens the selected month or the one passed to it', () => {
    createActions(h.store, '2026-09', flows).reopenMonth();
    createActions(h.store, OCT, flows).reopenMonth('2026-08');
    expect(h.view().months['2026-09']!.closed).toBe(false);
    expect(h.view().months['2026-08']!.closed).toBe(false);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/months/2026-09/reopen' });
  });

  it('a blank item or description is not saved; the rest of the patch is', () => {
    const actions = createActions(h.store, OCT, flows);
    const tx = h.tx(0);
    const netflix = h.fixed('Netflix');
    actions.patchTx(tx.id, { desc: '   ' });
    actions.patchFixed(netflix.id, { name: '' });
    expect(h.store.pendingCount).toBe(0);
    expect(h.tx(0).desc).toBe(tx.desc);

    actions.patchTx(tx.id, { desc: '', amount: 99 });
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ amount: 99 });
    expect(h.tx(0)).toMatchObject({ desc: tx.desc, amount: 99 });
  });

  it('with no month selected it adds nothing', () => {
    const actions = createActions(h.store, null, flows);
    expect(actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' })).toBe(false);
    actions.reopenMonth();
    expect(h.calls).toEqual([]);
  });
});

describe('users', () => {
  it('each user has their own store, always the same one, with its key and data', async () => {
    const eda = await h.switchTo(EDA);
    expect(eda).not.toBe(h.store);
    expect(h.stores.for('eda')).toBe(eda);
    expect(h.stores.for('frank')).toBe(h.store);
    expect(eda.userId).toBe('eda');
    expect(eda.key).toEqual(['state', 'eda']);
    expect(h.qc.getQueryData(stateKey('eda'))).toMatchObject({ user: EDA });
    // With the other user come their language and figures; Frank's stay in his cache.
    expect(eda.state!.language).toBe('tr');
    expect(eda.state!.months[OCT]!.budgets.dr).toBe(50000);
    expect(h.view().language).toBe('en');
    expect(h.view().months[OCT]!.budgets.dr).toBe(70000);
  });

  it('every write from a store carries the header of its user', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, {} as Flows, () => 'new').addFixed({ name: 'Spotify', amount: 6, cur: 'USD' });
    eda.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { us: 400 } } });
    eda.flush();
    h.calls[0]!.ok();
    await tick();
    expect(h.calls.map((c) => [c.method, c.path, c.user])).toEqual([
      ['POST', '/api/fixed', 'eda'],
      ['PATCH', `/api/months/${OCT}`, 'eda'],
    ]);
  });

  it('an edit waiting for its delay goes out with the user it was made for, even if another one is already on screen', async () => {
    const id = h.tx(0).id;
    // Frank types in a cell: the edit is left waiting for its 400 ms…
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'Frank typed this' } });
    expect(h.calls).toEqual([]);

    // …and before it goes out the app switches to Eda, who edits the row that has that same id in her data.
    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'tx/patch', id, patch: { desc: 'Eda typed this' } });

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls.map((c) => [c.user, c.path, c.body])).toEqual([
      ['frank', `/api/transactions/${id}`, { desc: 'Frank typed this' }],
      ['eda', `/api/transactions/${id}`, { desc: 'Eda typed this' }],
    ]);
    // Each one sees their own.
    expect(h.tx(0).desc).toBe('Frank typed this');
    expect(eda.state!.months[OCT]!.tx[0]!.desc).toBe('Eda typed this');
  });

  it('on a user switch, flush() sends right away what the previous user had pending, with their header', async () => {
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000 } } });
    // What the app does on a user switch: flush every store and load the other user.
    h.stores.flush();
    const eda = await h.switchTo(EDA);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/months/${OCT}`, user: 'frank', body: { budgets: { dr: 80000 } } });
    // Eda's budget has not moved.
    expect(eda.state!.months[OCT]!.budgets.dr).toBe(50000);
  });

  it('what was queued behind an in-flight request also goes out with its user', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/remove', id: h.fixed('Smartfit').id });
    // Only the first one has gone out; the other two wait their turn.
    expect(h.calls).toHaveLength(1);

    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    // The queues are independent: Eda's does not wait for Frank's.
    expect(h.calls.map((c) => c.user)).toEqual(['frank', 'eda']);

    h.calls[0]!.ok();
    await tick();
    h.calls[2]!.ok();
    await tick();
    expect(h.calls.map((c) => `${c.user} ${c.method} ${c.path}`)).toEqual([
      `frank PATCH /api/fixed/${netflix.id}`,
      `eda PATCH /api/fixed/${netflix.id}`,
      `frank PATCH /api/fixed/${cluely.id}`,
      `frank DELETE /api/fixed/${h.server.state.months[OCT]!.fixed.find((f) => f.name === 'Smartfit')!.id}`,
    ]);
  });

  it('actions created for a user keep writing to their data after the switch', async () => {
    // A component that held on to Frank's actions (a stale closure) and uses them late.
    const franks = createActions(h.store, OCT, {} as Flows, () => 'late');
    const eda = await h.switchTo(EDA);
    expect(franks.addFixed({ name: 'Late', amount: 1, cur: 'DOP' })).toBe(true);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/fixed', user: 'frank' });
    expect(h.view().months[OCT]!.fixed.some((f) => f.id === 'late')).toBe(true);
    expect(eda.state!.months[OCT]!.fixed.some((f) => f.id === 'late')).toBe(false);
  });

  it('a late rejection undoes the change in the data of its owner and says whose it was', async () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });

    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ userId: 'frank', action: { type: 'fixed/patch', id: netflix.id } });
    expect(h.fixed('Netflix').paid).toBe(false);
    // Eda's edit to her row still stands.
    expect(eda.state!.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!.paid).toBe(true);
  });

  it('when the pending work of a user no longer on screen finishes, their state is not refetched', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    await h.switchTo(EDA);
    const gets = h.server.gets;
    h.calls[0]!.ok();
    await tick();
    expect(h.server.gets).toBe(gets);
    // Going back to Frank does refresh, and it already brings the confirmed change.
    h.server.state.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!.paid = true;
    await h.switchTo(FRANK);
    expect(h.server.gets).toBe(gets + 1);
    expect(h.fixed('Netflix').paid).toBe(true);
  });

  it('on page close everything pending for everyone goes out, each item with its user', async () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'frank' } });
    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'tx/patch', id: eda.state!.months[OCT]!.tx[1]!.id, patch: { desc: 'eda' } });
    expect(h.stores.pendingCount).toBe(2);

    h.stores.flush({ unload: true });
    expect(h.calls.map((c) => [c.user, c.body, c.keepalive])).toEqual([
      ['frank', { desc: 'frank' }, true],
      ['eda', { desc: 'eda' }, true],
    ]);
  });
});

describe('settings', () => {
  const flows = {} as Flows;
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('the language changes at once and is saved without waiting', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setLanguage('es');
    expect(h.view().language).toBe('es');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank', body: { language: 'es' } });
  });

  it('once saved, the language survives the refresh', async () => {
    createActions(h.store, OCT, flows).setLanguage('tr');
    h.server.state.language = 'tr';
    h.calls[0]!.ok();
    await tick();
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().language).toBe('tr');
  });

  it('if the server rejects it, the previous language comes back and it is reported', async () => {
    createActions(h.store, OCT, flows).setLanguage('tr');
    h.calls[0]!.fail(500, 'internal');
    await tick();
    expect(h.view().language).toBe('en');
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.action).toEqual({ type: 'settings/patch', patch: { language: 'tr' } });
  });

  it('choosing the language already set, or one that does not exist, does nothing', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setLanguage('en');
    actions.setLanguage('fr' as 'en');
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('the language is per user', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows).setLanguage('es');
    expect(h.calls[0]).toMatchObject({ path: '/api/settings', user: 'eda', body: { language: 'es' } });
    expect(eda.state!.language).toBe('es');
    expect(h.view().language).toBe('en');
  });

  it('the colors show at once and are saved once, with the last value, after the delay', async () => {
    const actions = createActions(h.store, OCT, flows);
    // Dragging the color picker: many changes in a row.
    for (const accent of ['#2a6f90', '#2a6f95', '#2a6f97']) actions.setTheme({ ...ocean, accent });
    expect(h.view().theme).toEqual(ocean);
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank', body: { theme: ocean } });
  });

  it('the colors are normalized, and the original ones (or null) are saved as null', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setTheme({ accent: '#2A6F97', header: '#16202A', background: '#EEF1F4' });
    expect(h.view().theme).toEqual(ocean);
    h.store.flush();
    expect(h.calls[0]!.body).toEqual({ theme: ocean });
    h.server.state.theme = ocean;
    h.calls[0]!.ok();
    await tick();

    actions.setTheme({ accent: '#2f7d52', header: '#1d1f1c', background: '#efeee8' });
    expect(h.view().theme).toBeNull();
    h.store.flush();
    expect(h.calls[1]!.body).toEqual({ theme: null });
  });

  it('an invalid theme, or the same one as before, does nothing', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setTheme(null);
    actions.setTheme({ ...ocean, accent: 'blue' });
    actions.setTheme({ accent: '#2a6f97' } as typeof ocean);
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().theme).toBeNull();

    actions.setTheme(ocean);
    actions.setTheme({ ...ocean });
    h.store.flush();
    expect(h.calls).toHaveLength(1);
  });

  it('if they could not be saved, the previous colors come back', async () => {
    createActions(h.store, OCT, flows).setTheme(ocean);
    h.store.flush();
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().theme).toBeNull();
    expect(h.failures).toHaveLength(1);
  });

  it('a language change takes along the colors that were waiting', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setTheme(ocean);
    actions.setLanguage('es');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ theme: ocean, language: 'es' });
  });
});

describe('goals', () => {
  const flows = {} as Flows;
  const plan = { monthly: 500, start: '2026-10', end: '2027-09' };

  it('addGoal creates the goal at once, with a client id, and sends it with its currency', () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    expect(actions.addGoal({ name: ' Car ', cur: 'TRY', ...plan })).toBe(true);
    expect(h.view().goals.at(-1)).toEqual({ id: 'goal-new', name: 'Car', cur: 'TRY', ...plan, approxCur: null, sort: 3 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/goals', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Car', cur: 'TRY', ...plan, approxCur: null });
  });

  it('addGoal sends the currency of the "≈" line of the goal; patchGoal changes it and sets it back to the main one with null', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    expect(actions.addGoal({ name: 'Car', cur: 'USD', approxCur: 'TRY' })).toBe(true);
    expect(h.view().goals.at(-1)).toMatchObject({ id: 'goal-new', cur: 'USD', approxCur: 'TRY' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Car', cur: 'USD', monthly: null, start: null, end: null, approxCur: 'TRY' });
    expect(actions.addGoal({ name: 'Boat', approxCur: 'EUR' as 'USD' })).toBe(false);

    expect(actions.patchGoal('goal-new', { approxCur: null })).toBe(true);
    expect(h.view().goals.at(-1)!.approxCur).toBeNull();
    // What it already has is not sent.
    expect(actions.patchGoal('goal-new', { approxCur: null })).toBe(true);
    expect(actions.patchGoal('turkey', { approxCur: null })).toBe(true);
    expect(actions.patchGoal('turkey', { approxCur: 'EUR' as 'USD' })).toBe(false);
    expect(actions.patchGoal('turkey', { approxCur: 'DOP' })).toBe(true);
    for (let i = 0; i < 3; i++) {
      h.calls[i]!.ok();
      await tick();
    }
    expect(h.summary()).toEqual(['POST /api/goals', 'PATCH /api/goals/goal-new', 'PATCH /api/goals/turkey']);
    // null travels as null: it is a value, not a missing field.
    expect(h.calls[1]!.body).toEqual({ approxCur: null });
    expect(h.calls[2]!.body).toEqual({ approxCur: 'DOP' });
  });

  it('a goal with no plan travels with the three fields as null and, with no currency given, in the main one', () => {
    createActions(h.store, OCT, flows, () => 'goal-new').addGoal({ name: 'Rainy day' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Rainy day', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null });
  });

  it('an invalid goal is neither shown nor sent', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.addGoal({ name: '' })).toBe(false);
    expect(actions.addGoal({ name: 'Car', monthly: 500 })).toBe(false);
    expect(actions.addGoal({ name: 'Car', ...plan, monthly: 0 })).toBe(false);
    expect(actions.addGoal({ name: 'Car', ...plan, start: '2027-10' })).toBe(false);
    expect(actions.patchGoal('turkey', { end: '2026-01' })).toBe(false);
    expect(actions.patchGoal('turkey', { monthly: null })).toBe(false);
    expect(actions.patchGoal('personal', { monthly: 100 })).toBe(false);
    expect(actions.patchGoal('turkey', { name: ' ' })).toBe(false);
    expect(actions.patchGoal('nope', { name: 'x' })).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.view()).toEqual(seedState());
  });

  it('patchGoal is saved in one go, with no delay, with the full plan', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.patchGoal('turkey', { name: 'Istanbul', monthly: 2500 })).toBe(true);
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ name: 'Istanbul', monthly: 2500, start: '2026-08', end: '2027-10' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/goals/turkey' });
    expect(h.calls[0]!.body).toEqual({ name: 'Istanbul', monthly: 2500, start: '2026-08', end: '2027-10' });
  });

  it('changing the currency of a goal sends only the currency', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { cur: 'TRY' })).toBe(true);
    expect(h.calls[0]!.body).toEqual({ cur: 'TRY' });
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ cur: 'TRY', monthly: 3000 });
  });

  it('removing the plan from a goal sends the three fields as null', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { monthly: null, start: null, end: null })).toBe(true);
    expect(h.calls[0]!.body).toEqual({ monthly: null, start: null, end: null });
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ monthly: null, start: null, end: null });
  });

  it('saving with no changes is valid and sends nothing', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10' })).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('removeGoal refuses if the goal has contributions', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.removeGoal('turkey')).toBe(false);
    expect(actions.removeGoal('nope')).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.view().goals).toHaveLength(3);
  });

  it('removeGoal deletes a goal with no contributions; once their contributions are deleted, the others too', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    actions.addGoal({ name: 'Car' });
    expect(actions.removeGoal('goal-new')).toBe(true);
    expect(h.view().goals.some((g) => g.id === 'goal-new')).toBe(false);

    for (const c of h.view().contribs.filter((x) => x.goalId === 'personal')) actions.removeContribution(c.id);
    expect(actions.removeGoal('personal')).toBe(true);
    expect(h.view().goals.map((g) => g.id)).toEqual(['emergency', 'turkey']);

    // They go out in order: creation, deletion, the two contributions and, last, the goal.
    for (let i = 0; i < 5; i++) {
      h.calls[i]!.ok();
      await tick();
    }
    expect(h.summary()).toEqual([
      'POST /api/goals',
      'DELETE /api/goals/goal-new',
      'DELETE /api/contributions/seed-ct-3',
      'DELETE /api/contributions/seed-ct-6',
      'DELETE /api/goals/personal',
    ]);
  });

  it('the creation of a goal arrives before its edit and its first contribution', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'new');
    actions.addGoal({ name: 'Car' });
    actions.patchGoal('new', plan);
    expect(actions.addContribution({ goalId: 'new', date: '2026-10-08', amount: 100, cur: 'USD' })).toBe(true);
    expect(h.summary()).toEqual(['POST /api/goals']);
    h.calls[0]!.ok();
    await tick();
    h.calls[1]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/goals', 'PATCH /api/goals/new', 'POST /api/contributions']);
  });

  it('if the goal could not be created, it is undone and its edit is not sent', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    actions.addGoal({ name: 'Car' });
    actions.patchGoal('goal-new', { name: 'New car' });
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.summary()).toEqual(['POST /api/goals']);
    expect(h.view().goals.some((g) => g.id === 'goal-new')).toBe(false);
    expect(h.failures).toHaveLength(1);
    expect(h.store.pendingCount).toBe(0);
  });

  it('if the server says the goal has contributions (409), it reappears', async () => {
    const state = h.server.state;
    state.contribs = state.contribs.filter((c) => c.goalId !== 'personal');
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).removeGoal('personal')).toBe(true);
    h.calls[0]!.fail(409, 'conflict');
    await tick();
    expect(h.view().goals.some((g) => g.id === 'personal')).toBe(true);
    expect(h.failures[0]!.error).toMatchObject({ code: 'conflict' });
  });

  it('goals are per user', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows, () => 'eda-goal').addGoal({ name: 'Ev' });
    expect(h.calls[0]).toMatchObject({ path: '/api/goals', user: 'eda' });
    expect(h.view().goals.some((g) => g.id === 'eda-goal')).toBe(false);
  });
});

describe('accounts', () => {
  const flows = {} as Flows;
  const balance = (id: string, state: AppState = h.view()) => balances(state, OCT).accounts.find((a) => a.account.id === id)!.balance;

  it('addAccount creates the account at once, with a client id, and sends it', () => {
    const actions = createActions(h.store, OCT, flows, () => 'acc-new');
    expect(actions.addAccount({ name: ' TR account ', currency: 'TRY', opening: 1500 })).toBe(true);
    expect(h.view().accounts.at(-1)).toEqual({ id: 'acc-new', name: 'TR account', currency: 'TRY', opening: 1500, hidden: false, sort: 2 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/accounts', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'acc-new', name: 'TR account', currency: 'TRY', opening: 1500 });
  });

  it('the creation of an account arrives before whatever is paid from it', async () => {
    let n = 0;
    const actions = createActions(h.store, OCT, flows, () => `id-${++n}`);
    actions.addAccount({ name: 'PayPal', currency: 'USD' });
    expect(actions.addTx({ date: '2026-10-07', desc: 'Hosting', cat: 'Subscriptions', method: 'Card', amount: 12, cur: 'USD', accountId: 'id-1' })).toBe(true);
    expect(h.summary()).toEqual(['POST /api/accounts']);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/accounts', 'POST /api/transactions']);
    expect(h.calls[1]!.body).toMatchObject({ accountId: 'id-1' });
  });

  it('renaming is a cell edit: it goes out after the delay, with the latest name', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.renameAccount('us', 'Cha');
    actions.renameAccount('us', 'Chase');
    expect(h.view().accounts.find((a) => a.id === 'us')!.name).toBe('Chase');
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/us', body: { name: 'Chase' } });
  });

  it('a blank name is not saved', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.renameAccount('us', '   ');
    actions.renameAccount('gone', 'Chase');
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().accounts.find((a) => a.id === 'us')!.name).toBe('US account');
  });

  it('hide and show go out without waiting; the last visible account cannot be hidden', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setAccountHidden('us', true)).toBe(true);
    expect(h.view().accounts.find((a) => a.id === 'us')!.hidden).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/us', body: { hidden: true } });
    // Once hidden it no longer adds to the total money.
    expect(balances(h.view(), OCT).totalMain).toBeCloseTo(balance('dr'), 6);

    expect(actions.setAccountHidden('dr', true)).toBe(false);
    expect(actions.setAccountHidden('gone', true)).toBe(false);
    expect(h.view().accounts.find((a) => a.id === 'dr')!.hidden).toBe(false);

    expect(actions.setAccountHidden('us', false)).toBe(true);
    expect(h.view().accounts.find((a) => a.id === 'us')!.hidden).toBe(false);
    // Asking for what is already the case sends nothing.
    expect(actions.setAccountHidden('us', false)).toBe(true);
    expect(h.store.pendingCount).toBe(2);
  });

  it('removeAccount refuses if anything uses the account; an unused one is deleted', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'spare');
    expect(actions.removeAccount('us')).toBe(false);
    expect(actions.removeAccount('gone')).toBe(false);
    expect(h.calls).toEqual([]);

    actions.addAccount({ name: 'Spare', currency: 'USD' });
    expect(actions.removeAccount('spare')).toBe(true);
    expect(h.view().accounts.map((a) => a.id)).toEqual(['us', 'dr']);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/accounts', 'DELETE /api/accounts/spare']);
  });

  it('if the server says the account is in use (409), it reappears', async () => {
    h.server.state.accounts.push({ id: 'spare', name: 'Spare', currency: 'USD', opening: 0, hidden: true, sort: 2 });
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).removeAccount('spare')).toBe(true);
    h.calls[0]!.fail(409, 'conflict');
    await tick();
    expect(h.view().accounts.some((a) => a.id === 'spare')).toBe(true);
    expect(h.failures[0]!.error).toMatchObject({ code: 'conflict' });
  });

  it('setAccountBalance saves the opening balance that yields the typed balance', async () => {
    const actions = createActions(h.store, OCT, flows);
    // DR account: 220,641.93 with an opening balance of 60,000. To see 200,000 the opening balance has to be 39,358.07.
    expect(actions.setAccountBalance('dr', 200000)).toBe(true);
    expect(balance('dr')).toBeCloseTo(200000, 6);
    expect(h.view().accounts.find((a) => a.id === 'dr')!.opening).toBeCloseTo(39358.07, 6);
    // The movements are not touched.
    expect(h.view().months).toEqual(seedState().months);
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/dr' });
    expect((h.calls[0]!.body as { opening: number }).opening).toBeCloseTo(39358.07, 6);
    expect(Object.keys(h.calls[0]!.body as object)).toEqual(['opening']);
  });

  it('typing the balance digit by digit ends in a single PATCH with the opening balance for the last balance', () => {
    const actions = createActions(h.store, OCT, flows);
    for (const typed of [1, 15, 150, 1500]) actions.setAccountBalance('us', typed);
    expect(balance('us')).toBeCloseTo(1500, 8);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    // US account: 13,482 with an opening balance of 2,000 → 1,500 calls for −9,982.
    expect((h.calls[0]!.body as { opening: number }).opening).toBeCloseTo(2000 + (1500 - 13482), 8);
  });

  it('setAccountBalance refuses in a month that is not the last one: past balances are history', () => {
    const past = createActions(h.store, '2026-09', flows);
    expect(past.setAccountBalance('dr', 200000)).toBe(false);
    expect(createActions(h.store, '2026-08', flows).setAccountBalance('us', 1)).toBe(false);
    expect(createActions(h.store, null, flows).setAccountBalance('us', 1)).toBe(false);
    const now = createActions(h.store, OCT, flows);
    expect(now.setAccountBalance('gone', 1)).toBe(false);
    expect(now.setAccountBalance('dr', Number.NaN)).toBe(false);
    expect(h.store.pendingCount).toBe(0);
    expect(h.view()).toEqual(seedState());
  });

  it('accounts are per user', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows, () => 'eda-acc').addAccount({ name: 'Garanti', currency: 'TRY' });
    expect(h.calls[0]).toMatchObject({ path: '/api/accounts', user: 'eda' });
    expect(h.view().accounts.some((a) => a.id === 'eda-acc')).toBe(false);
  });
});

describe('budget and month rates', () => {
  const flows = {} as Flows;

  it('setBudgetPart: each account is a cell; they go out together in one PATCH of the month', async () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setBudgetPart('dr', 6)).toBe(true);
    expect(actions.setBudgetPart('dr', 60000)).toBe(true);
    expect(actions.setBudgetPart('us', 200)).toBe(true);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 60000, us: 200 });
    expect(monthCalc(h.view(), OCT).budget).toBeCloseTo(60000 + 200 * 58.76, 8);
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/months/${OCT}`, body: { budgets: { dr: 60000, us: 200 } } });
  });

  it('setBudgetPart: 0 removes the part; an account that does not exist or a closed month is not sent', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setBudgetPart('dr', 0)).toBe(true);
    expect(h.view().months[OCT]!.budgets).toEqual({});
    h.store.flush();
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 0 } });

    expect(actions.setBudgetPart('gone', 100)).toBe(false);
    expect(actions.setBudgetPart('us', Number.NaN)).toBe(false);
    expect(createActions(h.store, '2026-09', flows).setBudgetPart('dr', 1)).toBe(false);
    expect(createActions(h.store, null, flows).setBudgetPart('dr', 1)).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(h.view().months['2026-09']!.budgets).toEqual({ dr: 70000 });
  });

  it('if the server rejects the budget, the previous one comes back', async () => {
    createActions(h.store, OCT, flows).setBudgetPart('dr', 99000);
    h.store.flush();
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
    expect(h.failures).toHaveLength(1);
  });

  it('setBudgetPart: does not overwrite; adds the difference to the log, dated today', async () => {
    const actions = createActions(h.store, OCT, flows, undefined, () => '2026-10-09');
    expect(actions.setBudgetPart('dr', 82000)).toBe(true);
    expect(actions.setBudgetPart('us', 200)).toBe(true);
    const log = h.view().months[OCT]!.budgetLog;
    expect(log.slice(0, 2)).toEqual(seedState().months[OCT]!.budgetLog);
    expect(log.slice(2).map((e) => [e.date, e.accountId, e.amount, e.kind])).toEqual([
      ['2026-10-09', 'dr', 12000, 'adjust'],
      ['2026-10-09', 'us', 200, 'initial'],
    ]);
    expect(log.slice(2).every((e) => e.id.startsWith('local-'))).toBe(true);
    // The part goes to the server, not the movement: the server computes the difference against its own log.
    h.store.flush();
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 82000, us: 200 } });
    // Typing what it already adds up to adds nothing and leaves nothing in view.
    h.calls[0]!.ok();
    await tick();
    expect(actions.setBudgetPart('dr', 70000)).toBe(true);
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
  });

  it('setBudgetPart: if today falls outside the selected month, the date is moved into the month', () => {
    createActions(h.store, OCT, flows, undefined, () => '2026-11-03').setBudgetPart('dr', 71000);
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toMatchObject({ date: '2026-10-31', amount: 1000 });
    createActions(h.store, OCT, flows, undefined, () => '2026-09-30').setBudgetPart('us', 5);
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toMatchObject({ date: '2026-10-01', accountId: 'us', amount: 5 });
  });

  it('setBudgetPart: with an income that raises the budget, the part is typed as shown and what travels is what the log adds up to', async () => {
    h.server.state.incomes.push({ id: 'in-budget', date: '2026-10-10', desc: 'Freelance', accountId: 'dr', amount: 10000, cur: 'DOP', budget: true });
    await h.store.refetch();
    const part = () => monthCalc(h.view(), OCT).budgetParts.find((p) => p.account.id === 'dr')!;
    expect(part()).toMatchObject({ amount: 80000, fromLog: 70000, fromIncomes: 10000 });

    const actions = createActions(h.store, OCT, flows);
    expect(actions.setBudgetPart('dr', 85000)).toBe(true);
    expect(part()).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
    // It cannot go below what the incomes already put in: the log would end up negative.
    expect(actions.setBudgetPart('dr', 9000)).toBe(false);
    expect(part().amount).toBe(85000);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 75000 } });
  });

  it('addBudgetEntry: adds a movement to the log at once and sends it without waiting', () => {
    const actions = createActions(h.store, OCT, flows, () => 'bg-new', () => '2026-10-09');
    expect(actions.addBudgetEntry({ accountId: 'dr', amount: 2500, note: ' Gift ' })).toBe(true);
    const row = { id: 'bg-new', date: '2026-10-09', accountId: 'dr', amount: 2500, kind: 'adjust', note: 'Gift' };
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toEqual(row);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 72500 });
    expect(monthCalc(h.view(), OCT).budget).toBe(72500);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: `/api/months/${OCT}/budget-log`, user: 'frank' });
    expect(h.calls[0]!.body).toEqual(row);
  });

  it('addBudgetEntry: a cut, with its date and kind; what is not valid is neither shown nor sent', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'bg-new', () => '2026-10-09');
    expect(actions.addBudgetEntry({ accountId: 'us', amount: -40, date: '2026-10-20', kind: 'initial' })).toBe(true);
    expect(h.calls[0]!.body).toEqual({ id: 'bg-new', date: '2026-10-20', accountId: 'us', amount: -40, kind: 'initial', note: '' });

    expect(actions.addBudgetEntry({ accountId: 'dr', amount: 0 })).toBe(false);
    expect(actions.addBudgetEntry({ accountId: 'dr', amount: Number.NaN })).toBe(false);
    expect(actions.addBudgetEntry({ accountId: 'gone', amount: 5 })).toBe(false);
    expect(actions.addBudgetEntry({ accountId: 'dr', amount: 5, date: '2026-11-01' })).toBe(false);
    expect(createActions(h.store, '2026-09', flows).addBudgetEntry({ accountId: 'dr', amount: 5 })).toBe(false);
    expect(createActions(h.store, null, flows).addBudgetEntry({ accountId: 'dr', amount: 5 })).toBe(false);
    expect(h.store.pendingCount).toBe(1);

    // If the server rejects it, it disappears.
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.failures[0]!.action).toMatchObject({ type: 'budget/add', key: OCT });
  });

  it('removeBudgetEntry: removes the movement at once and sends the DELETE', async () => {
    const actions = createActions(h.store, OCT, flows);
    // The adjustment from the 5th (5,000).
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(true);
    expect(h.view().months[OCT]!.budgetLog.map((e) => e.id)).toEqual(['seed-bg-2026-10-1']);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 65000 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', path: `/api/months/${OCT}/budget-log/seed-bg-2026-10-2`, user: 'frank' });
    expect(h.calls[0]!.body).toBeUndefined();
    // It is gone: asking for it again does nothing.
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(false);
    expect(h.store.pendingCount).toBe(1);

    // If the server no longer had it (404), that is what was wanted.
    h.calls[0]!.fail(404, 'not_found');
    await tick();
    expect(h.failures).toEqual([]);
  });

  it('removeBudgetEntry: false if it is not there, if the month is closed or if it has no server id yet', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.removeBudgetEntry('nope')).toBe(false);
    expect(createActions(h.store, '2026-09', flows).removeBudgetEntry('seed-bg-2026-09-1')).toBe(false);
    expect(createActions(h.store, null, flows).removeBudgetEntry('seed-bg-2026-10-2')).toBe(false);
    // The movement setBudgetPart just added is local: its id is assigned by the server.
    actions.setBudgetPart('us', 200);
    const local = h.view().months[OCT]!.budgetLog.at(-1)!;
    expect(local.id.startsWith('local-')).toBe(true);
    expect(actions.removeBudgetEntry(local.id)).toBe(false);
    expect(h.view().months[OCT]!.budgetLog).toHaveLength(3);
    expect(h.calls).toEqual([]);
  });

  it('removeBudgetEntry: the part waiting for its delay goes out before the deletion', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setBudgetPart('dr', 80000);
    expect(h.calls).toEqual([]);
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(true);
    // The PATCH (which counted on that movement) already went out; the DELETE waits its turn.
    expect(h.summary()).toEqual([`PATCH /api/months/${OCT}`]);
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 80000 } });
    // 80,000 minus the 5,000 of the removed movement, the same as the server will do.
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 75000 });
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/months/${OCT}`, `DELETE /api/months/${OCT}/budget-log/seed-bg-2026-10-2`]);
  });

  it('if the server rejects the deletion, the movement comes back', async () => {
    createActions(h.store, OCT, flows).removeBudgetEntry('seed-bg-2026-10-1');
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 5000 });
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
    expect(h.failures[0]!.action).toEqual({ type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-1' });
  });

  it('addLeftover: adds what was left over from the previous month at once and requests it with a POST with no body', () => {
    const sep = monthCalc(h.view(), '2026-09').avail;
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    expect(actions.addLeftover()).toBe(true);
    // What shows while it responds: in the default account, with a local id.
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toEqual({ id: 'local-lo', date: '2026-10-09', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    expect(monthCalc(h.view(), OCT).budget).toBeCloseTo(70000 + sep, 8);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: `/api/months/${OCT}/leftover`, user: 'frank' });
    // The server computes the figure: it does not travel.
    expect(h.calls[0]!.body).toBeUndefined();
    // One per month: while it is in view it cannot be repeated.
    expect(actions.addLeftover()).toBe(false);
    expect(h.store.pendingCount).toBe(1);
  });

  it('addLeftover: if the server says it already had it (409), it is undone', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'lo');
    expect(actions.addLeftover()).toBe(true);
    expect(h.view().months[OCT]!.budgetLog).toHaveLength(3);
    h.calls[0]!.fail(409, 'conflict');
    await tick();
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(monthCalc(h.view(), OCT).budget).toBe(70000);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.action).toMatchObject({ type: 'budget/leftover', key: OCT });
    expect(h.failures[0]!.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(h.store.pendingCount).toBe(0);
  });

  it('addLeftover: once confirmed, the refresh brings the movement from the server and only one remains, now with its id', async () => {
    const sep = monthCalc(h.view(), '2026-09').avail;
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    actions.addLeftover();
    // What the server does: it writes it with its own id.
    h.server.state.months[OCT]!.budgetLog.push({ id: 'srv-lo', date: '2026-10-09', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    h.calls[0]!.ok();
    await tick();
    expect(h.view().months[OCT]!.budgetLog.filter((e) => e.kind === 'leftover').map((e) => e.id)).toEqual(['srv-lo']);
    // Already added: it is not offered again; once removed (now it does have an id), it can be added again.
    expect(actions.addLeftover()).toBe(false);
    expect(actions.removeBudgetEntry('srv-lo')).toBe(true);
    expect(actions.addLeftover()).toBe(true);
    expect(h.summary().slice(1)).toEqual([`DELETE /api/months/${OCT}/budget-log/srv-lo`]);
  });

  it('addLeftover: a refresh that already brings it while the request is still in flight does not duplicate it', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    actions.addLeftover();
    h.server.state.months[OCT]!.budgetLog.push({ id: 'srv-lo', date: '2026-10-09', accountId: 'dr', amount: 1234, kind: 'leftover', note: '' });
    await h.store.refetch();
    expect(h.view().months[OCT]!.budgetLog.filter((e) => e.kind === 'leftover').map((e) => [e.id, e.amount])).toEqual([['srv-lo', 1234]]);
  });

  it('addLeftover: what was waiting for its delay goes out first (the leftover comes from those figures)', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'lo');
    const id = h.tx(0).id;
    actions.patchTx(id, { amount: 6000 });
    expect(actions.addLeftover()).toBe(true);
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`]);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`, `POST /api/months/${OCT}/leftover`]);
  });

  it('addLeftover: false if there is no previous month, the month is closed, nothing was left over or no month is selected', async () => {
    expect(createActions(h.store, '2026-09', flows).addLeftover()).toBe(false); // closed
    expect(createActions(h.store, '2026-11', flows).addLeftover()).toBe(false); // does not exist
    expect(createActions(h.store, null, flows).addLeftover()).toBe(false);

    // September used exactly its budget: nothing was left over.
    const sep = h.server.state.months['2026-09']!;
    sep.fixed = [];
    sep.tx = [{ ...sep.tx[0]!, amount: 1000 }];
    setBudgets(sep, { dr: 1000 });
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).addLeftover()).toBe(false);

    // October as the only month: there is no previous one.
    for (const key of ['2026-08', '2026-09']) Reflect.deleteProperty(h.server.state.months, key);
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).addLeftover()).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('the budget log is per user', async () => {
    const eda = await h.switchTo(EDA);
    const actions = createActions(eda, OCT, flows, () => 'eda-bg', () => '2026-10-09');
    actions.addBudgetEntry({ accountId: 'dr', amount: 100 });
    actions.addLeftover();
    h.calls[0]!.ok();
    await tick();
    expect(h.calls.map((c) => [c.method, c.path, c.user])).toEqual([
      ['POST', `/api/months/${OCT}/budget-log`, 'eda'],
      ['POST', `/api/months/${OCT}/leftover`, 'eda'],
    ]);
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
  });

  it('setMonthRate: the rate of a pair from a date shows at once and goes out with a PUT, after the delay, with the last value', async () => {
    const actions = createActions(h.store, OCT, flows);
    for (const typed of [5, 59, 59.1]) expect(actions.setMonthRate('USD', 'DOP', typed, '2026-10-07')).toBe(true);
    // The ones from the 1st and the 6th are still there: the new one applies from the 7th.
    expect(h.view().months[OCT]!.rates).toEqual([...seedState().months[OCT]!.rates, { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' }]);
    expect(monthCalc(h.view(), OCT).rate).toEqual({ rate: 59.1, source: 'month', monthKey: OCT, date: '2026-10-07' });
    // What was recorded before does not change: October's transactions are in DOP and the USD fixed expense uses the latest.
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: `/api/months/${OCT}/rates`, user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' });
  });

  it('setMonthRate: typing over a date that already had a rate replaces it, in place and in the new direction', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setMonthRate('DOP', 'USD', 0.0165, '2026-10-06')).toBe(true);
    expect(h.view().months[OCT]!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-06' },
    ]);
    h.store.flush();
    expect(h.summary()).toEqual([`PUT /api/months/${OCT}/rates`]);
    expect(h.calls[0]!.body).toEqual({ from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-06' });
  });

  it('setMonthRate: each pair and each date has its own rate and its own save', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMonthRate('USD', 'TRY', 40, '2026-10-07');
    actions.setMonthRate('TRY', 'DOP', 1.47, '2026-10-07');
    // The same pair on two dates: two rows, neither overwrites the other while they wait.
    actions.setMonthRate('USD', 'DOP', 59, '2026-10-07');
    actions.setMonthRate('USD', 'DOP', 60, '2026-10-20');
    expect(h.store.pendingCount).toBe(4);
    expect(h.view().months[OCT]!.rates).toHaveLength(6);
    h.store.flush();
    // The first one goes out; the rest wait their turn.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' });
    for (let i = 0; i < 3; i++) {
      h.calls[i]!.ok();
      await tick();
    }
    expect(h.calls.map((c) => c.body)).toEqual([
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' },
      { from: 'TRY', to: 'DOP', rate: 1.47, date: '2026-10-07' },
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-20' },
    ]);
  });

  it('setMonthRate: a half-typed cell (0), a same-currency pair, a date in another month or a closed month is not sent', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setMonthRate('USD', 'DOP', 0, '2026-10-07')).toBe(false);
    expect(actions.setMonthRate('USD', 'DOP', -2, '2026-10-07')).toBe(false);
    expect(actions.setMonthRate('USD', 'USD', 1, '2026-10-07')).toBe(false);
    expect(actions.setMonthRate('USD', 'DOP', 59, '2026-11-01')).toBe(false);
    expect(actions.setMonthRate('USD', 'DOP', 59, '2026-09-30')).toBe(false);
    expect(actions.setMonthRate('USD', 'DOP', 59, '2026-10-32')).toBe(false);
    expect(createActions(h.store, '2026-08', flows).setMonthRate('USD', 'DOP', 58, '2026-08-07')).toBe(false);
    expect(createActions(h.store, null, flows).setMonthRate('USD', 'DOP', 58, '2026-10-07')).toBe(false);
    expect(h.store.pendingCount).toBe(0);
    expect(h.view()).toEqual(seedState());
  });

  it('removeMonthRate: deletes the rate of that date in the direction it was saved in and discards the one that was waiting', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMonthRate('USD', 'DOP', 59, '2026-10-06');
    // It is requested the other way around: the saved rate is USD → DOP.
    actions.removeMonthRate('DOP', 'USD', '2026-10-06');
    // The one from the 1st is not touched: it is the one that applies again.
    expect(h.view().months[OCT]!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    expect(monthCalc(h.view(), OCT).rate).toMatchObject({ source: 'month', date: '2026-10-01' });
    await vi.advanceTimersByTimeAsync(1000);
    // The PUT that was waiting no longer goes out; the DELETE carries the date in the query.
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-06`]);
    expect(h.calls[0]!.body).toBeUndefined();

    // A pair with no typed rate, a date with no rate, or a closed month: nothing to remove.
    actions.removeMonthRate('USD', 'TRY', '2026-10-06');
    actions.removeMonthRate('USD', 'DOP', '2026-10-03');
    actions.removeMonthRate('USD', 'DOP', '2026-10-06');
    createActions(h.store, '2026-09', flows).removeMonthRate('USD', 'DOP', '2026-10-01');
    createActions(h.store, null, flows).removeMonthRate('USD', 'DOP', '2026-10-01');
    expect(h.calls).toHaveLength(1);

    // With the one from the 1st removed too, the pair comes from the month's transfers again.
    actions.removeMonthRate('USD', 'DOP', '2026-10-01');
    expect(h.view().months[OCT]!.rates).toEqual([]);
    expect(monthCalc(h.view(), OCT).rate!.source).toBe('transfers');
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-06`, `DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-01`]);
  });

  it('removeMonthRate: removing the one for a date does not discard the one for another date that was waiting for its delay', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMonthRate('USD', 'DOP', 59, '2026-10-07');
    actions.removeMonthRate('USD', 'DOP', '2026-10-06');
    expect(h.view().months[OCT]!.rates.map((r) => [r.date, r.rate])).toEqual([
      ['2026-10-01', 58.76],
      ['2026-10-07', 59],
    ]);
    h.calls[0]!.ok();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-06`, `PUT /api/months/${OCT}/rates`]);
    expect(h.calls[1]!.body).toEqual({ from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' });
  });

  it('removeMonthRate: a rate saved the other way around is requested in its own direction', async () => {
    h.server.state.months[OCT]!.rates = [{ from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-04' }];
    await h.store.refetch();
    createActions(h.store, OCT, flows).removeMonthRate('USD', 'DOP', '2026-10-04');
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/DOP/USD?date=2026-10-04`]);
  });

  it('if the server rejects the rate, the previous one comes back', async () => {
    createActions(h.store, OCT, flows).setMonthRate('USD', 'DOP', 61, '2026-10-06');
    expect(h.view().months[OCT]!.rates[1]!.rate).toBe(61);
    h.store.flush();
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().months[OCT]!.rates).toEqual(seedState().months[OCT]!.rates);
    expect(h.failures[0]!.action).toMatchObject({ type: 'rate/set', key: OCT });
  });

  it('if the server rejects removing a rate, it reappears; if it no longer had it (404), it counts as removed', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.removeMonthRate('USD', 'DOP', '2026-10-06');
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.rates).toEqual(seedState().months[OCT]!.rates);
    expect(h.failures[0]!.action).toEqual({ type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-06' });

    actions.removeMonthRate('USD', 'DOP', '2026-10-01');
    h.calls[1]!.fail(404, 'not_found');
    await tick();
    expect(h.failures).toHaveLength(1);
  });
});

describe('expenses with their account', () => {
  const flows = {} as Flows;

  it('a new expense comes out of the default account, or of the one given', () => {
    let n = 0;
    const actions = createActions(h.store, OCT, flows, () => `id-${++n}`);
    actions.addFixed({ name: 'Spotify', amount: 6, cur: 'USD' });
    actions.addFixed({ name: 'GitHub', amount: 4, cur: 'USD', accountId: 'us' });
    expect(h.view().months[OCT]!.fixed.slice(-2).map((f) => f.accountId)).toEqual(['dr', 'us']);
    expect(h.calls[0]!.body).toEqual({ id: 'id-1', monthKey: OCT, name: 'Spotify', day: '', amount: 6, cur: 'USD', paid: false, accountId: 'dr' });
  });

  it('changing the account of a row goes out without waiting; an account that does not exist or a negative amount is ignored', () => {
    const actions = createActions(h.store, OCT, flows);
    const netflix = h.fixed('Netflix');
    actions.patchFixed(netflix.id, { accountId: 'us' });
    expect(h.fixed('Netflix').accountId).toBe('us');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/fixed/${netflix.id}`, body: { accountId: 'us' } });

    actions.patchFixed(netflix.id, { accountId: 'gone' });
    actions.patchFixed(netflix.id, { amount: -5 });
    actions.patchTx(h.tx(0).id, { accountId: 'gone', amount: Number.NaN });
    expect(h.store.pendingCount).toBe(1);
    expect(h.fixed('Netflix')).toMatchObject({ accountId: 'us', amount: 1137.3 });
  });
});

describe('transfers', () => {
  const flows = {} as Flows;
  const first = () => h.view().months[OCT]!.transfers[0]!;

  it('with no rate, the new transfer carries the month rate for that pair', () => {
    const actions = createActions(h.store, OCT, flows, () => 'tr-new');
    expect(actions.addTransfer({ date: '2026-10-08', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 300 })).toBe(true);
    expect(h.view().months[OCT]!.transfers.at(-1)).toMatchObject({ id: 'tr-new', amount: 300, rate: 58.76 });
    expect(h.calls[0]!.body).toMatchObject({ fromAccountId: 'us', toAccountId: 'dr', amount: 300, rate: 58.76 });
  });

  it('with no rate, the one it carries is the rate in effect on the transfer date, not the last one typed', async () => {
    // 58 from the 1st and 60 from the 6th.
    h.server.state.months[OCT]!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
    ];
    await h.store.refetch();
    let n = 0;
    const actions = createActions(h.store, OCT, flows, () => `tr-${++n}`);
    const base = { via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 300 };
    expect(actions.addTransfer({ ...base, date: '2026-10-03' })).toBe(true);
    expect(actions.addTransfer({ ...base, date: '2026-10-08' })).toBe(true);
    expect(h.view().months[OCT]!.transfers.slice(-2).map((t) => [t.date, t.rate])).toEqual([
      ['2026-10-03', 58],
      ['2026-10-08', 60],
    ]);
    expect(h.calls[0]!.body).toMatchObject({ id: 'tr-1', date: '2026-10-03', rate: 58 });
    h.calls[0]!.ok();
    await tick();
    expect(h.calls[1]!.body).toMatchObject({ id: 'tr-2', date: '2026-10-08', rate: 60 });
  });

  it('patchTransfer: it is edited like any other cell, with a delay and in a single PATCH', async () => {
    const actions = createActions(h.store, OCT, flows);
    const id = first().id;
    actions.patchTransfer(id, { amount: 1600 });
    actions.patchTransfer(id, { rate: 58.9 });
    actions.patchTransfer(id, { via: 'Wise' });
    expect(first()).toMatchObject({ amount: 1600, rate: 58.9, via: 'Wise' });
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/transfers/${id}`, body: { amount: 1600, rate: 58.9, via: 'Wise' } });
  });

  it('patchTransfer: what is not valid is ignored (same account on both sides, unknown account, rate 0, empty via)', () => {
    const actions = createActions(h.store, OCT, flows);
    const before = first();
    actions.patchTransfer(before.id, { toAccountId: 'us' });
    actions.patchTransfer(before.id, { fromAccountId: 'gone' });
    actions.patchTransfer(before.id, { rate: 0 });
    actions.patchTransfer(before.id, { via: ' ' });
    actions.patchTransfer(before.id, { amount: -1 });
    actions.patchTransfer('nope', { amount: 5 });
    expect(h.store.pendingCount).toBe(0);
    expect(first()).toEqual(before);
  });

  it('patchTransfer: on reversing the transfer the rate becomes the month rate for the new pair', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchTransfer(first().id, { fromAccountId: 'dr', toAccountId: 'us' });
    expect(first()).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(first().rate).toBeCloseTo(1 / 58.76, 12);
    h.store.flush();
    expect(h.calls[0]!.body).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect((h.calls[0]!.body as { rate: number }).rate).toBeCloseTo(1 / 58.76, 12);
  });

  it('if the server rejects the edit, the transfer goes back to how it was', async () => {
    const before = first();
    createActions(h.store, OCT, flows).patchTransfer(before.id, { amount: 9999 });
    h.store.flush();
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(first()).toEqual(before);
    expect(h.failures).toHaveLength(1);
  });
});

describe('incomes', () => {
  const flows = {} as Flows;

  it('addIncome records the income at once, with a client id, and sends it', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-10-15', desc: ' Bonus ', accountId: 'us', amount: 1000, cur: 'USD' })).toBe(true);
    expect(h.view().incomes.at(-1)).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false, rate: null, recurring: false });
    expect(monthCalc(h.view(), OCT).income).toBeCloseTo(6800 * 58.76, 6);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/incomes', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false, rate: null, recurring: false });
  });

  it('addIncome with budget: true sends it flagged and raises the budget of the month of its date at once', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-10-15', desc: 'Freelance', accountId: 'dr', amount: 100, cur: 'USD', budget: true })).toBe(true);
    expect(h.view().incomes.at(-1)).toMatchObject({ id: 'in-new', budget: true });
    expect(h.calls[0]!.body).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Freelance', accountId: 'dr', amount: 100, cur: 'USD', budget: true, rate: null, recurring: false });
    // 100 USD at the rate of its date, in the DR account's part; the month's log does not change.
    expect(monthCalc(h.view(), OCT).budget).toBeCloseTo(70000 + 5876, 8);
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
  });

  it('flagging an income for the budget is a checkbox: it goes out without waiting, and is allowed in a closed month', async () => {
    const actions = createActions(h.store, OCT, flows);
    // September's salary: the month is closed, but the income does not belong to it.
    actions.patchIncome('seed-in-2', { budget: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/incomes/seed-in-2', body: { budget: true } });
    expect(monthCalc(h.view(), '2026-09').budget).toBeGreaterThan(70000);
    // Anything that is not a yes or a no is ignored.
    actions.patchIncome('seed-in-3', { budget: 'yes' as unknown as boolean });
    expect(h.store.pendingCount).toBe(1);

    // If the server rejects it, the budget goes back to how it was.
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().incomes.find((i) => i.id === 'seed-in-2')!.budget).toBe(false);
    expect(monthCalc(h.view(), '2026-09').budget).toBe(70000);
    expect(h.failures).toHaveLength(1);
  });

  it('with no account given it goes into the default account, and is allowed with a date in a closed month', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-08-20', amount: 5000, cur: 'DOP' })).toBe(true);
    expect(h.view().incomes.at(-1)).toMatchObject({ accountId: 'dr', desc: '', date: '2026-08-20' });
  });

  it('patchIncome: a cell edit; the creation arrives first', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    actions.addIncome({ date: '2026-10-15', accountId: 'us', amount: 1000, cur: 'USD' });
    actions.patchIncome('in-new', { amount: 1200 });
    actions.patchIncome('in-new', { desc: 'Bonus' });
    actions.patchIncome('in-new', { amount: -1, accountId: 'gone' });
    expect(h.view().incomes.at(-1)).toMatchObject({ amount: 1200, desc: 'Bonus', accountId: 'us' });
    h.store.flush();
    expect(h.summary()).toEqual(['POST /api/incomes']);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/incomes', 'PATCH /api/incomes/in-new']);
    expect(h.calls[1]!.body).toEqual({ amount: 1200, desc: 'Bonus' });
  });

  it('removeIncome removes it and discards the edit that was waiting', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchIncome('seed-in-3', { amount: 6000 });
    actions.removeIncome('seed-in-3');
    expect(h.view().incomes.map((i) => i.id)).toEqual(['seed-in-1', 'seed-in-2']);
    expect(monthCalc(h.view(), OCT).income).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.summary()).toEqual(['DELETE /api/incomes/seed-in-3']);
  });

  it('if it could not be saved, the income disappears and it is reported', async () => {
    createActions(h.store, OCT, flows, () => 'in-new').addIncome({ date: '2026-10-15', amount: 1000, cur: 'USD' });
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().incomes).toEqual(seedState().incomes);
    expect(h.failures).toHaveLength(1);
  });
});

describe('contributions', () => {
  const flows = {} as Flows;

  it('patchContribution: it is edited without deleting it; changing the goal goes out without waiting', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchContribution('seed-ct-8', { amount: 650 });
    expect(h.calls).toEqual([]);
    actions.patchContribution('seed-ct-8', { goalId: 'personal' });
    expect(h.view().contribs.find((c) => c.id === 'seed-ct-8')).toMatchObject({ amount: 650, goalId: 'personal' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/contributions/seed-ct-8', body: { amount: 650, goalId: 'personal' } });
  });

  it('a goal that does not exist, an impossible date or a negative amount is ignored', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchContribution('seed-ct-8', { goalId: 'marte' });
    actions.patchContribution('seed-ct-8', { date: '2026-02-30' });
    actions.patchContribution('seed-ct-8', { amount: -5 });
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().contribs).toEqual(seedState().contribs);
  });
});

describe('settings · currencies and default account', () => {
  const flows = {} as Flows;

  it('the main currency changes at once and is saved without waiting', () => {
    createActions(h.store, OCT, flows).setMainCurrency('TRY');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['TRY', 'USD']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'TRY' });
  });

  it('choosing as main the one that is currently the second leaves the second as none, in a single request', () => {
    // Frank: main DOP, second USD.
    createActions(h.store, OCT, flows).setMainCurrency('USD');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['USD', null]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'USD', secondCurrency: null });
    // Everything already shows in the new currency, with no figures in a second one.
    expect(monthCalc(h.view(), OCT)).toMatchObject({ main: 'USD', second: null, budgetSecond: null, usedSecond: null, rate: null });
  });

  it('"None" removes the second currency; choosing one brings it back', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setSecondCurrency(null);
    expect(h.view().secondCurrency).toBeNull();
    expect(h.calls[0]!.body).toEqual({ secondCurrency: null });
    actions.setSecondCurrency(null);
    expect(h.calls).toHaveLength(1);
    actions.setSecondCurrency('TRY');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['DOP', 'TRY']);
  });

  it('and the other way around: choosing as second the one that is currently the main swaps them', () => {
    createActions(h.store, OCT, flows).setSecondCurrency('DOP');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['USD', 'DOP']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
  });

  it('the second currency alone, and choosing the one already set does nothing', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMainCurrency('DOP');
    actions.setSecondCurrency('USD');
    actions.setMainCurrency('EUR' as 'USD');
    expect(h.calls).toEqual([]);
    actions.setSecondCurrency('TRY');
    expect(h.calls[0]!.body).toEqual({ secondCurrency: 'TRY' });
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['DOP', 'TRY']);
  });

  it('if the server rejects the swap, both currencies come back', async () => {
    createActions(h.store, OCT, flows).setMainCurrency('USD');
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['DOP', 'USD']);
    expect(h.failures).toHaveLength(1);
  });

  it('the default account: a visible one or null (the automatic one)', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setDefaultAccount('dr');
    actions.setDefaultAccount('gone');
    expect(h.calls).toEqual([]);

    actions.setDefaultAccount('us');
    expect(h.view().defaultAccountId).toBe('us');
    expect(h.calls[0]!.body).toEqual({ defaultAccountId: 'us' });
    // Whatever is added from now on comes out of it.
    actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' });
    expect(h.view().months[OCT]!.fixed.at(-1)!.accountId).toBe('us');

    actions.setDefaultAccount(null);
    expect(h.view().defaultAccountId).toBeNull();
    expect(h.store.pendingCount).toBe(3);
  });

  it('a hidden account cannot be chosen as the default account', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setAccountHidden('us', true);
    actions.setDefaultAccount('us');
    expect(h.view().defaultAccountId).toBe('dr');
    expect(h.calls).toHaveLength(1);
  });

  it('currencies are per user', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows).setMainCurrency('TRY');
    expect(h.calls[0]).toMatchObject({ path: '/api/settings', user: 'eda', body: { mainCurrency: 'TRY' } });
    expect(eda.state!.mainCurrency).toBe('TRY');
    expect(h.view().mainCurrency).toBe('DOP');
  });
});

describe('deleting a month', () => {
  const SEP = '2026-09';

  it('sends what is pending first, deletes it on the server and only then removes it from what is shown', async () => {
    const id = h.view().months[SEP]!.tx[0]!.id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { notes: 'pendiente' } });
    let done = false;
    const deleting = h.store.deleteMonth(SEP).then(() => {
      done = true;
    });
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`]);

    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`, `DELETE /api/months/${SEP}`]);
    expect(h.calls[1]).toMatchObject({ user: 'frank', body: undefined });
    // It is not optimistic: until the server responds, the month is still there.
    expect(h.view().months[SEP]).toBeDefined();
    expect(done).toBe(false);

    Reflect.deleteProperty(h.server.state.months, SEP);
    h.calls[1]!.ok();
    await deleting;
    expect(done).toBe(true);
    expect(Object.keys(h.view().months).sort()).toEqual(['2026-08', OCT]);
    expect(h.failures).toEqual([]);
  });

  it('the balances change accordingly and the incomes stay', async () => {
    const before = balances(h.view(), OCT);
    const deleting = h.store.deleteMonth(SEP);
    await tick();
    h.calls[0]!.ok();
    await deleting;
    const after = balances(h.view(), OCT);
    const of = (b: typeof after, id: string) => b.accounts.find((a) => a.account.id === id)!.balance;
    expect(of(after, 'us')).toBeCloseTo(of(before, 'us') + 2300 + 106, 8);
    expect(of(after, 'dr')).toBeCloseTo(of(before, 'dr') - 134721 + 24555 + 35872.66, 6);
    expect(h.view().incomes).toHaveLength(3);
    expect(h.view().contribs).toHaveLength(8);
  });

  it('if the server rejects it, nothing is touched and the error reaches whoever requested it', async () => {
    const deleting = h.store.deleteMonth(SEP);
    const outcome = deleting.then(
      () => 'deleted',
      (e: unknown) => e,
    );
    await tick();
    h.calls[0]!.fail(500, 'internal');
    expect(await outcome).toMatchObject({ name: 'ApiError', code: 'internal' });
    expect(h.view()).toEqual(seedState());
    // It is not an optimistic write: there is nothing to undo and no save notice.
    expect(h.failures).toEqual([]);
  });

  it('a network failure does not remove it either', async () => {
    const outcome = h.store.deleteMonth(SEP).then(
      () => 'deleted',
      (e: unknown) => e,
    );
    await tick();
    h.calls[0]!.drop();
    expect(await outcome).toMatchObject({ name: 'NetworkError' });
    expect(h.view().months[SEP]).toBeDefined();
  });

  it('if the server no longer had it (404), it counts as deleted', async () => {
    const deleting = h.store.deleteMonth(SEP);
    await tick();
    h.calls[0]!.fail(404, 'not_found');
    await deleting;
    expect(h.view().months[SEP]).toBeUndefined();
  });

  it('a closed month can be deleted, and so can the current month', async () => {
    expect(h.view().months['2026-08']!.closed).toBe(true);
    let deleting = h.store.deleteMonth('2026-08');
    await tick();
    h.calls[0]!.ok();
    await deleting;
    deleting = h.store.deleteMonth(OCT);
    await tick();
    h.calls[1]!.ok();
    await deleting;
    expect(Object.keys(h.view().months)).toEqual([SEP]);
  });

  it('if it was the only month, it does not leave the user with no months: it refetches the state (the server creates the current month)', async () => {
    for (const key of ['2026-08', SEP]) Reflect.deleteProperty(h.server.state.months, key);
    await h.store.refetch();
    expect(Object.keys(h.view().months)).toEqual([OCT]);

    const seen: number[] = [];
    const stop = h.qc.getQueryCache().subscribe(() => {
      const state = h.store.state;
      if (state) seen.push(Object.keys(state.months).length);
    });
    const deleting = h.store.deleteMonth(OCT);
    await tick();
    // What the server does: it deletes the month and, on the next open, creates the current one blank.
    const fresh: Month = { key: '2026-11', closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    h.server.state.months = { '2026-11': fresh };
    h.calls[0]!.ok();
    await deleting;
    stop();

    expect(Object.keys(h.view().months)).toEqual(['2026-11']);
    expect(seen.every((n) => n >= 1)).toBe(true);
  });

  it('a deletion by one user does not touch the months of the other', async () => {
    const eda = await h.switchTo(EDA);
    const deleting = eda.deleteMonth(SEP);
    await tick();
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', path: `/api/months/${SEP}`, user: 'eda' });
    h.calls[0]!.ok();
    await deleting;
    expect(eda.state!.months[SEP]).toBeUndefined();
    expect(h.view().months[SEP]).toBeDefined();
  });
});

describe('moving a row to "Outside budget" and back', () => {
  const outsideOf = () => h.view().months[OCT]!.outside ?? [];

  it('it is a single call: the change shows at once, with what was waiting to change before the move already sent', async () => {
    const tx = h.tx(0);
    const actions = createActions(h.store, OCT, {} as Flows, () => 'out-1');
    // A delayed edit of the same row goes out before the "move": it does not arrive later at a row that is already gone.
    actions.patchTx(tx.id, { desc: 'Renamed' });
    actions.moveTxOutside(tx.id);
    expect(h.view().months[OCT]!.tx.some((t) => t.id === tx.id)).toBe(false);
    expect(outsideOf()).toEqual([expect.objectContaining({ id: 'out-1', name: 'Renamed', amount: tx.amount, accountId: tx.accountId })]);
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${tx.id}`]);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${tx.id}`, `POST /api/transactions/${tx.id}/move-outside`]);
    expect(h.calls[1]!.body).toEqual({ id: 'out-1' });
    h.calls[1]!.ok();
    await tick();
    expect(h.failures).toEqual([]);
  });

  it('if the server rejects it, the transaction comes back and no outside-budget copy is left', async () => {
    const tx = h.tx(0);
    const count = h.view().months[OCT]!.tx.length;
    createActions(h.store, OCT, {} as Flows, () => 'out-1').moveTxOutside(tx.id);
    await tick();
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.tx).toHaveLength(count);
    expect(outsideOf()).toEqual([]);
    expect(h.failures[0]!.action).toMatchObject({ type: 'tx/moveOutside', id: tx.id });
  });

  it('the way back requests POST …/move-to-budget with the id of the new row, after creating the row', async () => {
    const ids = ['o-1', 'tx-new'];
    const actions = createActions(h.store, OCT, {} as Flows, () => ids.shift()!);
    expect(actions.addOutside({ date: '2026-10-07', name: 'Repair', amount: 30, desc: 'radiator' })).toBe(true);
    actions.moveOutsideToBudget('o-1');
    expect(outsideOf()).toEqual([]);
    expect(h.view().months[OCT]!.tx.at(-1)).toMatchObject({ id: 'tx-new', desc: 'Repair', cat: 'Other', method: 'Transfer', notes: 'radiator' });
    await tick();
    expect(h.summary()).toEqual(['POST /api/outside-expenses']);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual(['POST /api/outside-expenses', 'POST /api/outside-expenses/o-1/move-to-budget']);
    expect(h.calls[1]!.body).toEqual({ id: 'tx-new' });
  });
});
