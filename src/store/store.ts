// Capa de datos: la consulta ['state', usuario] de TanStack Query más las escrituras optimistas.
//
// Cada usuario tiene su propia FinanzasStore (FinanzasStores las crea y las guarda), con su caché, su cola y su
// cliente HTTP atado a ese usuario (api.forUser). Una escritura hecha para un usuario no puede salir con otro
// aunque se cambie de usuario antes de que se envíe: quien la tiene en cola es la store del primero, que sigue
// vaciándose por su cuenta.
//
// Modelo: lo que se ve = `base` (lo último que confirmó el servidor) + las acciones sin confirmar, en orden.
// La caché nunca se parchea a mano; siempre se recalcula así. Eso da gratis las tres garantías que hacen falta:
//   · Rollback: si una petición falla, se quita su acción y se recalcula; las demás ediciones siguen en pie.
//   · Un refetch no pisa ediciones: su resultado pasa por el mismo recálculo antes de llegar a la caché.
//   · Las ediciones de una celda con retraso se ven en el acto aunque todavía no hayan salido.
//
// Las peticiones salen de una en una, en el orden en que se hicieron las ediciones (el POST de una fila nueva
// siempre llega antes que su PATCH o su DELETE). Cuando no queda nada pendiente se invalida su consulta una sola vez.

import type { QueryClient } from '@tanstack/react-query';
import type { StateResponse } from '../../shared/api';
import type { AppState, AppUser, MonthKey } from '../../shared/types';
import { ApiError } from '../api/client';
import type { ApiClient, RequestOptions, UserApi } from '../api/client';
import { fieldsOf, isPatch, mergePatch, reduce, removeMonth, targetOf } from './reducers';
import type { Action, PatchAction } from './reducers';
import { SaveQueue } from './saveQueue';

/** Clave de la consulta con los usuarios configurados (GET /api/session). */
export const SESSION_KEY = ['session'] as const;

/** Clave de la consulta con todo el histórico de un usuario. */
export function stateKey(userId: string): readonly ['state', string] {
  return ['state', userId];
}

/** Retraso de guardado de las ediciones de texto y número, por (fila, campo). */
export const DEBOUNCE_MS = 400;

/** Campos que cambian con un clic (checkbox, select, idioma, monedas, ocultar una cuenta): salen sin esperar. */
const IMMEDIATE_FIELDS: ReadonlySet<string> = new Set([
  'paid',
  'cur',
  'cat',
  'method',
  'sort',
  'language',
  'accountId',
  'fromAccountId',
  'toAccountId',
  'goalId',
  'hidden',
  'currency',
  'mainCurrency',
  'secondCurrency',
  'defaultAccountId',
  'budget',
  'cardId',
]);

export interface SaveFailure {
  /** De quién era la escritura (puede no ser ya el usuario que se está viendo). */
  userId: string;
  action: Action;
  error: unknown;
}

interface Op {
  action: Action;
}

const isAdd = (action: Action) => action.type.endsWith('/add');
const isRemove = (action: Action) => action.type.endsWith('/remove');
const isMove = (action: Action) => action.type === 'tx/moveOutside' || action.type === 'outside/moveToBudget';

/** La capa de datos de UN usuario. No se crea a mano: se pide a FinanzasStores.for(id). */
export class FinanzasStore {
  readonly userId: string;
  /** Clave de su consulta: ['state', userId]. */
  readonly key: readonly ['state', string];
  /** El cliente HTTP de este usuario; los flujos (Excel, cerrar mes) lo usan para no salirse de sus datos. */
  readonly api: UserApi;
  private readonly qc: QueryClient;
  private readonly queue: SaveQueue<PatchAction>;

  private base: AppState | null = null;
  private user: AppUser | null = null;
  /** Acciones ya entregadas a la cola HTTP y aún sin respuesta, en orden. */
  private sent: Op[] = [];
  /** De `sent`, las que todavía no han salido. */
  private waiting: Op[] = [];
  private running = 0;
  private unloading = false;
  /** Sube con cada escritura confirmada: delata los GET que empezaron antes de ella. */
  private confirmed = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly listeners = new Set<(failure: SaveFailure) => void>();

  constructor(qc: QueryClient, api: UserApi, delay = DEBOUNCE_MS) {
    this.qc = qc;
    this.api = api;
    this.userId = api.userId;
    this.key = stateKey(api.userId);
    this.queue = new SaveQueue<PatchAction>({ delay, merge: mergePatch, send: (_key, action) => this.enqueue(action) });
  }

  /** queryFn de su consulta. */
  readonly queryFn = async ({ signal }: { signal?: AbortSignal }): Promise<StateResponse> => {
    const confirmedAtStart = this.confirmed;
    const res = await this.api.getState({ signal });
    const current = this.qc.getQueryData<StateResponse>(this.key);
    // Si mientras llegaba se confirmó una escritura, esta foto puede ser anterior a ella y mostrarla
    // haría parpadear el dato viejo. Se descarta: al quedar todo guardado se vuelve a pedir.
    if (current && confirmedAtStart !== this.confirmed) return current;
    this.base = res.state;
    this.user = res.user;
    return { user: res.user, state: this.view(res.state) };
  };

  /** Aplica la acción a lo que se ve y la manda al servidor (las ediciones de texto y número, con retraso). */
  dispatch(action: Action): void {
    if (!this.base) return;
    const fields = isPatch(action) ? fieldsOf(action) : [];
    if (isPatch(action) && fields.length === 0) return;

    // Un GET en vuelo ya no trae nada útil. La cancelación es síncrona y devuelve la caché a como estaba
    // al empezar ese GET; por eso siempre va seguida de write().
    void this.qc.cancelQueries({ queryKey: this.key });

    if (isPatch(action)) {
      const immediate = fields.every((f) => IMMEDIATE_FIELDS.has(f));
      this.queue.push(targetOf(action), fields, action, immediate);
    } else {
      // Lo que quedara por guardar de una fila que se elimina ya no tiene destino.
      if (isRemove(action)) this.queue.drop(targetOf(action));
      // Mover una fila: lo que tuviera esperando su retraso sale antes, para no editar después una fila que ya no está.
      if (isMove(action)) this.queue.flush();
      this.enqueue(action);
    }
    this.write();
  }

  /**
   * Manda ya las ediciones que estaban esperando su retraso.
   * Con `unload` (la página se cierra) además lanza todo lo que hubiera en cola sin esperar turno y con keepalive,
   * porque ya no habrá ocasión de seguir la cola cuando llegue cada respuesta.
   */
  flush(opts: { unload?: boolean } = {}): void {
    this.unloading = opts.unload === true;
    try {
      this.queue.flush();
      this.pump();
    } finally {
      this.unloading = false;
    }
  }

  /** flush() y espera a que el servidor haya respondido a todo (bien o mal). */
  settle(): Promise<void> {
    this.flush();
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Vuelve a pedir el estado y espera la respuesta. No lanza: si falla, se queda lo que había. */
  async refetch(): Promise<void> {
    await this.qc.invalidateQueries({ queryKey: this.key });
  }

  /** Incorpora algo que devolvió el servidor fuera de las acciones (los meses que devuelve cerrar mes). */
  applyServer(fn: (state: AppState) => AppState): void {
    if (!this.base) return;
    void this.qc.cancelQueries({ queryKey: this.key });
    this.base = fn(this.base);
    this.confirmed++;
    this.write();
  }

  /**
   * Borra un mes en el servidor y, cuando este lo confirma, lo quita de lo que se ve. No es optimista: es una
   * acción sin vuelta atrás que pasa por su diálogo. Antes manda lo pendiente (lo que quedara por guardar de las
   * filas de ese mes fallaría después). Rechaza si el servidor no lo borró: entonces no se ha tocado nada.
   */
  async deleteMonth(key: MonthKey): Promise<void> {
    await this.settle();
    try {
      await this.api.deleteMonth(key);
    } catch (error) {
      // Que el servidor ya no lo tenga es lo que se quería.
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
    }
    const others = this.base !== null && Object.keys(this.base.months).some((k) => k !== key);
    if (others) this.applyServer((state) => removeMonth(state, key));
    // Era su único mes: sin meses no hay nada que enseñar. Al volver a pedir el estado el servidor crea el mes actual.
    else await this.refetch();
  }

  /** Lo que se ve ahora mismo (con las ediciones optimistas); null hasta la primera carga. */
  get state(): AppState | null {
    return this.qc.getQueryData<StateResponse>(this.key)?.state ?? null;
  }

  /** Escrituras sin confirmar: esperando su retraso, en cola o en vuelo. */
  get pendingCount(): number {
    return this.sent.length + this.queue.size;
  }

  /** Avisa de cada escritura que el servidor rechazó (ya revertida). Devuelve la función para dejar de escuchar. */
  onError(listener: (failure: SaveFailure) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  /** base + todo lo que aún no confirmó el servidor. */
  private view(base: AppState): AppState {
    let state = base;
    for (const op of this.sent) state = reduce(state, op.action);
    for (const action of this.queue.pending()) state = reduce(state, action);
    return state;
  }

  private write(): void {
    if (!this.base || !this.user) return;
    this.qc.setQueryData<StateResponse>(this.key, { user: this.user, state: this.view(this.base) });
  }

  private enqueue(action: Action): void {
    const op: Op = { action };
    this.sent.push(op);
    this.waiting.push(op);
    this.pump();
  }

  /** Saca peticiones de la cola: de una en una, o todas de golpe si la página se cierra. */
  private pump(): void {
    while (this.waiting.length > 0 && (this.unloading || this.running === 0)) {
      const op = this.waiting.shift()!;
      this.running++;
      let request: Promise<unknown>;
      try {
        // La petición sale dentro de esta misma llamada (importa en pagehide).
        request = this.request(op.action, this.unloading ? { keepalive: true } : undefined);
      } catch (error) {
        request = Promise.reject(error);
      }
      request.then(
        () => this.done(op, null),
        (error: unknown) => this.done(op, { error }),
      );
    }
  }

  private done(op: Op, failure: { error: unknown } | null): void {
    this.running--;
    this.sent = this.sent.filter((o) => o !== op);

    // Borrar algo que el servidor ya no tiene es lo que se quería: cuenta como hecho.
    const gone = failure !== null && isRemove(op.action) && failure.error instanceof ApiError && failure.error.code === 'not_found';

    if (failure === null || gone) {
      this.confirmed++;
      if (this.base) this.base = reduce(this.base, op.action);
    } else {
      // Si no se pudo crear la fila, lo que venía detrás para ella fallaría igual: se descarta sin más avisos.
      if (isAdd(op.action)) {
        const target = targetOf(op.action);
        this.waiting = this.waiting.filter((o) => targetOf(o.action) !== target);
        this.sent = this.sent.filter((o) => targetOf(o.action) !== target);
        this.queue.drop(target);
      }
      this.write();
      for (const listener of this.listeners) listener({ userId: this.userId, action: op.action, error: failure.error });
    }

    this.pump();
    if (this.pendingCount === 0) this.idle();
  }

  private idle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
    // Una sola vez por ráfaga: trae los campos que pone el servidor (sort, createdAt) y lo que haya cambiado fuera.
    void this.qc.invalidateQueries({ queryKey: this.key });
  }

  private request(action: Action, opts?: RequestOptions): Promise<unknown> {
    const api = this.api;
    switch (action.type) {
      case 'settings/patch':
        return api.patchSettings(action.patch, opts);
      case 'account/add': {
        const { id, name, currency, opening } = action.row;
        return api.createAccount({ id, name, currency, opening }, opts);
      }
      case 'account/patch':
        return api.patchAccount(action.id, action.patch, opts);
      case 'account/remove':
        return api.deleteAccount(action.id, opts);
      case 'month/patch':
        return api.patchMonth(action.key, action.patch, opts);
      case 'month/reopen':
        return api.reopenMonth(action.key, opts);
      case 'card/other':
        return api.setCardOther(action.key, action.cardId, { other: action.other }, opts);
      case 'card/pay':
        return api.payCard(action.key, action.cardId, { id: action.payment.id, amount: action.payment.amount, accountId: action.payment.accountId, date: action.payment.date }, opts);
      case 'card/unpay':
        return api.unpayCard(action.key, action.cardId, opts);
      case 'card/unpayOne':
        return api.removeCardPayment(action.key, action.cardId, action.id, opts);
      case 'creditCard/add': {
        const { id, name, bank, last4, cur, limit, cutoffDay, dueDay, active } = action.row;
        return api.createCreditCard({ id, name, bank, last4, cur, limit, cutoffDay, dueDay, active }, opts);
      }
      case 'creditCard/patch':
        return api.patchCreditCard(action.id, action.patch, opts);
      case 'creditCard/remove':
        return api.deleteCreditCard(action.id, opts);
      case 'rate/set':
        return api.putMonthRate(action.key, action.rate, opts);
      case 'rate/remove':
        return api.deleteMonthRate(action.key, action.from, action.to, action.date, opts);
      case 'budget/add': {
        const { id, date, accountId, amount, kind, note, incomeId } = action.row;
        // 'leftover' no se escribe por aquí: tiene su propia acción.
        return api.addBudgetEntry(action.key, { id, date, accountId, amount, kind: kind === 'initial' ? 'initial' : 'adjust', note, ...(incomeId && { incomeId }) }, opts);
      }
      case 'budget/remove':
        return api.deleteBudgetEntry(action.key, action.id, opts);
      case 'budget/leftover':
        // La cifra la calcula el servidor; `row` es solo lo que se ve mientras responde.
        return api.addLeftover(action.key, opts);
      case 'fixed/add': {
        const { id, monthKey, name, day, amount, cur, paid, accountId, onCard, cardId } = action.row;
        return api.createFixed({ id, monthKey, name, day, amount, cur, paid, accountId, ...(onCard && { onCard, ...(cardId && { cardId }) }) }, opts);
      }
      case 'fixed/patch':
        return api.patchFixed(action.id, action.patch, opts);
      case 'fixed/remove':
        return api.deleteFixed(action.id, opts);
      case 'tx/add': {
        const { id, monthKey, date, desc, place, cat, method, amount, cur, accountId, notes, cardId } = action.row;
        return api.createTransaction({ id, monthKey, date, desc, place, cat, method, amount, cur, accountId, notes, ...(cardId && { cardId }) }, opts);
      }
      case 'tx/patch':
        return api.patchTransaction(action.id, action.patch, opts);
      case 'tx/remove':
        return api.deleteTransaction(action.id, opts);
      case 'outside/add': {
        const { id, monthKey, date, name, desc, accountId, amount, cur } = action.row;
        return api.createOutside({ id, monthKey, date, name, desc, accountId, amount, cur }, opts);
      }
      case 'outside/patch':
        return api.patchOutside(action.id, action.patch, opts);
      case 'outside/remove':
        return api.deleteOutside(action.id, opts);
      case 'tx/moveOutside':
        return api.moveTransactionOutside(action.id, { id: action.row.id }, opts);
      case 'outside/moveToBudget':
        return api.moveOutsideToBudget(action.id, { id: action.row.id }, opts);
      case 'transfer/add': {
        const { id, monthKey, date, via, fromAccountId, toAccountId, amount, rate, budget, fee } = action.row;
        return api.createTransfer({ id, monthKey, date, via, fromAccountId, toAccountId, amount, rate, budget, fee }, opts);
      }
      case 'transfer/patch':
        return api.patchTransfer(action.id, action.patch, opts);
      case 'transfer/remove':
        return api.deleteTransfer(action.id, opts);
      case 'income/add': {
        const { id, date, desc, accountId, amount, cur, budget, rate, recurring } = action.row;
        return api.createIncome({ id, date, desc, accountId, amount, cur, budget, rate, recurring }, opts);
      }
      case 'income/patch':
        return api.patchIncome(action.id, action.patch, opts);
      case 'income/remove':
        return api.deleteIncome(action.id, opts);
      case 'goal/add': {
        const { id, name, cur, monthly, start, end, approxCur } = action.row;
        return api.createGoal({ id, name, cur, monthly, start, end, approxCur }, opts);
      }
      case 'goal/patch':
        return api.patchGoal(action.id, action.patch, opts);
      case 'goal/remove':
        return api.deleteGoal(action.id, opts);
      case 'contribution/add': {
        const { id, goalId, date, amount, cur, rate, accountId } = action.row;
        return api.createContribution({ id, goalId, date, amount, cur, rate, accountId }, opts);
      }
      case 'contribution/patch':
        return api.patchContribution(action.id, action.patch, opts);
      case 'contribution/remove':
        return api.deleteContribution(action.id, opts);
    }
  }
}

/**
 * Las capas de datos de todos los usuarios. `for(id)` devuelve siempre la misma store para el mismo usuario,
 * así que lo que tuviera pendiente sigue ahí (y sigue enviándose con su cabecera) aunque se esté viendo a otro.
 */
export class FinanzasStores {
  private readonly qc: QueryClient;
  private readonly api: ApiClient;
  private readonly delay: number;
  private readonly stores = new Map<string, FinanzasStore>();
  private readonly listeners = new Set<(failure: SaveFailure) => void>();

  constructor(qc: QueryClient, api: ApiClient, delay = DEBOUNCE_MS) {
    this.qc = qc;
    this.api = api;
    this.delay = delay;
  }

  for(userId: string): FinanzasStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new FinanzasStore(this.qc, this.api.forUser(userId), this.delay);
      store.onError((failure) => {
        for (const listener of this.listeners) listener(failure);
      });
      this.stores.set(userId, store);
    }
    return store;
  }

  /** flush() de todas: al cerrar la página puede quedar algo de un usuario que ya no es el que se ve. */
  flush(opts?: { unload?: boolean }): void {
    for (const store of this.stores.values()) store.flush(opts);
  }

  /** Escrituras sin confirmar de todos los usuarios. */
  get pendingCount(): number {
    let n = 0;
    for (const store of this.stores.values()) n += store.pendingCount;
    return n;
  }

  /** Avisa de cada escritura rechazada, sea del usuario que sea. Devuelve la función para dejar de escuchar. */
  onError(listener: (failure: SaveFailure) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
