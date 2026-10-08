// La capa de datos de punta a punta, sin React: FinanzasStores + QueryClient + el cliente HTTP real sobre un fetch falso.
// El "servidor" tiene dos usuarios, cada uno con sus datos, y apunta con qué cabecera X-User llega cada petición.

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
  /** Cabecera X-User con la que llegó. */
  user: string | null;
  body: unknown;
  keepalive: boolean;
  ok(): void;
  fail(status: number, code: string): void;
  /** Sin respuesta: fallo de red. */
  drop(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Deja correr las promesas y los temporizadores de 0 ms. */
const tick = () => vi.advanceTimersByTimeAsync(0);

/** Eda empieza con los mismos datos de ejemplo (mismos ids de fila, a propósito) pero en turco y con otro presupuesto. */
function edaState(): AppState {
  const state = seedState();
  state.language = 'tr';
  setBudgets(state.months[OCT]!, { dr: 50000 });
  return state;
}

async function setup() {
  const server = { state: seedState(), eda: edaState(), gets: 0, holdGets: false };
  /** Escrituras recibidas; cada prueba decide cuándo y cómo responde el "servidor". */
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
  // Un observador, como el useQuery de la app: sin él invalidateQueries no vuelve a pedir nada.
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
    /** Cambia de usuario como la app: deja de mirar al anterior y carga al otro. Devuelve su store ya cargada. */
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

describe('carga', () => {
  it('trae el estado una vez y lo deja en la caché de ["state", usuario]', () => {
    expect(h.server.gets).toBe(1);
    expect(h.view()).toEqual(seedState());
    expect(h.store.key).toEqual(['state', 'frank']);
    expect(h.qc.getQueryData(stateKey('frank'))).toEqual({ user: FRANK, state: seedState() });
    expect(h.store.pendingCount).toBe(0);
  });

  it('pide el estado con la cabecera de su usuario', async () => {
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

describe('ediciones de celda', () => {
  it('se ven en el acto y salen juntas, en un PATCH por fila, pasado el retraso', async () => {
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

  it('casilla y lista salen sin esperar', () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(1).id, patch: { cat: 'Travel' } });
    expect(h.summary()).toEqual([`PATCH /api/fixed/${netflix.id}`]);
    expect(h.calls[0]!.body).toEqual({ paid: true });
    expect(h.fixed('Netflix').paid).toBe(true);
    // La segunda espera a que responda la primera (ver "orden").
    expect(h.store.pendingCount).toBe(2);
  });

  it('una casilla se lleva consigo lo que la fila tuviera esperando', () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { amount: 1200 } });
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ amount: 1200, paid: true });
  });

  it('flush() manda ya lo que esperaba su retraso', () => {
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000 } } });
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { us: 500 } } });
    expect(h.calls).toEqual([]);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/months/${OCT}`, body: { budgets: { dr: 80000, us: 500 } } });
  });

  it('un patch vacío no hace nada', () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: {} });
    expect(h.store.pendingCount).toBe(0);
  });
});

describe('orden', () => {
  it('las peticiones salen de una en una, en el orden de las ediciones', async () => {
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

  it('el alta de una fila llega antes que su edición', async () => {
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

describe('fallos', () => {
  it('deshace solo el cambio rechazado y avisa', async () => {
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

  it('un fallo de red también se deshace', async () => {
    const before = h.tx(0).desc;
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'otra cosa' } });
    h.store.flush();
    h.calls[0]!.drop();
    await tick();
    expect(h.tx(0).desc).toBe(before);
    expect(h.failures[0]!.error).toMatchObject({ name: 'NetworkError' });
  });

  it('si no se pudo crear la fila, no se manda lo que venía detrás para ella', async () => {
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

  it('borrar algo que el servidor ya no tiene cuenta como hecho', async () => {
    const id = h.tx(0).id;
    const month = h.server.state.months[OCT]!;
    month.tx = month.tx.filter((t) => t.id !== id);
    h.store.dispatch({ type: 'tx/remove', id });
    // Antes de que el refresco posterior lo confirme, la fila ya no vuelve a aparecer.
    h.server.holdGets = true;
    h.calls[0]!.fail(404, 'not_found');
    await tick();
    expect(h.failures).toEqual([]);
    expect(h.view().months[OCT]!.tx.some((t) => t.id === id)).toBe(false);
    h.heldGets[0]!();
    await tick();
    expect(h.view().months[OCT]!.tx.some((t) => t.id === id)).toBe(false);
  });

  it('eliminar una fila descarta la edición que tenía esperando', async () => {
    const id = h.tx(0).id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'a medias' } });
    h.store.dispatch({ type: 'tx/remove', id });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.summary()).toEqual([`DELETE /api/transactions/${id}`]);
  });
});

describe('refetch', () => {
  it('invalida su consulta una sola vez, cuando ya no queda nada pendiente', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Cluely').id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'x' } });

    h.calls[0]!.ok();
    await tick();
    h.calls[1]!.ok();
    await tick();
    // Queda la edición de texto esperando su retraso: todavía no se pide nada.
    expect(h.server.gets).toBe(1);

    await vi.advanceTimersByTimeAsync(400);
    h.calls[2]!.ok();
    await tick();
    expect(h.server.gets).toBe(2);
    expect(h.store.pendingCount).toBe(0);
  });

  it('también vuelve a pedir tras un fallo', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.calls[0]!.fail(500, 'internal');
    await tick();
    expect(h.server.gets).toBe(2);
  });

  it('un refetch no pisa las ediciones sin confirmar', async () => {
    const id = h.tx(0).id;
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'sin guardar' } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });

    // Llega un refresco (p. ej. al volver a la pestaña) con algo nuevo del servidor y sin nuestras ediciones.
    setBudgets(h.server.state.months[OCT]!, { dr: 75000 });
    await h.store.refetch();

    expect(h.server.gets).toBe(2);
    expect(h.view().months[OCT]!.budgets.dr).toBe(75000);
    expect(h.tx(0).desc).toBe('sin guardar');
    expect(h.fixed('Netflix').paid).toBe(true);
  });

  it('una edición cancela el GET en vuelo: su respuesta ya no llega a la caché', async () => {
    setBudgets(h.server.state.months[OCT]!, { dr: 1 });
    h.server.holdGets = true;
    const refetch = h.store.refetch();
    await tick();
    expect(h.heldGets).toHaveLength(1);

    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'nueva' } });
    h.heldGets[0]!();
    await refetch;
    await tick();

    // La foto de ese GET (presupuesto 1) se quedó por el camino…
    expect(h.tx(0).desc).toBe('nueva');
    expect(h.view().months[OCT]!.budgets.dr).toBe(70000);

    // …y lo nuevo del servidor llega con el refresco de después de guardar.
    h.server.holdGets = false;
    h.store.flush();
    h.calls[0]!.ok();
    await tick();
    expect(h.view().months[OCT]!.budgets.dr).toBe(1);
  });

  it('descarta la foto de un GET que empezó antes de una escritura ya confirmada', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });

    // El GET sale con la primera escritura todavía en vuelo: su foto no la incluye.
    h.server.holdGets = true;
    void h.store.refetch();
    await tick();
    h.calls[0]!.ok();
    await tick();
    h.heldGets[0]!();
    await tick();
    expect(h.fixed('Netflix').paid).toBe(true);

    // Y la base tampoco retrocedió: al deshacer la segunda, la primera sigue ahí.
    h.calls[1]!.fail(500, 'internal');
    await tick();
    expect(h.fixed('Netflix').paid).toBe(true);
    expect(h.fixed('Cluely').paid).toBe(false);
  });
});

describe('settle y cierre de página', () => {
  it('settle() manda lo pendiente y espera a que el servidor responda a todo', async () => {
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

  it('settle() sin nada pendiente resuelve enseguida', async () => {
    await expect(h.store.settle()).resolves.toBeUndefined();
  });

  it('al cerrar la página lanza todo de golpe y con keepalive', () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Cluely').id, patch: { paid: true } });
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'última' } });
    expect(h.calls).toHaveLength(1);

    h.store.flush({ unload: true });
    expect(h.calls).toHaveLength(3);
    expect(h.calls.map((c) => c.keepalive)).toEqual([false, true, true]);
  });

  it('applyServer incorpora lo que devolvió el servidor conservando lo pendiente', () => {
    h.store.dispatch({ type: 'tx/patch', id: h.tx(0).id, patch: { desc: 'pendiente' } });
    h.store.applyServer((s) => ({ ...s, defaultRate: 60 }));
    expect(h.view().defaultRate).toBe(60);
    expect(h.tx(0).desc).toBe('pendiente');
  });
});

describe('acciones', () => {
  const flows = {} as Flows;

  it('una fila inválida no se agrega ni se envía', () => {
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

  it('las filas nuevas van al mes seleccionado con un id del cliente', () => {
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

  it('por defecto genera un UUID', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' });
    expect((h.calls[0]!.body as { id: string }).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reopenMonth reabre el mes seleccionado o el que se le pase', () => {
    createActions(h.store, '2026-09', flows).reopenMonth();
    createActions(h.store, OCT, flows).reopenMonth('2026-08');
    expect(h.view().months['2026-09']!.closed).toBe(false);
    expect(h.view().months['2026-08']!.closed).toBe(false);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/months/2026-09/reopen' });
  });

  it('un concepto o una descripción en blanco no se guardan; el resto del patch sí', () => {
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

  it('sin mes seleccionado no agrega nada', () => {
    const actions = createActions(h.store, null, flows);
    expect(actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' })).toBe(false);
    actions.reopenMonth();
    expect(h.calls).toEqual([]);
  });
});

describe('usuarios', () => {
  it('cada usuario tiene su store, siempre la misma, con su clave y sus datos', async () => {
    const eda = await h.switchTo(EDA);
    expect(eda).not.toBe(h.store);
    expect(h.stores.for('eda')).toBe(eda);
    expect(h.stores.for('frank')).toBe(h.store);
    expect(eda.userId).toBe('eda');
    expect(eda.key).toEqual(['state', 'eda']);
    expect(h.qc.getQueryData(stateKey('eda'))).toMatchObject({ user: EDA });
    // Con el otro usuario llegan su idioma y sus cifras; los de Frank siguen en su caché.
    expect(eda.state!.language).toBe('tr');
    expect(eda.state!.months[OCT]!.budgets.dr).toBe(50000);
    expect(h.view().language).toBe('en');
    expect(h.view().months[OCT]!.budgets.dr).toBe(70000);
  });

  it('todas las escrituras de una store llevan la cabecera de su usuario', async () => {
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

  it('una edición que esperaba su retraso sale con el usuario para el que se hizo, aunque ya se esté viendo a otro', async () => {
    const id = h.tx(0).id;
    // Frank escribe en una celda: la edición queda esperando sus 400 ms…
    h.store.dispatch({ type: 'tx/patch', id, patch: { desc: 'Frank typed this' } });
    expect(h.calls).toEqual([]);

    // …y antes de que salga se cambia a Eda, que edita la fila que en sus datos tiene ese mismo id.
    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'tx/patch', id, patch: { desc: 'Eda typed this' } });

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls.map((c) => [c.user, c.path, c.body])).toEqual([
      ['frank', `/api/transactions/${id}`, { desc: 'Frank typed this' }],
      ['eda', `/api/transactions/${id}`, { desc: 'Eda typed this' }],
    ]);
    // Cada uno ve lo suyo.
    expect(h.tx(0).desc).toBe('Frank typed this');
    expect(eda.state!.months[OCT]!.tx[0]!.desc).toBe('Eda typed this');
  });

  it('al cambiar de usuario, flush() manda ya lo pendiente del anterior, con su cabecera', async () => {
    h.store.dispatch({ type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000 } } });
    // Lo que hace la app al cambiar de usuario: flush de todas las stores y a cargar al otro.
    h.stores.flush();
    const eda = await h.switchTo(EDA);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/months/${OCT}`, user: 'frank', body: { budgets: { dr: 80000 } } });
    // El presupuesto de Eda no se ha movido.
    expect(eda.state!.months[OCT]!.budgets.dr).toBe(50000);
  });

  it('lo que estaba en cola detrás de una petición en vuelo también sale con su usuario', async () => {
    const netflix = h.fixed('Netflix');
    const cluely = h.fixed('Cluely');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/patch', id: cluely.id, patch: { paid: true } });
    h.store.dispatch({ type: 'fixed/remove', id: h.fixed('Smartfit').id });
    // Solo ha salido la primera; las otras dos esperan turno.
    expect(h.calls).toHaveLength(1);

    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    // Las colas son independientes: la de Eda no espera a la de Frank.
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

  it('las acciones creadas para un usuario siguen escribiendo en sus datos después del cambio', async () => {
    // Un componente que se quedó con las acciones de Frank (un cierre viejo) y las usa tarde.
    const franks = createActions(h.store, OCT, {} as Flows, () => 'late');
    const eda = await h.switchTo(EDA);
    expect(franks.addFixed({ name: 'Late', amount: 1, cur: 'DOP' })).toBe(true);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/fixed', user: 'frank' });
    expect(h.view().months[OCT]!.fixed.some((f) => f.id === 'late')).toBe(true);
    expect(eda.state!.months[OCT]!.fixed.some((f) => f.id === 'late')).toBe(false);
  });

  it('un rechazo tardío deshace el cambio en los datos de su dueño y dice de quién era', async () => {
    const netflix = h.fixed('Netflix');
    h.store.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    const eda = await h.switchTo(EDA);
    eda.dispatch({ type: 'fixed/patch', id: netflix.id, patch: { paid: true } });

    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ userId: 'frank', action: { type: 'fixed/patch', id: netflix.id } });
    expect(h.fixed('Netflix').paid).toBe(false);
    // La edición de Eda sobre su fila sigue en pie.
    expect(eda.state!.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!.paid).toBe(true);
  });

  it('al terminar lo pendiente de un usuario que ya no se ve, no se le vuelve a pedir el estado', async () => {
    h.store.dispatch({ type: 'fixed/patch', id: h.fixed('Netflix').id, patch: { paid: true } });
    await h.switchTo(EDA);
    const gets = h.server.gets;
    h.calls[0]!.ok();
    await tick();
    expect(h.server.gets).toBe(gets);
    // Al volver a Frank sí se refresca, y ya trae el cambio confirmado.
    h.server.state.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!.paid = true;
    await h.switchTo(FRANK);
    expect(h.server.gets).toBe(gets + 1);
    expect(h.fixed('Netflix').paid).toBe(true);
  });

  it('al cerrar la página sale lo pendiente de todos, cada cosa con su usuario', async () => {
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

describe('ajustes', () => {
  const flows = {} as Flows;
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('el idioma cambia en el acto y se guarda sin esperar', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setLanguage('es');
    expect(h.view().language).toBe('es');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank', body: { language: 'es' } });
  });

  it('una vez guardado, el idioma sobrevive al refresco', async () => {
    createActions(h.store, OCT, flows).setLanguage('tr');
    h.server.state.language = 'tr';
    h.calls[0]!.ok();
    await tick();
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().language).toBe('tr');
  });

  it('si el servidor lo rechaza, vuelve el idioma anterior y se avisa', async () => {
    createActions(h.store, OCT, flows).setLanguage('tr');
    h.calls[0]!.fail(500, 'internal');
    await tick();
    expect(h.view().language).toBe('en');
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.action).toEqual({ type: 'settings/patch', patch: { language: 'tr' } });
  });

  it('elegir el idioma que ya está, o uno que no existe, no hace nada', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setLanguage('en');
    actions.setLanguage('fr' as 'en');
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('el idioma es de cada usuario', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows).setLanguage('es');
    expect(h.calls[0]).toMatchObject({ path: '/api/settings', user: 'eda', body: { language: 'es' } });
    expect(eda.state!.language).toBe('es');
    expect(h.view().language).toBe('en');
  });

  it('los colores se ven en el acto y se guardan una vez, con el último valor, pasado el retraso', async () => {
    const actions = createActions(h.store, OCT, flows);
    // Arrastrar el selector de color: muchos cambios seguidos.
    for (const accent of ['#2a6f90', '#2a6f95', '#2a6f97']) actions.setTheme({ ...ocean, accent });
    expect(h.view().theme).toEqual(ocean);
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank', body: { theme: ocean } });
  });

  it('los colores se normalizan, y los originales (o null) se guardan como null', async () => {
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

  it('un tema no válido, o el mismo que ya había, no hace nada', () => {
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

  it('si no se pudieron guardar, vuelven los colores anteriores', async () => {
    createActions(h.store, OCT, flows).setTheme(ocean);
    h.store.flush();
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().theme).toBeNull();
    expect(h.failures).toHaveLength(1);
  });

  it('un cambio de idioma se lleva consigo los colores que esperaban', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setTheme(ocean);
    actions.setLanguage('es');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ theme: ocean, language: 'es' });
  });
});

describe('metas', () => {
  const flows = {} as Flows;
  const plan = { monthly: 500, start: '2026-10', end: '2027-09' };

  it('addGoal crea la meta en el acto, con un id del cliente, y la manda con su moneda', () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    expect(actions.addGoal({ name: ' Car ', cur: 'TRY', ...plan })).toBe(true);
    expect(h.view().goals.at(-1)).toEqual({ id: 'goal-new', name: 'Car', cur: 'TRY', ...plan, approxCur: null, sort: 3 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/goals', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Car', cur: 'TRY', ...plan, approxCur: null });
  });

  it('addGoal manda la moneda de la línea "≈" de la meta; patchGoal la cambia y la devuelve a la principal con null', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    expect(actions.addGoal({ name: 'Car', cur: 'USD', approxCur: 'TRY' })).toBe(true);
    expect(h.view().goals.at(-1)).toMatchObject({ id: 'goal-new', cur: 'USD', approxCur: 'TRY' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Car', cur: 'USD', monthly: null, start: null, end: null, approxCur: 'TRY' });
    expect(actions.addGoal({ name: 'Boat', approxCur: 'EUR' as 'USD' })).toBe(false);

    expect(actions.patchGoal('goal-new', { approxCur: null })).toBe(true);
    expect(h.view().goals.at(-1)!.approxCur).toBeNull();
    // Lo que ya tiene no se manda.
    expect(actions.patchGoal('goal-new', { approxCur: null })).toBe(true);
    expect(actions.patchGoal('turkey', { approxCur: null })).toBe(true);
    expect(actions.patchGoal('turkey', { approxCur: 'EUR' as 'USD' })).toBe(false);
    expect(actions.patchGoal('turkey', { approxCur: 'DOP' })).toBe(true);
    for (let i = 0; i < 3; i++) {
      h.calls[i]!.ok();
      await tick();
    }
    expect(h.summary()).toEqual(['POST /api/goals', 'PATCH /api/goals/goal-new', 'PATCH /api/goals/turkey']);
    // null viaja como null: es un valor, no un campo que falta.
    expect(h.calls[1]!.body).toEqual({ approxCur: null });
    expect(h.calls[2]!.body).toEqual({ approxCur: 'DOP' });
  });

  it('una meta sin plan viaja con los tres campos en null y, sin moneda indicada, en la principal', () => {
    createActions(h.store, OCT, flows, () => 'goal-new').addGoal({ name: 'Rainy day' });
    expect(h.calls[0]!.body).toEqual({ id: 'goal-new', name: 'Rainy day', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null });
  });

  it('una meta inválida ni se ve ni se envía', () => {
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

  it('patchGoal se guarda de una vez, sin retraso, con el plan completo', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.patchGoal('turkey', { name: 'Istanbul', monthly: 2500 })).toBe(true);
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ name: 'Istanbul', monthly: 2500, start: '2026-08', end: '2027-10' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/goals/turkey' });
    expect(h.calls[0]!.body).toEqual({ name: 'Istanbul', monthly: 2500, start: '2026-08', end: '2027-10' });
  });

  it('cambiar la moneda de una meta manda solo la moneda', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { cur: 'TRY' })).toBe(true);
    expect(h.calls[0]!.body).toEqual({ cur: 'TRY' });
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ cur: 'TRY', monthly: 3000 });
  });

  it('quitarle el plan a una meta manda los tres campos en null', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { monthly: null, start: null, end: null })).toBe(true);
    expect(h.calls[0]!.body).toEqual({ monthly: null, start: null, end: null });
    expect(h.view().goals.find((g) => g.id === 'turkey')).toMatchObject({ monthly: null, start: null, end: null });
  });

  it('guardar sin cambios es válido y no manda nada', () => {
    expect(createActions(h.store, OCT, flows).patchGoal('turkey', { name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10' })).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('removeGoal se niega si la meta tiene aportes', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.removeGoal('turkey')).toBe(false);
    expect(actions.removeGoal('nope')).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.view().goals).toHaveLength(3);
  });

  it('removeGoal elimina una meta sin aportes; borrados sus aportes, también las demás', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'goal-new');
    actions.addGoal({ name: 'Car' });
    expect(actions.removeGoal('goal-new')).toBe(true);
    expect(h.view().goals.some((g) => g.id === 'goal-new')).toBe(false);

    for (const c of h.view().contribs.filter((x) => x.goalId === 'personal')) actions.removeContribution(c.id);
    expect(actions.removeGoal('personal')).toBe(true);
    expect(h.view().goals.map((g) => g.id)).toEqual(['emergency', 'turkey']);

    // Salen en orden: alta, baja, los dos aportes y, al final, la meta.
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

  it('el alta de una meta llega antes que su edición y que su primer aporte', async () => {
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

  it('si no se pudo crear la meta, se deshace y no se manda su edición', async () => {
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

  it('si el servidor dice que la meta tiene aportes (409), vuelve a aparecer', async () => {
    const state = h.server.state;
    state.contribs = state.contribs.filter((c) => c.goalId !== 'personal');
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).removeGoal('personal')).toBe(true);
    h.calls[0]!.fail(409, 'conflict');
    await tick();
    expect(h.view().goals.some((g) => g.id === 'personal')).toBe(true);
    expect(h.failures[0]!.error).toMatchObject({ code: 'conflict' });
  });

  it('las metas son de cada usuario', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows, () => 'eda-goal').addGoal({ name: 'Ev' });
    expect(h.calls[0]).toMatchObject({ path: '/api/goals', user: 'eda' });
    expect(h.view().goals.some((g) => g.id === 'eda-goal')).toBe(false);
  });
});

describe('cuentas', () => {
  const flows = {} as Flows;
  const balance = (id: string, state: AppState = h.view()) => balances(state, OCT).accounts.find((a) => a.account.id === id)!.balance;

  it('addAccount crea la cuenta en el acto, con un id del cliente, y la manda', () => {
    const actions = createActions(h.store, OCT, flows, () => 'acc-new');
    expect(actions.addAccount({ name: ' TR account ', currency: 'TRY', opening: 1500 })).toBe(true);
    expect(h.view().accounts.at(-1)).toEqual({ id: 'acc-new', name: 'TR account', currency: 'TRY', opening: 1500, hidden: false, sort: 2 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/accounts', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'acc-new', name: 'TR account', currency: 'TRY', opening: 1500 });
  });

  it('el alta de una cuenta llega antes que lo que se pague desde ella', async () => {
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

  it('renombrar es una edición de celda: sale pasado el retraso, con el último nombre', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.renameAccount('us', 'Cha');
    actions.renameAccount('us', 'Chase');
    expect(h.view().accounts.find((a) => a.id === 'us')!.name).toBe('Chase');
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/us', body: { name: 'Chase' } });
  });

  it('un nombre en blanco no se guarda', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.renameAccount('us', '   ');
    actions.renameAccount('gone', 'Chase');
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().accounts.find((a) => a.id === 'us')!.name).toBe('US account');
  });

  it('ocultar y mostrar salen sin esperar; la última cuenta visible no se puede ocultar', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.setAccountHidden('us', true)).toBe(true);
    expect(h.view().accounts.find((a) => a.id === 'us')!.hidden).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/us', body: { hidden: true } });
    // Oculta deja de sumar al dinero total.
    expect(balances(h.view(), OCT).totalMain).toBeCloseTo(balance('dr'), 6);

    expect(actions.setAccountHidden('dr', true)).toBe(false);
    expect(actions.setAccountHidden('gone', true)).toBe(false);
    expect(h.view().accounts.find((a) => a.id === 'dr')!.hidden).toBe(false);

    expect(actions.setAccountHidden('us', false)).toBe(true);
    expect(h.view().accounts.find((a) => a.id === 'us')!.hidden).toBe(false);
    // Pedir lo que ya está no manda nada.
    expect(actions.setAccountHidden('us', false)).toBe(true);
    expect(h.store.pendingCount).toBe(2);
  });

  it('removeAccount se niega si algo usa la cuenta; una sin usar se elimina', async () => {
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

  it('si el servidor dice que la cuenta está en uso (409), vuelve a aparecer', async () => {
    h.server.state.accounts.push({ id: 'spare', name: 'Spare', currency: 'USD', opening: 0, hidden: true, sort: 2 });
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).removeAccount('spare')).toBe(true);
    h.calls[0]!.fail(409, 'conflict');
    await tick();
    expect(h.view().accounts.some((a) => a.id === 'spare')).toBe(true);
    expect(h.failures[0]!.error).toMatchObject({ code: 'conflict' });
  });

  it('setAccountBalance guarda el saldo inicial que produce el saldo escrito', async () => {
    const actions = createActions(h.store, OCT, flows);
    // DR account: 220,641.93 con un inicial de 60,000. Para ver 200,000 el inicial tiene que ser 39,358.07.
    expect(actions.setAccountBalance('dr', 200000)).toBe(true);
    expect(balance('dr')).toBeCloseTo(200000, 6);
    expect(h.view().accounts.find((a) => a.id === 'dr')!.opening).toBeCloseTo(39358.07, 6);
    // Los movimientos no se tocan.
    expect(h.view().months).toEqual(seedState().months);
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/accounts/dr' });
    expect((h.calls[0]!.body as { opening: number }).opening).toBeCloseTo(39358.07, 6);
    expect(Object.keys(h.calls[0]!.body as object)).toEqual(['opening']);
  });

  it('escribir el saldo cifra a cifra acaba en un solo PATCH con el inicial del último saldo', () => {
    const actions = createActions(h.store, OCT, flows);
    for (const typed of [1, 15, 150, 1500]) actions.setAccountBalance('us', typed);
    expect(balance('us')).toBeCloseTo(1500, 8);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    // US account: 13,482 con un inicial de 2,000 → 1,500 pide −9,982.
    expect((h.calls[0]!.body as { opening: number }).opening).toBeCloseTo(2000 + (1500 - 13482), 8);
  });

  it('setAccountBalance se niega en un mes que no es el último: los saldos pasados son historia', () => {
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

  it('las cuentas son de cada usuario', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows, () => 'eda-acc').addAccount({ name: 'Garanti', currency: 'TRY' });
    expect(h.calls[0]).toMatchObject({ path: '/api/accounts', user: 'eda' });
    expect(h.view().accounts.some((a) => a.id === 'eda-acc')).toBe(false);
  });
});

describe('presupuesto y tasas del mes', () => {
  const flows = {} as Flows;

  it('setBudgetPart: cada cuenta es una celda; salen juntas en un PATCH del mes', async () => {
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

  it('setBudgetPart: 0 quita la parte; una cuenta que no existe o un mes cerrado no se envían', () => {
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

  it('si el servidor rechaza el presupuesto, vuelve el anterior', async () => {
    createActions(h.store, OCT, flows).setBudgetPart('dr', 99000);
    h.store.flush();
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
    expect(h.failures).toHaveLength(1);
  });

  it('setBudgetPart: no sobrescribe; añade al registro la diferencia, con fecha de hoy', async () => {
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
    // Al servidor va la parte, no el movimiento: la diferencia la calcula él contra su registro.
    h.store.flush();
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 82000, us: 200 } });
    // Escribir lo que ya suma no añade nada ni se queda a la vista.
    h.calls[0]!.ok();
    await tick();
    expect(actions.setBudgetPart('dr', 70000)).toBe(true);
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
  });

  it('setBudgetPart: si hoy cae fuera del mes seleccionado, la fecha se lleva al mes', () => {
    createActions(h.store, OCT, flows, undefined, () => '2026-11-03').setBudgetPart('dr', 71000);
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toMatchObject({ date: '2026-10-31', amount: 1000 });
    createActions(h.store, OCT, flows, undefined, () => '2026-09-30').setBudgetPart('us', 5);
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toMatchObject({ date: '2026-10-01', accountId: 'us', amount: 5 });
  });

  it('setBudgetPart: con un ingreso que sube el presupuesto, se escribe la parte como se ve y viaja lo que suma el registro', async () => {
    h.server.state.incomes.push({ id: 'in-budget', date: '2026-10-10', desc: 'Freelance', accountId: 'dr', amount: 10000, cur: 'DOP', budget: true });
    await h.store.refetch();
    const part = () => monthCalc(h.view(), OCT).budgetParts.find((p) => p.account.id === 'dr')!;
    expect(part()).toMatchObject({ amount: 80000, fromLog: 70000, fromIncomes: 10000 });

    const actions = createActions(h.store, OCT, flows);
    expect(actions.setBudgetPart('dr', 85000)).toBe(true);
    expect(part()).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
    // Por debajo de lo que ya ponen los ingresos no se puede: el registro quedaría en negativo.
    expect(actions.setBudgetPart('dr', 9000)).toBe(false);
    expect(part().amount).toBe(85000);
    h.store.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 75000 } });
  });

  it('addBudgetEntry: añade un movimiento al registro en el acto y lo manda sin esperar', () => {
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

  it('addBudgetEntry: un recorte, con su fecha y su tipo; lo que no vale ni se ve ni se envía', async () => {
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

    // Si el servidor lo rechaza, desaparece.
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.failures[0]!.action).toMatchObject({ type: 'budget/add', key: OCT });
  });

  it('removeBudgetEntry: quita el movimiento en el acto y manda el DELETE', async () => {
    const actions = createActions(h.store, OCT, flows);
    // El ajuste del día 5 (5,000).
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(true);
    expect(h.view().months[OCT]!.budgetLog.map((e) => e.id)).toEqual(['seed-bg-2026-10-1']);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 65000 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'DELETE', path: `/api/months/${OCT}/budget-log/seed-bg-2026-10-2`, user: 'frank' });
    expect(h.calls[0]!.body).toBeUndefined();
    // Ya no está: pedirlo otra vez no hace nada.
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(false);
    expect(h.store.pendingCount).toBe(1);

    // Si el servidor ya no lo tenía (404), era lo que se quería.
    h.calls[0]!.fail(404, 'not_found');
    await tick();
    expect(h.failures).toEqual([]);
  });

  it('removeBudgetEntry: false si no está, si el mes está cerrado o si aún no tiene id del servidor', () => {
    const actions = createActions(h.store, OCT, flows);
    expect(actions.removeBudgetEntry('nope')).toBe(false);
    expect(createActions(h.store, '2026-09', flows).removeBudgetEntry('seed-bg-2026-09-1')).toBe(false);
    expect(createActions(h.store, null, flows).removeBudgetEntry('seed-bg-2026-10-2')).toBe(false);
    // El movimiento que acaba de añadir setBudgetPart es local: su id lo pone el servidor.
    actions.setBudgetPart('us', 200);
    const local = h.view().months[OCT]!.budgetLog.at(-1)!;
    expect(local.id.startsWith('local-')).toBe(true);
    expect(actions.removeBudgetEntry(local.id)).toBe(false);
    expect(h.view().months[OCT]!.budgetLog).toHaveLength(3);
    expect(h.calls).toEqual([]);
  });

  it('removeBudgetEntry: la parte que esperaba su retraso sale antes que el borrado', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setBudgetPart('dr', 80000);
    expect(h.calls).toEqual([]);
    expect(actions.removeBudgetEntry('seed-bg-2026-10-2')).toBe(true);
    // El PATCH (que contaba con ese movimiento) ya salió; el DELETE espera su turno.
    expect(h.summary()).toEqual([`PATCH /api/months/${OCT}`]);
    expect(h.calls[0]!.body).toEqual({ budgets: { dr: 80000 } });
    // 80,000 menos los 5,000 del movimiento quitado, igual que hará el servidor.
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 75000 });
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/months/${OCT}`, `DELETE /api/months/${OCT}/budget-log/seed-bg-2026-10-2`]);
  });

  it('si el servidor rechaza el borrado, el movimiento vuelve', async () => {
    createActions(h.store, OCT, flows).removeBudgetEntry('seed-bg-2026-10-1');
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 5000 });
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
    expect(h.failures[0]!.action).toEqual({ type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-1' });
  });

  it('addLeftover: suma lo que sobró del mes anterior en el acto y lo pide con un POST sin cuerpo', () => {
    const sep = monthCalc(h.view(), '2026-09').avail;
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    expect(actions.addLeftover()).toBe(true);
    // Lo que se ve mientras responde: en la cuenta por defecto, con un id local.
    expect(h.view().months[OCT]!.budgetLog.at(-1)).toEqual({ id: 'local-lo', date: '2026-10-09', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    expect(monthCalc(h.view(), OCT).budget).toBeCloseTo(70000 + sep, 8);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: `/api/months/${OCT}/leftover`, user: 'frank' });
    // La cifra la calcula el servidor: no viaja.
    expect(h.calls[0]!.body).toBeUndefined();
    // Uno por mes: mientras esté a la vista no se puede repetir.
    expect(actions.addLeftover()).toBe(false);
    expect(h.store.pendingCount).toBe(1);
  });

  it('addLeftover: si el servidor dice que ya lo tenía (409), se deshace', async () => {
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

  it('addLeftover: confirmado, el refresco trae el movimiento del servidor y queda uno solo, ya con su id', async () => {
    const sep = monthCalc(h.view(), '2026-09').avail;
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    actions.addLeftover();
    // Lo que hace el servidor: lo escribe con su propio id.
    h.server.state.months[OCT]!.budgetLog.push({ id: 'srv-lo', date: '2026-10-09', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    h.calls[0]!.ok();
    await tick();
    expect(h.view().months[OCT]!.budgetLog.filter((e) => e.kind === 'leftover').map((e) => e.id)).toEqual(['srv-lo']);
    // Ya sumado: no se ofrece otra vez; quitado (ahora sí tiene id), se puede volver a sumar.
    expect(actions.addLeftover()).toBe(false);
    expect(actions.removeBudgetEntry('srv-lo')).toBe(true);
    expect(actions.addLeftover()).toBe(true);
    expect(h.summary().slice(1)).toEqual([`DELETE /api/months/${OCT}/budget-log/srv-lo`]);
  });

  it('addLeftover: un refresco que ya lo trae mientras la petición sigue en vuelo no lo duplica', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'lo', () => '2026-10-09');
    actions.addLeftover();
    h.server.state.months[OCT]!.budgetLog.push({ id: 'srv-lo', date: '2026-10-09', accountId: 'dr', amount: 1234, kind: 'leftover', note: '' });
    await h.store.refetch();
    expect(h.view().months[OCT]!.budgetLog.filter((e) => e.kind === 'leftover').map((e) => [e.id, e.amount])).toEqual([['srv-lo', 1234]]);
  });

  it('addLeftover: lo que esperaba su retraso sale antes (el sobrante sale de esas cifras)', async () => {
    const actions = createActions(h.store, OCT, flows, () => 'lo');
    const id = h.tx(0).id;
    actions.patchTx(id, { amount: 6000 });
    expect(actions.addLeftover()).toBe(true);
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`]);
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`PATCH /api/transactions/${id}`, `POST /api/months/${OCT}/leftover`]);
  });

  it('addLeftover: false si no hay mes anterior, el mes está cerrado, no sobró nada o no hay mes seleccionado', async () => {
    expect(createActions(h.store, '2026-09', flows).addLeftover()).toBe(false); // cerrado
    expect(createActions(h.store, '2026-11', flows).addLeftover()).toBe(false); // no existe
    expect(createActions(h.store, null, flows).addLeftover()).toBe(false);

    // Septiembre usó justo su presupuesto: no sobró nada.
    const sep = h.server.state.months['2026-09']!;
    sep.fixed = [];
    sep.tx = [{ ...sep.tx[0]!, amount: 1000 }];
    setBudgets(sep, { dr: 1000 });
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).addLeftover()).toBe(false);

    // Octubre como único mes: no hay anterior.
    for (const key of ['2026-08', '2026-09']) Reflect.deleteProperty(h.server.state.months, key);
    await h.store.refetch();
    expect(createActions(h.store, OCT, flows).addLeftover()).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.store.pendingCount).toBe(0);
  });

  it('el registro del presupuesto es de cada usuario', async () => {
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

  it('setMonthRate: la tasa de un par desde una fecha se ve en el acto y sale con un PUT, pasado el retraso, con el último valor', async () => {
    const actions = createActions(h.store, OCT, flows);
    for (const typed of [5, 59, 59.1]) expect(actions.setMonthRate('USD', 'DOP', typed, '2026-10-07')).toBe(true);
    // Las de los días 1 y 6 siguen ahí: la nueva vale desde el 7.
    expect(h.view().months[OCT]!.rates).toEqual([...seedState().months[OCT]!.rates, { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' }]);
    expect(monthCalc(h.view(), OCT).rate).toEqual({ rate: 59.1, source: 'month', monthKey: OCT, date: '2026-10-07' });
    // Lo registrado antes no cambia: las transacciones de octubre son en DOP y el gasto fijo en USD usa la última.
    expect(h.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: `/api/months/${OCT}/rates`, user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' });
  });

  it('setMonthRate: escribir sobre una fecha que ya tenía tasa la sustituye, en su sitio y en el sentido nuevo', () => {
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

  it('setMonthRate: cada par y cada fecha tienen su propia tasa y su propio guardado', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMonthRate('USD', 'TRY', 40, '2026-10-07');
    actions.setMonthRate('TRY', 'DOP', 1.47, '2026-10-07');
    // El mismo par en dos fechas: dos filas, ninguna pisa a la otra mientras esperan.
    actions.setMonthRate('USD', 'DOP', 59, '2026-10-07');
    actions.setMonthRate('USD', 'DOP', 60, '2026-10-20');
    expect(h.store.pendingCount).toBe(4);
    expect(h.view().months[OCT]!.rates).toHaveLength(6);
    h.store.flush();
    // Sale la primera; las demás esperan su turno.
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

  it('setMonthRate: una celda a medio escribir (0), el mismo par, una fecha de otro mes o un mes cerrado no se envían', () => {
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

  it('removeMonthRate: borra la tasa de esa fecha con el sentido en que se guardó y descarta la que esperaba', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMonthRate('USD', 'DOP', 59, '2026-10-06');
    // Se pide al revés: la tasa guardada es USD → DOP.
    actions.removeMonthRate('DOP', 'USD', '2026-10-06');
    // La del día 1 no se toca: es la que vuelve a valer.
    expect(h.view().months[OCT]!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    expect(monthCalc(h.view(), OCT).rate).toMatchObject({ source: 'month', date: '2026-10-01' });
    await vi.advanceTimersByTimeAsync(1000);
    // El PUT que esperaba ya no sale; el DELETE lleva la fecha en la consulta.
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-06`]);
    expect(h.calls[0]!.body).toBeUndefined();

    // Un par sin tasa escrita, una fecha sin tasa, o un mes cerrado: nada que quitar.
    actions.removeMonthRate('USD', 'TRY', '2026-10-06');
    actions.removeMonthRate('USD', 'DOP', '2026-10-03');
    actions.removeMonthRate('USD', 'DOP', '2026-10-06');
    createActions(h.store, '2026-09', flows).removeMonthRate('USD', 'DOP', '2026-10-01');
    createActions(h.store, null, flows).removeMonthRate('USD', 'DOP', '2026-10-01');
    expect(h.calls).toHaveLength(1);

    // Quitada también la del día 1, el par vuelve a salir de los envíos del mes.
    actions.removeMonthRate('USD', 'DOP', '2026-10-01');
    expect(h.view().months[OCT]!.rates).toEqual([]);
    expect(monthCalc(h.view(), OCT).rate.source).toBe('transfers');
    h.calls[0]!.ok();
    await tick();
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-06`, `DELETE /api/months/${OCT}/rates/USD/DOP?date=2026-10-01`]);
  });

  it('removeMonthRate: quitar la de una fecha no descarta la de otra fecha que esperaba su retraso', async () => {
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

  it('removeMonthRate: una tasa guardada al revés se pide en su sentido', async () => {
    h.server.state.months[OCT]!.rates = [{ from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-04' }];
    await h.store.refetch();
    createActions(h.store, OCT, flows).removeMonthRate('USD', 'DOP', '2026-10-04');
    expect(h.summary()).toEqual([`DELETE /api/months/${OCT}/rates/DOP/USD?date=2026-10-04`]);
  });

  it('si el servidor rechaza la tasa, vuelve la anterior', async () => {
    createActions(h.store, OCT, flows).setMonthRate('USD', 'DOP', 61, '2026-10-06');
    expect(h.view().months[OCT]!.rates[1]!.rate).toBe(61);
    h.store.flush();
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().months[OCT]!.rates).toEqual(seedState().months[OCT]!.rates);
    expect(h.failures[0]!.action).toMatchObject({ type: 'rate/set', key: OCT });
  });

  it('si el servidor rechaza quitar una tasa, vuelve a aparecer; si ya no la tenía (404), se da por quitada', async () => {
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

describe('gastos con su cuenta', () => {
  const flows = {} as Flows;

  it('un gasto nuevo sale de la cuenta por defecto, o de la que se indique', () => {
    let n = 0;
    const actions = createActions(h.store, OCT, flows, () => `id-${++n}`);
    actions.addFixed({ name: 'Spotify', amount: 6, cur: 'USD' });
    actions.addFixed({ name: 'GitHub', amount: 4, cur: 'USD', accountId: 'us' });
    expect(h.view().months[OCT]!.fixed.slice(-2).map((f) => f.accountId)).toEqual(['dr', 'us']);
    expect(h.calls[0]!.body).toEqual({ id: 'id-1', monthKey: OCT, name: 'Spotify', day: '', amount: 6, cur: 'USD', paid: false, accountId: 'dr' });
  });

  it('cambiar la cuenta de una fila sale sin esperar; una cuenta que no existe o un monto negativo se ignoran', () => {
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

describe('envíos', () => {
  const flows = {} as Flows;
  const first = () => h.view().months[OCT]!.transfers[0]!;

  it('sin tasa, el envío nuevo lleva la del mes para ese par', () => {
    const actions = createActions(h.store, OCT, flows, () => 'tr-new');
    expect(actions.addTransfer({ date: '2026-10-08', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 300 })).toBe(true);
    expect(h.view().months[OCT]!.transfers.at(-1)).toMatchObject({ id: 'tr-new', amount: 300, rate: 58.76 });
    expect(h.calls[0]!.body).toMatchObject({ fromAccountId: 'us', toAccountId: 'dr', amount: 300, rate: 58.76 });
  });

  it('sin tasa, la que lleva es la vigente en la fecha del envío, no la última escrita', async () => {
    // 58 desde el día 1 y 60 desde el día 6.
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

  it('patchTransfer: se edita como una celda más, con retraso y en un solo PATCH', async () => {
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

  it('patchTransfer: lo que no vale se ignora (misma cuenta en los dos lados, cuenta desconocida, tasa 0, vía vacía)', () => {
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

  it('patchTransfer: al invertir el envío la tasa pasa a ser la del mes para el par nuevo', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchTransfer(first().id, { fromAccountId: 'dr', toAccountId: 'us' });
    expect(first()).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(first().rate).toBeCloseTo(1 / 58.76, 12);
    h.store.flush();
    expect(h.calls[0]!.body).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect((h.calls[0]!.body as { rate: number }).rate).toBeCloseTo(1 / 58.76, 12);
  });

  it('si el servidor rechaza la edición, el envío vuelve a como estaba', async () => {
    const before = first();
    createActions(h.store, OCT, flows).patchTransfer(before.id, { amount: 9999 });
    h.store.flush();
    h.calls[0]!.fail(409, 'month_closed');
    await tick();
    expect(first()).toEqual(before);
    expect(h.failures).toHaveLength(1);
  });
});

describe('ingresos', () => {
  const flows = {} as Flows;

  it('addIncome registra el ingreso en el acto, con un id del cliente, y lo manda', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-10-15', desc: ' Bonus ', accountId: 'us', amount: 1000, cur: 'USD' })).toBe(true);
    expect(h.view().incomes.at(-1)).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false, rate: null, recurring: false });
    expect(monthCalc(h.view(), OCT).income).toBeCloseTo(6800 * 58.76, 6);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: '/api/incomes', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false, rate: null, recurring: false });
  });

  it('addIncome con budget: true lo manda marcado y sube el presupuesto del mes de su fecha en el acto', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-10-15', desc: 'Freelance', accountId: 'dr', amount: 100, cur: 'USD', budget: true })).toBe(true);
    expect(h.view().incomes.at(-1)).toMatchObject({ id: 'in-new', budget: true });
    expect(h.calls[0]!.body).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Freelance', accountId: 'dr', amount: 100, cur: 'USD', budget: true, rate: null, recurring: false });
    // 100 USD a la tasa de su fecha, en la parte de la DR account; el registro del mes no cambia.
    expect(monthCalc(h.view(), OCT).budget).toBeCloseTo(70000 + 5876, 8);
    expect(h.view().months[OCT]!.budgetLog).toEqual(seedState().months[OCT]!.budgetLog);
    expect(h.view().months[OCT]!.budgets).toEqual({ dr: 70000 });
  });

  it('marcar un ingreso para el presupuesto es una casilla: sale sin esperar, y vale en un mes cerrado', async () => {
    const actions = createActions(h.store, OCT, flows);
    // El sueldo de septiembre: el mes está cerrado, pero el ingreso no pertenece a él.
    actions.patchIncome('seed-in-2', { budget: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/incomes/seed-in-2', body: { budget: true } });
    expect(monthCalc(h.view(), '2026-09').budget).toBeGreaterThan(70000);
    // Lo que no es un sí o un no se ignora.
    actions.patchIncome('seed-in-3', { budget: 'yes' as unknown as boolean });
    expect(h.store.pendingCount).toBe(1);

    // Si el servidor lo rechaza, el presupuesto vuelve a como estaba.
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().incomes.find((i) => i.id === 'seed-in-2')!.budget).toBe(false);
    expect(monthCalc(h.view(), '2026-09').budget).toBe(70000);
    expect(h.failures).toHaveLength(1);
  });

  it('sin cuenta indicada entra a la cuenta por defecto, y vale con fecha de un mes cerrado', () => {
    const actions = createActions(h.store, OCT, flows, () => 'in-new');
    expect(actions.addIncome({ date: '2026-08-20', amount: 5000, cur: 'DOP' })).toBe(true);
    expect(h.view().incomes.at(-1)).toMatchObject({ accountId: 'dr', desc: '', date: '2026-08-20' });
  });

  it('patchIncome: una edición de celda; el alta llega antes', async () => {
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

  it('removeIncome lo quita y descarta la edición que esperaba', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchIncome('seed-in-3', { amount: 6000 });
    actions.removeIncome('seed-in-3');
    expect(h.view().incomes.map((i) => i.id)).toEqual(['seed-in-1', 'seed-in-2']);
    expect(monthCalc(h.view(), OCT).income).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.summary()).toEqual(['DELETE /api/incomes/seed-in-3']);
  });

  it('si no se pudo guardar, el ingreso desaparece y se avisa', async () => {
    createActions(h.store, OCT, flows, () => 'in-new').addIncome({ date: '2026-10-15', amount: 1000, cur: 'USD' });
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect(h.view().incomes).toEqual(seedState().incomes);
    expect(h.failures).toHaveLength(1);
  });
});

describe('aportes', () => {
  const flows = {} as Flows;

  it('patchContribution: se edita sin borrarlo; cambiar de meta sale sin esperar', async () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchContribution('seed-ct-8', { amount: 650 });
    expect(h.calls).toEqual([]);
    actions.patchContribution('seed-ct-8', { goalId: 'personal' });
    expect(h.view().contribs.find((c) => c.id === 'seed-ct-8')).toMatchObject({ amount: 650, goalId: 'personal' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/contributions/seed-ct-8', body: { amount: 650, goalId: 'personal' } });
  });

  it('una meta que no existe, una fecha imposible o un monto negativo se ignoran', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.patchContribution('seed-ct-8', { goalId: 'marte' });
    actions.patchContribution('seed-ct-8', { date: '2026-02-30' });
    actions.patchContribution('seed-ct-8', { amount: -5 });
    expect(h.store.pendingCount).toBe(0);
    expect(h.view().contribs).toEqual(seedState().contribs);
  });
});

describe('ajustes · monedas y cuenta por defecto', () => {
  const flows = {} as Flows;

  it('la moneda principal cambia en el acto y se guarda sin esperar', () => {
    createActions(h.store, OCT, flows).setMainCurrency('TRY');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['TRY', 'USD']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/settings', user: 'frank' });
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'TRY' });
  });

  it('elegir como principal la que hoy es la segunda las intercambia en una sola petición', () => {
    // Frank: principal DOP, segunda USD.
    createActions(h.store, OCT, flows).setMainCurrency('USD');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['USD', 'DOP']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    // Todo se ve ya en la moneda nueva.
    expect(monthCalc(h.view(), OCT)).toMatchObject({ main: 'USD', second: 'DOP' });
    expect(monthCalc(h.view(), OCT).budgetSecond).toBeCloseTo(70000, 8);
  });

  it('y al revés: elegir como segunda la que hoy es la principal también las intercambia', () => {
    createActions(h.store, OCT, flows).setSecondCurrency('DOP');
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['USD', 'DOP']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
  });

  it('la segunda moneda sola, y elegir la que ya está no hace nada', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setMainCurrency('DOP');
    actions.setSecondCurrency('USD');
    actions.setMainCurrency('EUR' as 'USD');
    expect(h.calls).toEqual([]);
    actions.setSecondCurrency('TRY');
    expect(h.calls[0]!.body).toEqual({ secondCurrency: 'TRY' });
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['DOP', 'TRY']);
  });

  it('si el servidor rechaza el intercambio, vuelven las dos monedas', async () => {
    createActions(h.store, OCT, flows).setMainCurrency('USD');
    h.calls[0]!.fail(400, 'validation');
    await tick();
    expect([h.view().mainCurrency, h.view().secondCurrency]).toEqual(['DOP', 'USD']);
    expect(h.failures).toHaveLength(1);
  });

  it('la cuenta por defecto: una visible o null (la automática)', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setDefaultAccount('dr');
    actions.setDefaultAccount('gone');
    expect(h.calls).toEqual([]);

    actions.setDefaultAccount('us');
    expect(h.view().defaultAccountId).toBe('us');
    expect(h.calls[0]!.body).toEqual({ defaultAccountId: 'us' });
    // Lo que se agregue desde ahora sale de ella.
    actions.addFixed({ name: 'Gym', amount: 10, cur: 'DOP' });
    expect(h.view().months[OCT]!.fixed.at(-1)!.accountId).toBe('us');

    actions.setDefaultAccount(null);
    expect(h.view().defaultAccountId).toBeNull();
    expect(h.store.pendingCount).toBe(3);
  });

  it('una cuenta oculta no se puede elegir como cuenta por defecto', () => {
    const actions = createActions(h.store, OCT, flows);
    actions.setAccountHidden('us', true);
    actions.setDefaultAccount('us');
    expect(h.view().defaultAccountId).toBe('dr');
    expect(h.calls).toHaveLength(1);
  });

  it('las monedas son de cada usuario', async () => {
    const eda = await h.switchTo(EDA);
    createActions(eda, OCT, flows).setMainCurrency('TRY');
    expect(h.calls[0]).toMatchObject({ path: '/api/settings', user: 'eda', body: { mainCurrency: 'TRY' } });
    expect(eda.state!.mainCurrency).toBe('TRY');
    expect(h.view().mainCurrency).toBe('DOP');
  });
});

describe('borrar un mes', () => {
  const SEP = '2026-09';

  it('manda antes lo pendiente, lo borra en el servidor y solo entonces lo quita de lo que se ve', async () => {
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
    // No es optimista: hasta que el servidor responde, el mes sigue ahí.
    expect(h.view().months[SEP]).toBeDefined();
    expect(done).toBe(false);

    Reflect.deleteProperty(h.server.state.months, SEP);
    h.calls[1]!.ok();
    await deleting;
    expect(done).toBe(true);
    expect(Object.keys(h.view().months).sort()).toEqual(['2026-08', OCT]);
    expect(h.failures).toEqual([]);
  });

  it('los saldos cambian en consecuencia y los ingresos se quedan', async () => {
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

  it('si el servidor lo rechaza, no se toca nada y el error llega a quien lo pidió', async () => {
    const deleting = h.store.deleteMonth(SEP);
    const outcome = deleting.then(
      () => 'deleted',
      (e: unknown) => e,
    );
    await tick();
    h.calls[0]!.fail(500, 'internal');
    expect(await outcome).toMatchObject({ name: 'ApiError', code: 'internal' });
    expect(h.view()).toEqual(seedState());
    // No es una escritura optimista: no hay nada que deshacer ni aviso de guardado.
    expect(h.failures).toEqual([]);
  });

  it('un fallo de red tampoco lo quita', async () => {
    const outcome = h.store.deleteMonth(SEP).then(
      () => 'deleted',
      (e: unknown) => e,
    );
    await tick();
    h.calls[0]!.drop();
    expect(await outcome).toMatchObject({ name: 'NetworkError' });
    expect(h.view().months[SEP]).toBeDefined();
  });

  it('si el servidor ya no lo tenía (404), cuenta como borrado', async () => {
    const deleting = h.store.deleteMonth(SEP);
    await tick();
    h.calls[0]!.fail(404, 'not_found');
    await deleting;
    expect(h.view().months[SEP]).toBeUndefined();
  });

  it('se puede borrar un mes cerrado y también el mes en curso', async () => {
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

  it('si era el único mes, no deja al usuario sin meses: vuelve a pedir el estado (el servidor crea el mes actual)', async () => {
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
    // Lo que hace el servidor: borra el mes y, al abrir de nuevo, crea el actual en blanco.
    const fresh: Month = { key: '2026-11', closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    h.server.state.months = { '2026-11': fresh };
    h.calls[0]!.ok();
    await deleting;
    stop();

    expect(Object.keys(h.view().months)).toEqual(['2026-11']);
    expect(seen.every((n) => n >= 1)).toBe(true);
  });

  it('el borrado de un usuario no toca los meses del otro', async () => {
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
