// Ediciones del usuario como funciones puras (estado, acción) → estado.
// La capa de datos (store.ts) las aplica a la caché en el acto y luego hace la petición HTTP.
//
// Dos reglas que store.ts da por hechas:
//   · Nunca mutan: devuelven objetos nuevos solo en la ruta que cambia (las filas intactas conservan su identidad).
//   · Son idempotentes: aplicar dos veces la misma acción da lo mismo que una. Hace falta porque un refetch puede
//     traer el estado con la acción ya aplicada en el servidor mientras todavía está pendiente en el cliente.
//
// Aquí no se calcula dinero: los saldos, las conversiones y los totales salen de shared/calc.ts sobre el estado
// que dejan estas funciones. Lo único que se le pide a calc es lo que una escritura necesita para ser válida
// (la cuenta por defecto, la tasa vigente de un envío, el saldo inicial que corrige un saldo, lo que suma hoy el
// registro del presupuesto de una cuenta y el sobrante del mes anterior).

import type {
  AccountPatch,
  BudgetEntryCreate,
  ContributionPatch,
  CreditCardPatch,
  FixedPatch,
  GoalPatch,
  IncomePatch,
  MonthPatch,
  OutsidePatch,
  SettingsUpdate,
  TransferPatch,
  TxPatch,
} from '../../shared/api';
import {
  accountsById,
  budgetRaised,
  budgetsFromLog,
  cardCalc,
  cardOf,
  cardOffBlocked,
  convert,
  defaultAccount,
  defaultCardId,
  isCardTx,
  isMoneyAccount,
  leftoverFor,
  openingFor,
  rateFor,
  sortedKeys,
} from '../../shared/calc';
import { CREDIT_CARD_METHOD, CURRENCIES, GOLD, GOLD_DECIMALS, isGold, MAX_LEN, MOVED_TO_BUDGET } from '../../shared/constants';
import { clampToMonth, firstDay, inMonth, isISODate, isMonthKey } from '../../shared/month';
import type {
  Account,
  AccountCurrency,
  AppState,
  BudgetEntry,
  Contribution,
  CreditCard,
  Currency,
  FixedExpense,
  Goal,
  GoldPrice,
  Income,
  ISODate,
  Month,
  CardPayment,
  MonthCard,
  MonthKey,
  MonthRate,
  OutsideExpense,
  Transaction,
  Transfer,
} from '../../shared/types';

export type Action =
  | { type: 'settings/patch'; patch: SettingsUpdate }
  | { type: 'account/add'; row: Account }
  | { type: 'account/patch'; id: string; patch: AccountPatch }
  | { type: 'account/remove'; id: string }
  /** `date`: la fecha del movimiento que se añade al registro (hoy, llevado al mes); sin ella, el primer día del mes. */
  | { type: 'month/patch'; key: MonthKey; patch: MonthPatch; date?: ISODate }
  | { type: 'month/reopen'; key: MonthKey }
  | { type: 'budget/add'; key: MonthKey; row: BudgetEntry }
  | { type: 'budget/remove'; key: MonthKey; id: string }
  /** `row` es el movimiento 'leftover' tal como se espera que lo escriba el servidor (leftoverEntry). */
  | { type: 'budget/leftover'; key: MonthKey; row: BudgetEntry }
  /** Una tarjeta de crédito en el mes: otros cargos, añadir un pago (moneda de la tarjeta), quitarlos todos o quitar uno. */
  | { type: 'card/other'; key: MonthKey; cardId: string; other: number }
  | { type: 'card/pay'; key: MonthKey; cardId: string; payment: CardPayment }
  | { type: 'card/unpay'; key: MonthKey; cardId: string }
  | { type: 'card/unpayOne'; key: MonthKey; cardId: string; id: string }
  /** Las tarjetas de crédito del usuario (no de un mes). */
  | { type: 'creditCard/add'; row: CreditCard }
  | { type: 'creditCard/patch'; id: string; patch: CreditCardPatch }
  | { type: 'creditCard/remove'; id: string }
  | { type: 'rate/set'; key: MonthKey; rate: MonthRate }
  | { type: 'rate/remove'; key: MonthKey; from: Currency; to: Currency; date: ISODate }
  | { type: 'fixed/add'; row: FixedExpense }
  | { type: 'fixed/patch'; id: string; patch: FixedPatch }
  | { type: 'fixed/remove'; id: string }
  | { type: 'tx/add'; row: Transaction }
  | { type: 'tx/patch'; id: string; patch: TxPatch }
  | { type: 'tx/remove'; id: string }
  | { type: 'outside/add'; row: OutsideExpense }
  | { type: 'outside/patch'; id: string; patch: OutsidePatch }
  | { type: 'outside/remove'; id: string }
  /** La transacción `id` pasa a ser `row`, en un solo paso: nunca están las dos ni falta una (POST …/move-outside). */
  | { type: 'tx/moveOutside'; id: string; row: OutsideExpense }
  /** El camino inverso: el gasto fuera de presupuesto `id` pasa a ser la transacción `row`. */
  | { type: 'outside/moveToBudget'; id: string; row: Transaction }
  | { type: 'transfer/add'; row: Transfer }
  | { type: 'transfer/patch'; id: string; patch: TransferPatch }
  | { type: 'transfer/remove'; id: string }
  | { type: 'income/add'; row: Income }
  | { type: 'income/patch'; id: string; patch: IncomePatch }
  | { type: 'income/remove'; id: string }
  | { type: 'goal/add'; row: Goal }
  | { type: 'goal/patch'; id: string; patch: GoalPatch }
  | { type: 'goal/remove'; id: string }
  | { type: 'contribution/add'; row: Contribution }
  | { type: 'contribution/patch'; id: string; patch: ContributionPatch }
  | { type: 'contribution/remove'; id: string };

const PATCH_TYPES = [
  'settings/patch',
  'account/patch',
  'month/patch',
  'rate/set',
  'fixed/patch',
  'tx/patch',
  'outside/patch',
  'transfer/patch',
  'income/patch',
  'contribution/patch',
] as const;

/**
 * Las ediciones de celda y los ajustes: son las que se agrupan por fila y se mandan con retraso. La tasa de un
 * par del mes cuenta como una celda más. (Editar una meta no entra aquí: se guarda de una vez, desde su diálogo.)
 */
export type PatchAction = Extract<Action, { type: (typeof PATCH_TYPES)[number] }>;

export function isPatch(action: Action): action is PatchAction {
  return (PATCH_TYPES as readonly string[]).includes(action.type);
}

type MonthList = 'fixed' | 'tx' | 'transfers' | 'outside';
type TopList = 'accounts' | 'incomes' | 'goals' | 'contribs' | 'cards';

function withMonth(state: AppState, key: MonthKey, fn: (m: Month) => Month): AppState {
  const m = state.months[key];
  if (!m) return state;
  const next = fn(m);
  return next === m ? state : { ...state, months: { ...state.months, [key]: next } };
}

/** Agrega la fila, o la reemplaza si ya hay una con ese id (idempotencia). */
function upsert<T extends { id: string }>(rows: readonly T[], row: T): T[] {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i < 0) return [...rows, row];
  const next = rows.slice();
  next[i] = row;
  return next;
}

function monthWith(state: AppState, list: MonthList, id: string): MonthKey | null {
  for (const key in state.months) {
    if ((state.months[key]![list] ?? []).some((r) => r.id === id)) return key;
  }
  return null;
}

function patchRow<L extends MonthList>(state: AppState, list: L, id: string, patch: Partial<NonNullable<Month[L]>[number]>): AppState {
  const key = monthWith(state, list, id);
  if (!key) return state;
  return withMonth(state, key, (m) => ({ ...m, [list]: (m[list] ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

function removeRow(state: AppState, list: MonthList, id: string): AppState {
  const key = monthWith(state, list, id);
  if (!key) return state;
  return withMonth(state, key, (m) => ({ ...m, [list]: (m[list] ?? []).filter((r) => r.id !== id) }));
}

// Lo mismo para lo que no pertenece a un mes: cuentas, ingresos, metas y aportes.

function patchTop<L extends TopList>(state: AppState, list: L, id: string, patch: Partial<AppState[L][number]>): AppState {
  const rows: readonly { id: string }[] = state[list];
  if (!rows.some((r) => r.id === id)) return state;
  return { ...state, [list]: rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

function removeTop(state: AppState, list: TopList, id: string): AppState {
  const rows: readonly { id: string }[] = state[list];
  return rows.some((r) => r.id === id) ? { ...state, [list]: rows.filter((r) => r.id !== id) } : state;
}

/** Id de un movimiento del registro que todavía no tiene el suyo: lo pone el servidor y llega con el siguiente refresco. */
export const LOCAL_ENTRY = 'local-';

/** true si el movimiento se añadió aquí y aún no se conoce su id del servidor: no se puede borrar todavía. */
export function isLocalEntry(id: string): boolean {
  return id.startsWith(LOCAL_ENTRY);
}

// Como el servidor (ROUND(…, 6)): una diferencia de 1e-12 no es un cambio.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** El mes con ese registro del presupuesto y sus partes (Month.budgets) recalculadas. */
function withLog(m: Month, budgetLog: BudgetEntry[]): Month {
  return { ...m, budgetLog, budgets: budgetsFromLog(budgetLog) };
}

/**
 * Como el servidor: cada parte que venga es el monto en que debe quedar la suma del registro de esa cuenta, y se
 * añade un movimiento con la diferencia ('initial' si la cuenta no tenía ninguno en el mes, si no 'adjust').
 * Sin diferencia no se añade nada: por eso aplicar dos veces la misma acción da lo mismo que una.
 */
function patchMonth(m: Month, patch: MonthPatch, date: ISODate): Month {
  if (!patch.budgets) return m;
  const log = [...m.budgetLog];
  for (const [accountId, amount] of Object.entries(patch.budgets)) {
    const diff = round6(amount - (budgetsFromLog(log)[accountId] ?? 0));
    if (diff === 0) continue;
    const kind = log.some((e) => e.accountId === accountId) ? 'adjust' : 'initial';
    // El largo del registro no basta como sufijo: tras quitar un movimiento volvería a salir un id ya usado.
    let n = log.length;
    while (log.some((e) => e.id === `${LOCAL_ENTRY}${accountId}-${n}`)) n++;
    log.push({ id: `${LOCAL_ENTRY}${accountId}-${n}`, date, accountId, amount: diff, kind, note: '' });
  }
  return log.length === m.budgetLog.length ? m : withLog(m, log);
}

/** El mes con esa tarjeta; sin nada que guardar queda sin ella (y sin `cards` si era la única), como lo manda el servidor. */
function withCard(m: Month, card: MonthCard): Month {
  const before = cardOf(m, card.cardId);
  if (card.other === before.other && card.payments === before.payments) return m;
  const others = (m.cards ?? []).filter((c) => c.cardId !== card.cardId);
  const cards = card.other === 0 && card.payments.length === 0 ? others : [...others, card].sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  if (cards.length === 0) {
    const { cards: _gone, ...rest } = m;
    return rest;
  }
  return { ...m, cards };
}

const samePair = (r: Pick<MonthRate, 'from' | 'to'>, from: Currency, to: Currency) =>
  (r.from === from && r.to === to) || (r.from === to && r.to === from);

const sameRate = (r: MonthRate, from: Currency, to: Currency, date: ISODate) => samePair(r, from, to) && r.date === date;

/**
 * Una tasa escrita por par y fecha: la nueva sustituye a la de esa misma fecha, estuviera en el sentido que
 * estuviera, y en su sitio. Las de otras fechas no se tocan: siguen valiendo para lo registrado entre su fecha y esta.
 */
function setRate(m: Month, rate: MonthRate): Month {
  const i = m.rates.findIndex((r) => sameRate(r, rate.from, rate.to, rate.date));
  if (i < 0) return { ...m, rates: [...m.rates, rate] };
  const old = m.rates[i]!;
  if (old.from === rate.from && old.to === rate.to && old.rate === rate.rate) return m;
  const rates = m.rates.slice();
  rates[i] = rate;
  return { ...m, rates };
}

const samePrice = (a: GoldPrice | null, b: GoldPrice | null) =>
  a === b || (a !== null && b !== null && a.amount === b.amount && a.currency === b.currency);

/**
 * Solo cambia lo que venga; `theme: null` vuelve a la paleta original, `defaultAccountId: null` a la cuenta
 * automática y `goldPrice: null` deja el oro sin precio.
 */
function patchSettings(state: AppState, patch: SettingsUpdate): AppState {
  const next = {
    theme: patch.theme !== undefined ? patch.theme : state.theme,
    language: patch.language ?? state.language,
    mainCurrency: patch.mainCurrency ?? state.mainCurrency,
    secondCurrency: patch.secondCurrency !== undefined ? patch.secondCurrency : state.secondCurrency,
    defaultAccountId: patch.defaultAccountId !== undefined ? patch.defaultAccountId : state.defaultAccountId,
    // El mismo precio conserva su objeto: así repetir la acción no cambia el estado.
    goldPrice: patch.goldPrice !== undefined && !samePrice(patch.goldPrice, state.goldPrice) ? patch.goldPrice : state.goldPrice,
  };
  const same = (Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === state[k]);
  return same ? state : { ...state, ...next };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'settings/patch':
      return patchSettings(state, action.patch);

    case 'account/add':
      return { ...state, accounts: upsert(state.accounts, action.row) };
    case 'account/patch':
      return patchTop(state, 'accounts', action.id, action.patch);
    case 'account/remove': {
      const next = removeTop(state, 'accounts', action.id);
      // La cuenta por defecto no puede seguir apuntando a una que ya no existe: vuelve a la automática.
      return next.defaultAccountId === action.id ? { ...next, defaultAccountId: null } : next;
    }

    case 'month/patch':
      return withMonth(state, action.key, (m) => patchMonth(m, action.patch, action.date ?? firstDay(action.key)));
    case 'month/reopen':
      return withMonth(state, action.key, (m) => (m.closed ? { ...m, closed: false, closedAt: null } : m));

    case 'budget/add':
      return withMonth(state, action.key, (m) => withLog(m, upsert(m.budgetLog, action.row)));
    case 'budget/remove':
      return withMonth(state, action.key, (m) =>
        m.budgetLog.some((e) => e.id === action.id) ? withLog(m, m.budgetLog.filter((e) => e.id !== action.id)) : m,
      );
    case 'budget/leftover':
      // Como mucho uno por mes: si ya lo tiene (el servidor lo confirmó, o es la segunda vez), no se repite.
      return withMonth(state, action.key, (m) => (m.budgetLog.some((e) => e.kind === 'leftover') ? m : withLog(m, [...m.budgetLog, action.row])));

    case 'card/other':
      return withMonth(state, action.key, (m) => withCard(m, { ...cardOf(m, action.cardId), other: action.other }));
    case 'card/pay':
      return withMonth(state, action.key, (m) => withCard(m, { ...cardOf(m, action.cardId), payments: [...cardOf(m, action.cardId).payments, action.payment] }));
    case 'card/unpay':
      return withMonth(state, action.key, (m) => withCard(m, { ...cardOf(m, action.cardId), payments: [] }));
    case 'card/unpayOne':
      return withMonth(state, action.key, (m) =>
        withCard(m, { ...cardOf(m, action.cardId), payments: cardOf(m, action.cardId).payments.filter((p) => p.id !== action.id) }),
      );

    case 'creditCard/add':
      return { ...state, cards: upsert(state.cards, action.row) };
    case 'creditCard/patch':
      return patchTop(state, 'cards', action.id, action.patch);
    case 'creditCard/remove':
      return removeTop(state, 'cards', action.id);

    case 'rate/set':
      return withMonth(state, action.key, (m) => setRate(m, action.rate));
    case 'rate/remove':
      return withMonth(state, action.key, (m) =>
        m.rates.some((r) => sameRate(r, action.from, action.to, action.date))
          ? { ...m, rates: m.rates.filter((r) => !sameRate(r, action.from, action.to, action.date)) }
          : m,
      );

    case 'fixed/add':
      return withMonth(state, action.row.monthKey, (m) => ({ ...m, fixed: upsert(m.fixed, action.row) }));
    case 'fixed/patch':
      return patchRow(state, 'fixed', action.id, action.patch);
    case 'fixed/remove':
      return removeRow(state, 'fixed', action.id);

    case 'tx/add':
      return withMonth(state, action.row.monthKey, (m) => ({ ...m, tx: upsert(m.tx, action.row) }));
    case 'tx/patch':
      return patchRow(state, 'tx', action.id, action.patch);
    case 'tx/remove':
      return removeRow(state, 'tx', action.id);

    case 'outside/add':
      return withMonth(state, action.row.monthKey, (m) => ({ ...m, outside: upsert(m.outside ?? [], action.row) }));
    case 'outside/patch':
      return patchRow(state, 'outside', action.id, action.patch);
    case 'outside/remove':
      return removeRow(state, 'outside', action.id);
    // Si la fila de origen ya no está (se movió en el servidor y el refetch lo trajo, o se borró) no se hace nada:
    // así aplicar dos veces la acción nunca duplica ni resucita nada.
    case 'tx/moveOutside': {
      const key = monthWith(state, 'tx', action.id);
      if (!key) return state;
      return withMonth(removeRow(state, 'tx', action.id), action.row.monthKey, (m) => ({ ...m, outside: upsert(m.outside ?? [], action.row) }));
    }
    case 'outside/moveToBudget': {
      const key = monthWith(state, 'outside', action.id);
      if (!key) return state;
      return withMonth(removeRow(state, 'outside', action.id), action.row.monthKey, (m) => ({ ...m, tx: upsert(m.tx, action.row) }));
    }

    case 'transfer/add':
      return withMonth(state, action.row.monthKey, (m) => ({ ...m, transfers: upsert(m.transfers, action.row) }));
    case 'transfer/patch':
      return patchRow(state, 'transfers', action.id, action.patch);
    case 'transfer/remove':
      return removeRow(state, 'transfers', action.id);

    case 'income/add':
      return { ...state, incomes: upsert(state.incomes, action.row) };
    case 'income/patch':
      return patchTop(state, 'incomes', action.id, action.patch);
    case 'income/remove':
      return removeTop(state, 'incomes', action.id);

    case 'goal/add':
      return { ...state, goals: upsert(state.goals, action.row) };
    case 'goal/patch':
      return patchTop(state, 'goals', action.id, action.patch);
    case 'goal/remove':
      return removeTop(state, 'goals', action.id);

    case 'contribution/add':
      return { ...state, contribs: upsert(state.contribs, action.row) };
    case 'contribution/patch':
      return patchTop(state, 'contribs', action.id, action.patch);
    case 'contribution/remove':
      return removeTop(state, 'contribs', action.id);
  }
}

/** Pone en el estado los meses que devolvió el servidor (cerrar mes devuelve el cerrado y el siguiente). */
export function putMonths(state: AppState, ...months: Month[]): AppState {
  const next = { ...state.months };
  for (const m of months) next[m.key] = m;
  return { ...state, months: next };
}

/**
 * Quita un mes con todo lo suyo (gastos, transacciones, envíos, presupuesto y tasas), como DELETE /api/months/:key.
 * Los ingresos y los aportes con fecha en él se quedan: no pertenecen a un mes. Los saldos cambian solos, porque
 * se calculan de lo que queda.
 */
export function removeMonth(state: AppState, key: MonthKey): AppState {
  if (!state.months[key]) return state;
  const months = { ...state.months };
  Reflect.deleteProperty(months, key);
  return { ...state, months };
}

/**
 * Funde dos ediciones de la misma fila: gana el valor más reciente de cada campo. Las partes del presupuesto se
 * funden por cuenta (editar la de una no descarta la de otra que aún esperaba) y una tasa sustituye a la anterior.
 */
export function mergePatch(prev: PatchAction, next: PatchAction): PatchAction {
  if (prev.type === 'rate/set' || next.type === 'rate/set') return next;
  if (prev.type === 'month/patch' && next.type === 'month/patch') {
    return { ...prev, ...next, patch: { budgets: { ...prev.patch.budgets, ...next.patch.budgets } } };
  }
  return { ...prev, patch: { ...prev.patch, ...next.patch } } as PatchAction;
}

/** Los campos que toca una edición: cada uno lleva su propio retraso de guardado (store.ts). */
export function fieldsOf(action: PatchAction): string[] {
  if (action.type === 'rate/set') return ['rate'];
  if (action.type === 'month/patch') return Object.keys(action.patch.budgets ?? {}).map((id) => `budgets.${id}`);
  return Object.keys(action.patch);
}

const pairKey = (a: Currency, b: Currency) => [a, b].sort().join('-');

/**
 * A qué entidad se refiere la acción ('tx:abc', 'month:2026-10', 'rate:2026-10:DOP-USD:2026-10-07', 'settings').
 * Sirve de clave para agrupar ediciones de una fila y para descartar lo que quede en cola de una fila que ya no
 * existe. Cada tasa (par y fecha) es su propia fila, y cada movimiento del registro del presupuesto también.
 */
export function targetOf(action: Action): string {
  const kind = action.type.slice(0, action.type.indexOf('/'));
  if (action.type === 'settings/patch') return kind;
  if (action.type === 'rate/set') return `${kind}:${action.key}:${pairKey(action.rate.from, action.rate.to)}:${action.rate.date}`;
  if (action.type === 'rate/remove') return `${kind}:${action.key}:${pairKey(action.from, action.to)}:${action.date}`;
  if (action.type === 'budget/add' || action.type === 'budget/leftover') return `${kind}:${action.row.id}`;
  if (action.type === 'budget/remove') return `${kind}:${action.id}`;
  // Un mover nombra a la fila de la que sale (la nueva lleva otro id): es de ella de quien depende lo que haya en cola.
  if (action.type === 'tx/moveOutside' || action.type === 'outside/moveToBudget') return `${kind}:${action.id}`;
  if ('key' in action) return `${kind}:${action.key}`;
  return `${kind}:${'row' in action ? action.row.id : action.id}`;
}

// ── Reglas del contrato ──────────────────────────────────────────────────────
// Lo que shared/api.ts exige a cada escritura se comprueba aquí, contra el estado que se ve, antes de tocarlo:
// una escritura que el servidor rechazaría nunca llega a enviarse.

const positive = (n: number) => Number.isFinite(n) && n > 0;
const nonNegative = (n: number) => Number.isFinite(n) && n >= 0;
const isCurrency = (v: unknown): v is Currency => (CURRENCIES as readonly unknown[]).includes(v);
/** Lo que puede ser la moneda de una cuenta: una moneda o el oro. */
const isAccountCurrency = (v: unknown): v is AccountCurrency => isCurrency(v) || v === GOLD;
const hasAccount = (state: AppState, id: string) => state.accounts.some((a) => a.id === id);
/** Una cuenta que existe y es de dinero: las de oro (gramos) no pagan gastos, ni llevan presupuesto, ni envían ni reciben. */
const hasMoneyAccount = (state: AppState, id: string) => state.accounts.some((a) => a.id === id && isMoneyAccount(a));

/** Gramos con los decimales que se aceptan: lo que pase de ahí es ruido de quien escribe. */
const grams = (n: number) => Math.round(n * 10 ** GOLD_DECIMALS) / 10 ** GOLD_DECIMALS;

const isBlank = (text: string) => text.trim() === '';
const notAmount = (n: number) => !nonNegative(n);
const notDate = (date: string) => !isISODate(date);
const notCurrency = (cur: Currency) => !isCurrency(cur);

/** El texto sin espacios sobrantes, o null si queda vacío o se pasa de `max`. */
function named(text: string, max: number = MAX_LEN.name): string | null {
  const out = text.trim();
  return out && out.length <= max ? out : null;
}

/**
 * La cuenta de un gasto nuevo: la que se indique (tiene que existir y ser de dinero, no de oro) o, si no se
 * indica, la de por defecto.
 */
function accountFor(state: AppState, accountId: string | undefined): string | null {
  if (accountId !== undefined) return hasMoneyAccount(state, accountId) ? accountId : null;
  return defaultAccount(state)?.id ?? null;
}

/** Una tasa propia es null (automática) o un número finito > 0. */
const notRate = (rate: number | null) => rate !== null && !(Number.isFinite(rate) && rate > 0);
const validRate = (rate: number | null | undefined): number | null => (rate != null && !notRate(rate) ? rate : null);

/**
 * Lo que se puede guardar de la edición de una celda: los campos que no pasan su comprobación se quitan y el resto
 * se guarda. Mientras la celda tenga un valor que el servidor no admite (un concepto vacío a media reescritura, un
 * monto negativo) no se guarda nada de ella, y si el usuario sale dejándola así vuelve a verse el valor anterior.
 */
function keepValid<P extends object>(patch: P, invalid: { [K in keyof P]?: (value: Exclude<P[K], undefined>) => boolean }): P {
  const checks = invalid as Record<string, ((value: unknown) => boolean) | undefined>;
  const values = patch as Record<string, unknown>;
  let out = patch;
  for (const key of Object.keys(checks)) {
    if (values[key] === undefined || !checks[key]!(values[key])) continue;
    if (out === patch) out = { ...patch };
    Reflect.deleteProperty(out, key);
  }
  return out;
}

/** Edición de un gasto fijo: concepto no vacío, monto >= 0 y una cuenta de dinero que exista. */
export function fixedChange(state: AppState, patch: FixedPatch): FixedPatch {
  return keepValid(patch, { name: isBlank, amount: notAmount, cur: notCurrency, accountId: (id) => !hasMoneyAccount(state, id), cardId: (id) => !hasActiveCard(state, id), onCard: (on) => on && !defaultCardId(state) });
}

/** Edición de una transacción: descripción no vacía, fecha válida, monto >= 0 y una cuenta de dinero que exista. */
export function txChange(state: AppState, patch: TxPatch): TxPatch {
  return keepValid(patch, {
    desc: isBlank,
    date: notDate,
    amount: notAmount,
    cur: notCurrency,
    accountId: (id) => !hasMoneyAccount(state, id),
    cardId: (id) => !hasActiveCard(state, id),
    method: (m) => m === CREDIT_CARD_METHOD && !defaultCardId(state),
  });
}

/** Edición de un gasto fuera de presupuesto: nombre no vacío, fecha válida, monto >= 0 y una cuenta de dinero que exista. */
export function outsideChange(state: AppState, patch: OutsidePatch): OutsidePatch {
  return keepValid(patch, {
    name: isBlank,
    date: notDate,
    amount: notAmount,
    cur: notCurrency,
    accountId: (id) => !hasMoneyAccount(state, id),
  });
}

/**
 * Edición de un ingreso: fecha válida, monto >= 0 y una cuenta que exista. La descripción puede quedar vacía.
 * La moneda y "sube el presupuesto" siguen a la cuenta en la que queda el ingreso, como exige el servidor:
 *  · en una cuenta de oro el monto son gramos (XAU, hasta tres decimales) y nunca sube el presupuesto: pasarlo
 *    a una la arrastra a eso, y ahí se ignoran otra moneda y la casilla;
 *  · en una de dinero no vale XAU: al sacarlo de una de oro toma la moneda de la cuenta nueva.
 * {} si el ingreso no existe.
 */
export function incomeChange(state: AppState, id: string, patch: IncomePatch): IncomePatch {
  const row = state.incomes.find((i) => i.id === id);
  if (!row) return {};
  const out = keepValid(patch, {
    date: notDate,
    desc: (desc) => desc.length > MAX_LEN.desc,
    amount: notAmount,
    cur: (cur) => !isAccountCurrency(cur),
    accountId: (accountId) => !hasAccount(state, accountId),
    budget: (budget) => typeof budget !== 'boolean',
    rate: notRate,
    recurring: (recurring) => typeof recurring !== 'boolean',
  });
  const account = accountsById(state).get(out.accountId ?? row.accountId);
  if (!account) return out;
  const next: IncomePatch = { ...out };
  if (isGold(account.currency)) {
    if (row.cur === GOLD) Reflect.deleteProperty(next, 'cur');
    else next.cur = GOLD;
    if (row.budget) next.budget = false;
    else Reflect.deleteProperty(next, 'budget');
    if (next.amount !== undefined) next.amount = grams(next.amount);
  } else if (isGold(next.cur ?? row.cur)) {
    // Sale de una cuenta de oro: toma la moneda de la nueva. Si ya era de dinero, pedirle gramos se ignora.
    if (isGold(row.cur)) next.cur = account.currency;
    else Reflect.deleteProperty(next, 'cur');
  }
  return next;
}

/** Edición de un aporte: una meta que exista, fecha válida y monto >= 0. */
export function contributionChange(state: AppState, patch: ContributionPatch): ContributionPatch {
  return keepValid(patch, {
    goalId: (id) => !state.goals.some((g) => g.id === id),
    date: notDate,
    amount: notAmount,
    cur: notCurrency,
    rate: notRate,
    accountId: (id) => id !== null && !hasMoneyAccount(state, id),
  });
}

// ── Filas nuevas ─────────────────────────────────────────────────────────────
// Lo que escribe el usuario en una fila de agregar. Las funciones `new*` validan como el prototipo
// (README, "Agregar") y devuelven la fila lista para el estado, o null si no se puede agregar.

export interface FixedInput {
  name: string;
  day?: string;
  amount: number;
  cur: Currency;
  /** Cuenta de la que se paga. Sin indicar: la cuenta por defecto del usuario. */
  accountId?: string;
  /** Se paga con la tarjeta de crédito: la cuenta no se usa (se guarda la por defecto, que el servidor exige). */
  onCard?: boolean;
  /** Con qué tarjeta, si `onCard`. Sin indicar: la primera activa. */
  cardId?: string;
}

export interface TxInput {
  date: ISODate;
  desc: string;
  place?: string;
  cat: string;
  method: string;
  amount: number;
  cur: Currency;
  /** Cuenta de la que sale. Sin indicar: la cuenta por defecto del usuario. */
  accountId?: string;
  notes?: string;
  /** Con qué tarjeta, si el método es de crédito. Sin indicar: la primera activa. */
  cardId?: string;
}

export interface OutsideInput {
  date: ISODate;
  name: string;
  desc?: string;
  /** Cuenta de la que sale. Sin indicar: la cuenta por defecto del usuario. */
  accountId?: string;
  amount: number;
  /** Sin indicar: la moneda de la cuenta. */
  cur?: Currency;
}

export interface TransferInput {
  date: ISODate;
  /** Texto libre: Remitly y PayPal (shared/constants VIAS) son solo sugerencias. */
  via: string;
  fromAccountId: string;
  toAccountId: string;
  /** Lo que sale, en la moneda de la cuenta de origen. */
  amount: number;
  /**
   * 1 moneda de origen = `rate` moneda de destino. Sin indicar: la tasa del mes para ese par.
   * Entre dos cuentas de la misma moneda es siempre 1, se indique lo que se indique.
   */
  rate?: number;
  /** true: el envío mueve además presupuesto del mes, de la cuenta de origen a la de destino (Transfer.budget). Sin indicar: false. */
  budget?: boolean;
  /** Comisión, en la moneda de la cuenta de origen (Transfer.fee). Sin indicar: 0. */
  fee?: number;
}

export interface IncomeInput {
  date: ISODate;
  desc?: string;
  /** Cuenta a la que entra. Sin indicar: la cuenta por defecto del usuario. */
  accountId?: string;
  /** Gramos si la cuenta es de oro. */
  amount: number;
  /** La moneda en que se cobró. En una cuenta de oro no cuenta: el ingreso queda en gramos (XAU). */
  cur: AccountCurrency;
  /** true: el ingreso sube además el presupuesto del mes de su fecha (Income.budget). Sin indicar: false. Nunca en una cuenta de oro. */
  budget?: boolean;
  /** Tasa propia (Income.rate). Sin indicar o null: automática. */
  rate?: number | null;
  /** Se copia a cada mes nuevo (Income.recurring). Sin indicar: false. */
  recurring?: boolean;
}

export interface ContributionInput {
  goalId: string;
  date: ISODate;
  amount: number;
  cur: Currency;
  /** Tasa propia (Contribution.rate). Sin indicar o null: automática. */
  rate?: number | null;
  /** Cuenta de dinero de la que sale (Contribution.accountId). Sin indicar o null: ninguna. */
  accountId?: string | null;
}

export interface AccountInput {
  name: string;
  /** Una moneda, o XAU para una cuenta de oro (en gramos). */
  currency: AccountCurrency;
  /** Saldo inicial, en la moneda de la cuenta (puede ser negativo); gramos, hasta tres decimales, si es de oro. Sin indicar: 0. */
  opening?: number;
}

/** El plan de una meta: los tres valores juntos, o los tres null si es de aportes variables. */
export type GoalPlan = Pick<Goal, 'monthly' | 'start' | 'end'>;

/** Lo que sale del diálogo de una meta. Sin plan basta el nombre (o los tres campos del plan en null). */
export interface GoalInput extends Partial<GoalPlan> {
  name: string;
  /** Moneda de la meta. Sin indicar: la moneda principal del usuario. */
  cur?: Currency;
  /** Moneda de la línea "≈" de la meta. null o sin indicar: la moneda principal del usuario. */
  approxCur?: Currency | null;
}

/** Un movimiento del presupuesto escrito a mano. Sin fecha: la que se pase como "hoy", llevada al mes. */
export type BudgetEntryInput = Pick<BudgetEntryCreate, 'accountId' | 'amount' | 'date' | 'kind' | 'note' | 'incomeId'>;

/** Concepto, monto > 0 y una cuenta que exista. Queda al final de la lista, sin pagar. */
export function newFixed(state: AppState, monthKey: MonthKey, input: FixedInput, id: string): FixedExpense | null {
  const month = state.months[monthKey];
  const name = input.name.trim();
  const accountId = accountFor(state, input.accountId);
  if (!month || !name || !positive(input.amount) || !isCurrency(input.cur) || !accountId) return null;
  if (input.onCard && !defaultCardId(state)) return null;
  const sort = month.fixed.reduce((max, f) => Math.max(max, f.sort), -1) + 1;
  return { id, monthKey, name, day: (input.day ?? '').trim(), amount: input.amount, cur: input.cur, paid: false, accountId, sort, ...(input.onCard ? { onCard: true, ...cardFor(state, input.cardId) } : {}) };
}

/** Descripción, fecha válida, monto > 0 y una cuenta que exista. La transacción va al mes seleccionado, sea cual sea su fecha. */
export function newTx(state: AppState, monthKey: MonthKey, input: TxInput, id: string): Transaction | null {
  const desc = input.desc.trim();
  const accountId = accountFor(state, input.accountId);
  if (!state.months[monthKey] || !desc || !isISODate(input.date) || !positive(input.amount) || !isCurrency(input.cur) || !accountId) return null;
  // Con tarjeta de crédito hace falta una tarjeta activa donde cargarla (el servidor lo exige).
  if (input.method === CREDIT_CARD_METHOD && !defaultCardId(state)) return null;
  return {
    id,
    monthKey,
    date: input.date,
    desc,
    place: (input.place ?? '').trim(),
    cat: input.cat,
    method: input.method,
    amount: input.amount,
    cur: input.cur,
    accountId,
    notes: (input.notes ?? '').trim(),
    source: 'web',
    createdAt: null,
    ...(input.method === CREDIT_CARD_METHOD ? cardFor(state, input.cardId) : {}),
  };
}

/** Nombre, fecha válida, monto > 0 y una cuenta de dinero que exista. Va al mes seleccionado, sea cual sea su fecha. */
export function newOutside(state: AppState, monthKey: MonthKey, input: OutsideInput, id: string): OutsideExpense | null {
  const name = named(input.name, MAX_LEN.desc);
  const accountId = accountFor(state, input.accountId);
  const account = state.accounts.find((a) => a.id === accountId);
  const cur = input.cur ?? account?.currency;
  if (!state.months[monthKey] || !name || !isISODate(input.date) || !positive(input.amount) || !account || !cur || !isCurrency(cur)) return null;
  return { id, monthKey, date: input.date, name, desc: (input.desc ?? '').trim(), accountId: account.id, amount: input.amount, cur };
}

/**
 * La fila "fuera de presupuesto" en que se convierte una transacción (igual que el servidor, db.ts moveTransactionOutside):
 * su concepto es el nombre y sus notas la descripción; si tenía lugar, va delante porque esta fila no lo guarda.
 */
export function outsideFromTx(tx: Transaction, id: string): OutsideExpense {
  const desc = tx.place ? (tx.notes ? `${tx.place} · ${tx.notes}` : tx.place) : tx.notes;
  return { id, monthKey: tx.monthKey, date: tx.date, name: tx.desc, desc: desc.slice(0, MAX_LEN.notes), accountId: tx.accountId, amount: tx.amount, cur: tx.cur };
}

/** La transacción en que se convierte un gasto fuera de presupuesto (db.ts moveOutsideToBudget): sin lugar, su descripción son las notas. */
export function txFromOutside(o: OutsideExpense, id: string): Transaction {
  return {
    id,
    monthKey: o.monthKey,
    date: o.date,
    desc: o.name,
    place: '',
    cat: MOVED_TO_BUDGET.cat,
    method: MOVED_TO_BUDGET.method,
    amount: o.amount,
    cur: o.cur,
    accountId: o.accountId,
    notes: o.desc,
    source: 'web',
    createdAt: null,
  };
}

/**
 * La tasa con la que se guarda un envío entre esas dos cuentas, o null si el envío no vale: falta una cuenta, son
 * la misma, o la tasa indicada no es > 0. Sin tasa indicada es la vigente en la fecha del envío para ese par (como
 * hace el servidor); entre monedas iguales, 1.
 */
function transferRate(state: AppState, monthKey: MonthKey, date: ISODate, fromId: string, toId: string, given?: number): number | null {
  const accounts = accountsById(state);
  const from = accounts.get(fromId);
  const to = accounts.get(toId);
  // Un envío mueve dinero: ninguno de los dos lados puede ser una cuenta de oro.
  if (!from || !to || from.id === to.id || !isMoneyAccount(from) || !isMoneyAccount(to)) return null;
  if (from.currency === to.currency) return 1;
  if (given === undefined) return rateFor(state, monthKey, from.currency, to.currency, date).rate;
  return positive(given) ? given : null;
}

/** Vía (texto libre, obligatoria), fecha válida, monto > 0, comisión >= 0 y dos cuentas distintas que existan. */
export function newTransfer(state: AppState, monthKey: MonthKey, input: TransferInput, id: string): Transfer | null {
  const via = named(input.via, MAX_LEN.label);
  const fee = input.fee ?? 0;
  if (!via || !state.months[monthKey] || !isISODate(input.date) || !positive(input.amount) || !nonNegative(fee)) return null;
  const rate = transferRate(state, monthKey, input.date, input.fromAccountId, input.toAccountId, input.rate);
  if (rate === null) return null;
  return {
    id,
    monthKey,
    date: input.date,
    via,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amount: input.amount,
    rate,
    budget: input.budget === true,
    fee,
  };
}

/**
 * Lo que hay que mandar para aplicar `patch` a ese envío; {} si no queda nada que guardar (o el envío no existe).
 * Como en las demás celdas, lo que no vale se ignora: una vía vacía, un monto o una comisión negativos, una tasa que no sea > 0 o
 * un cambio de cuenta que dejaría el envío con una cuenta que no existe, con una de oro o con la misma en los dos lados.
 * Si el cambio de cuenta cambia las monedas del envío y no viene otra tasa, la tasa pasa a ser la del mes para el
 * par nuevo (1 entre monedas iguales): la anterior era de otras monedas.
 */
export function transferChange(state: AppState, id: string, patch: TransferPatch): TransferPatch {
  const monthKey = monthWith(state, 'transfers', id);
  const row = monthKey ? state.months[monthKey]!.transfers.find((t) => t.id === id) : undefined;
  if (!monthKey || !row) return {};
  const out: TransferPatch = {};
  if (patch.date !== undefined && isISODate(patch.date)) out.date = patch.date;
  if (patch.via !== undefined && !isBlank(patch.via) && patch.via.length <= MAX_LEN.label) out.via = patch.via;
  if (patch.amount !== undefined && nonNegative(patch.amount)) out.amount = patch.amount;
  if (typeof patch.budget === 'boolean') out.budget = patch.budget;
  if (patch.fee !== undefined && nonNegative(patch.fee)) out.fee = patch.fee;

  const accounts = accountsById(state);
  let fromId = row.fromAccountId;
  let toId = row.toAccountId;
  const nextFrom = patch.fromAccountId ?? fromId;
  const nextTo = patch.toAccountId ?? toId;
  if ((nextFrom !== fromId || nextTo !== toId) && hasMoneyAccount(state, nextFrom) && hasMoneyAccount(state, nextTo) && nextFrom !== nextTo) {
    if (nextFrom !== fromId) out.fromAccountId = nextFrom;
    if (nextTo !== toId) out.toAccountId = nextTo;
    fromId = nextFrom;
    toId = nextTo;
  }

  const moneyOf = (accountId: string): Currency | undefined => {
    const cur = accounts.get(accountId)?.currency;
    return isGold(cur) ? undefined : cur;
  };
  const fromCur = moneyOf(fromId);
  const toCur = moneyOf(toId);
  const typed = patch.rate !== undefined && positive(patch.rate) ? patch.rate : undefined;
  if (fromCur && toCur && fromCur === toCur) {
    if (row.rate !== 1) out.rate = 1;
  } else if (typed !== undefined) {
    out.rate = typed;
  } else if (fromCur && toCur) {
    const moved = fromCur !== moneyOf(row.fromAccountId) || toCur !== moneyOf(row.toAccountId);
    if (moved) out.rate = rateFor(state, monthKey, fromCur, toCur, out.date ?? row.date).rate;
  }
  return out;
}

/**
 * Fecha válida, monto > 0 y una cuenta que exista (sin indicar, la de por defecto). No pertenece a un mes: vale
 * cualquier fecha. A una cuenta de oro le entran gramos: el ingreso queda en XAU, con hasta tres decimales y sin
 * subir el presupuesto, se indique lo que se indique. A una de dinero no le vale XAU.
 */
export function newIncome(state: AppState, input: IncomeInput, id: string): Income | null {
  const desc = (input.desc ?? '').trim();
  const account = input.accountId === undefined ? defaultAccount(state) : (accountsById(state).get(input.accountId) ?? null);
  if (!account || !isISODate(input.date) || !positive(input.amount) || desc.length > MAX_LEN.desc) return null;
  const recurring = input.recurring === true;
  const base = { id, date: input.date, desc, accountId: account.id, recurring };
  if (isGold(account.currency)) {
    const amount = grams(input.amount);
    return positive(amount) ? { ...base, amount, cur: GOLD, budget: false, rate: null } : null;
  }
  if (!isCurrency(input.cur)) return null;
  return { ...base, amount: input.amount, cur: input.cur, budget: input.budget === true, rate: validRate(input.rate) };
}

/** `cardId` de una fila nueva con tarjeta: el que se pidió si es una tarjeta activa; si no, la primera activa; sin ninguna, nada. */
function cardFor(state: AppState, wanted: string | undefined): { cardId?: string } {
  const id = state.cards.some((c) => c.id === wanted && c.active) ? wanted : defaultCardId(state);
  return id ? { cardId: id } : {};
}

/** Monto > 0, fecha válida y una meta que exista. */
export function newContribution(state: AppState, input: ContributionInput, id: string): Contribution | null {
  if (!state.goals.some((g) => g.id === input.goalId) || !isISODate(input.date) || !positive(input.amount) || !isCurrency(input.cur)) return null;
  // Una cuenta que no existe o es de oro no se guarda: el aporte queda sin cuenta.
  const accountId = input.accountId && hasMoneyAccount(state, input.accountId) ? input.accountId : null;
  return { id, goalId: input.goalId, date: input.date, amount: input.amount, cur: input.cur, rate: validRate(input.rate), accountId };
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

/**
 * Nombre (obligatorio), una de las tres monedas u oro, y un saldo inicial finito (los gramos de una de oro, con
 * hasta tres decimales). Queda al final de la lista, visible.
 */
export function newAccount(state: AppState, input: AccountInput, id: string): Account | null {
  const name = named(input.name);
  const typed = input.opening ?? 0;
  if (!name || !isAccountCurrency(input.currency) || !Number.isFinite(typed)) return null;
  const opening = isGold(input.currency) ? grams(typed) : typed;
  const sort = state.accounts.reduce((max, a) => Math.max(max, a.sort), -1) + 1;
  return { id, name, currency: input.currency, opening, hidden: false, sort };
}

/** El nombre nuevo de esa cuenta tal como se guarda, o null si la cuenta no existe o el nombre no vale (vacío, demasiado largo). */
export function accountName(state: AppState, id: string, name: string): string | null {
  return hasAccount(state, id) && !isBlank(name) && name.length <= MAX_LEN.name ? name : null;
}

/** true si algo nombra esa cuenta: un gasto fijo, una transacción, un gasto fuera de presupuesto, un envío, un ingreso, un aporte o un movimiento del presupuesto de cualquier mes. */
export function accountInUse(state: AppState, id: string): boolean {
  if (state.incomes.some((i) => i.accountId === id)) return true;
  if (state.contribs.some((c) => c.accountId === id)) return true;
  return Object.values(state.months).some(
    (m) =>
      m.budgetLog.some((e) => e.accountId === id) ||
      m.fixed.some((f) => f.accountId === id) ||
      m.tx.some((t) => t.accountId === id) ||
      (m.outside ?? []).some((o) => o.accountId === id) ||
      (m.cards ?? []).some((c) => c.payments.some((p) => p.accountId === id)) ||
      m.transfers.some((t) => t.fromAccountId === id || t.toAccountId === id),
  );
}

/** Una cuenta en uso no se puede eliminar (el servidor respondería 409): se oculta. */
export function canRemoveAccount(state: AppState, id: string): boolean {
  return hasAccount(state, id) && !accountInUse(state, id);
}

/**
 * Se puede ocultar cualquier cuenta visible menos la última de dinero: sin ninguna a la vista no habría de dónde
 * pagar (una de oro no paga nada, así que no cuenta para eso y se puede ocultar siempre).
 */
export function canHideAccount(state: AppState, id: string): boolean {
  const visible = state.accounts.filter((a) => !a.hidden);
  const account = visible.find((a) => a.id === id);
  if (!account) return false;
  return !isMoneyAccount(account) || visible.filter(isMoneyAccount).length > 1;
}

/** El último mes del usuario: el único en el que se puede corregir un saldo. null si no hay meses. */
export function latestKey(state: AppState): MonthKey | null {
  return sortedKeys(state).at(-1) ?? null;
}

/**
 * Corregir un saldo: el saldo inicial que hay que guardar para que la cuenta muestre `balance` al final del mes
 * `monthKey` (shared/calc openingFor). null si no se puede: la cuenta no existe, el número no es finito o el mes
 * no es el último del usuario (los saldos de meses pasados son historia: corregirlos movería todos los de después).
 * De una cuenta de oro se corrigen los gramos, con hasta tres decimales.
 */
export function openingForBalance(state: AppState, monthKey: MonthKey, accountId: string, balance: number): number | null {
  const account = accountsById(state).get(accountId);
  if (latestKey(state) !== monthKey || !account || !Number.isFinite(balance)) return null;
  if (!isGold(account.currency)) return openingFor(state, accountId, monthKey, balance);
  return grams(openingFor(state, accountId, monthKey, grams(balance)));
}

// ── Presupuesto y tasas del mes ──────────────────────────────────────────────

const openMonth = (state: AppState, key: MonthKey) => state.months[key] !== undefined && !state.months[key].closed;

/**
 * La parte del presupuesto de una cuenta tal como se ve (BudgetPart.amount: su registro más los ingresos que
 * suben el presupuesto y el neto de los envíos que lo mueven) pasa a ser `amount`. Lo que se manda es lo que debe
 * sumar su registro: `amount` menos lo que ya ponen esos ingresos y envíos (calc.budgetRaised, negativo en la
 * cuenta de la que sale un envío: ahí el registro suma más de lo que se ve), que no se tocan desde aquí. null si
 * no se puede: mes cerrado, cuenta que no existe, monto que no es un número >= 0, o un monto por debajo de lo que
 * ponen los ingresos y los envíos (el registro quedaría en negativo y la API lo rechaza).
 */
export function budgetPart(state: AppState, key: MonthKey, accountId: string, amount: number): MonthPatch | null {
  if (!openMonth(state, key) || !hasMoneyAccount(state, accountId) || !nonNegative(amount)) return null;
  const fromLog = round6(amount - budgetRaised(state, key, accountId));
  return fromLog >= 0 ? { budgets: { [accountId]: fromLog } } : null;
}

/** Un movimiento escrito a mano en el registro de un mes abierto: una cuenta que exista, un monto finito distinto de 0 y una fecha del mes. */
export function newBudgetEntry(state: AppState, key: MonthKey, input: BudgetEntryInput, id: string, today: ISODate): BudgetEntry | null {
  const date = input.date ?? clampToMonth(today, key);
  const note = (input.note ?? '').trim();
  const valid = Number.isFinite(input.amount) && input.amount !== 0 && isISODate(date) && inMonth(date, key) && note.length <= MAX_LEN.desc;
  if (!openMonth(state, key) || !hasMoneyAccount(state, input.accountId) || !valid) return null;
  // The server rejects an income of another account or one that does not exist; the same check keeps the local row honest.
  const income = input.incomeId ? state.incomes.find((i) => i.id === input.incomeId) : undefined;
  if (input.incomeId && income?.accountId !== input.accountId) return null;
  return { id, date, accountId: input.accountId, amount: input.amount, kind: input.kind ?? 'adjust', note, ...(input.incomeId && { incomeId: input.incomeId }) };
}

/** El movimiento de ese id en el registro de un mes abierto; null si no está, si el mes está cerrado o si aún no tiene id del servidor. */
export function budgetEntry(state: AppState, key: MonthKey, id: string): BudgetEntry | null {
  if (!openMonth(state, key) || isLocalEntry(id)) return null;
  return state.months[key]!.budgetLog.find((e) => e.id === id) ?? null;
}

/**
 * El movimiento 'leftover' que suma a ese mes lo que sobró del anterior, como lo escribe el servidor
 * (POST …/leftover): en la cuenta por defecto y en su moneda, con la última tasa del mes. null si no se puede:
 * mes cerrado, sin mes anterior, ya sumado, sin cuentas, o nada que sumar (sobró 0).
 */
export function leftoverEntry(state: AppState, key: MonthKey, id: string, today: ISODate): BudgetEntry | null {
  const { leftover, added } = leftoverFor(state, key);
  const account = defaultAccount(state);
  if (!openMonth(state, key) || leftover === null || added || !account) return null;
  const amount = convert(state, key, leftover, state.mainCurrency, account.currency);
  return amount === 0 ? null : { id, date: clampToMonth(today, key), accountId: account.id, amount, kind: 'leftover', note: '' };
}

/** La tasa escrita de un par desde una fecha: un mes abierto, dos monedas distintas, una tasa > 0 y una fecha de ese mes. */
export function monthRate(state: AppState, key: MonthKey, from: Currency, to: Currency, rate: number, date: ISODate): MonthRate | null {
  const valid = isCurrency(from) && isCurrency(to) && from !== to && positive(rate) && isISODate(date) && inMonth(date, key);
  return openMonth(state, key) && valid ? { from, to, rate, date } : null;
}

/** La tasa escrita de ese par y esa fecha en ese mes, en el sentido en que se guardó; null si no hay o el mes está cerrado. */
export function typedRate(state: AppState, key: MonthKey, from: Currency, to: Currency, date: ISODate): MonthRate | null {
  return (openMonth(state, key) && state.months[key]!.rates.find((r) => sameRate(r, from, to, date))) || null;
}

// ── Monedas y cuenta por defecto ─────────────────────────────────────────────

/**
 * Lo que hay que mandar para que `cur` sea la moneda principal (o la segunda); {} si ya lo era y null si no es una
 * moneda. Las dos tienen que quedar distintas: elegir como principal la que es la segunda deja la segunda en
 * ninguna (no se rechaza ni se intercambia); elegir como segunda la que es la principal las intercambia, y para
 * eso van las dos en la misma petición. `null` como segunda quita la segunda moneda.
 */
export function currencyChange(state: AppState, role: 'main' | 'second', cur: Currency | null): SettingsUpdate | null {
  const { mainCurrency: main, secondCurrency: second } = state;
  if (cur === null) return role === 'second' ? (second === null ? {} : { secondCurrency: null }) : null;
  if (!isCurrency(cur)) return null;
  if (cur === (role === 'main' ? main : second)) return {};
  if (role === 'main') return { mainCurrency: cur, ...(cur === second ? { secondCurrency: null } : {}) };
  if (cur !== main) return { secondCurrency: cur };
  // Sin segunda moneda no hay con quién intercambiar la principal: se deja como está.
  return second ? { mainCurrency: second, secondCurrency: main } : {};
}

/**
 * Lo que hay que mandar para que 1 gramo de oro valga `amount` de `currency`; {} si ya era ese el precio y null
 * si no vale (la moneda no es una de las tres, o el monto no es un número >= 0). Un monto 0 (el campo vacío)
 * quita el precio: no hay precio por defecto.
 */
export function goldPriceChange(state: AppState, amount: number, currency: Currency): SettingsUpdate | null {
  if (!isCurrency(currency) || !nonNegative(amount)) return null;
  const next = amount > 0 ? { amount, currency } : null;
  return samePrice(next, state.goldPrice) ? {} : { goldPrice: next };
}

// ── Metas ────────────────────────────────────────────────────────────────────

const NO_PLAN: GoalPlan = { monthly: null, start: null, end: null };

/**
 * El plan tal como se guarda, o null si no es válido. Vale sin plan (los tres null o sin definir) o con plan
 * completo: monthly > 0 y dos meses 'YYYY-MM' con start <= end. Cualquier mezcla (solo una parte, mensual 0) no vale.
 */
export function normalizeGoalPlan(plan: Partial<GoalPlan>): GoalPlan | null {
  const monthly = plan.monthly ?? null;
  const start = plan.start ?? null;
  const end = plan.end ?? null;
  if (monthly === null && start === null && end === null) return NO_PLAN;
  if (monthly === null || !positive(monthly) || !isMonthKey(start) || !isMonthKey(end) || start > end) return null;
  return { monthly, start, end };
}

/** Nombre (obligatorio), una moneda (por defecto, la principal del usuario) y un plan válido. Queda al final de la lista. */
export function newGoal(state: AppState, input: GoalInput, id: string): Goal | null {
  const name = named(input.name);
  const plan = normalizeGoalPlan(input);
  const cur = input.cur ?? state.mainCurrency;
  const approxCur = input.approxCur ?? null;
  if (!name || !plan || !isCurrency(cur) || (approxCur !== null && !isCurrency(approxCur))) return null;
  const sort = state.goals.reduce((max, g) => Math.max(max, g.sort), -1) + 1;
  return { id, name, cur, ...plan, approxCur, sort };
}

/**
 * Lo que hay que mandar para aplicar `patch` a esa meta, o null si la meta no existe o quedaría inválida
 * (nombre en blanco, moneda desconocida, plan a medias). Si el patch toca cualquier campo del plan, salen los tres:
 * el servidor no admite una parte suelta. Un patch que no cambia nada da {}.
 */
export function goalChange(state: AppState, id: string, patch: GoalPatch): GoalPatch | null {
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return null;
  const out: GoalPatch = {};
  if (patch.name !== undefined) {
    const name = named(patch.name);
    if (!name) return null;
    if (name !== goal.name) out.name = name;
  }
  if (patch.cur !== undefined) {
    if (!isCurrency(patch.cur)) return null;
    if (patch.cur !== goal.cur) out.cur = patch.cur;
  }
  if (patch.approxCur !== undefined) {
    // null es un valor: "la moneda principal del usuario".
    if (patch.approxCur !== null && !isCurrency(patch.approxCur)) return null;
    if (patch.approxCur !== goal.approxCur) out.approxCur = patch.approxCur;
  }
  if (patch.sort !== undefined) {
    if (!Number.isFinite(patch.sort)) return null;
    if (patch.sort !== goal.sort) out.sort = patch.sort;
  }
  if (patch.monthly !== undefined || patch.start !== undefined || patch.end !== undefined) {
    // Cada campo: el del patch si viene (null incluido), si no el que ya tenía la meta.
    const plan = normalizeGoalPlan({
      monthly: patch.monthly !== undefined ? patch.monthly : goal.monthly,
      start: patch.start !== undefined ? patch.start : goal.start,
      end: patch.end !== undefined ? patch.end : goal.end,
    });
    if (!plan) return null;
    if (plan.monthly !== goal.monthly || plan.start !== goal.start || plan.end !== goal.end) Object.assign(out, plan);
  }
  return out;
}

/** Una meta con aportes no se puede eliminar (el servidor respondería 409): antes hay que borrar o mover sus aportes. */
export function canRemoveGoal(state: AppState, id: string): boolean {
  return state.goals.some((g) => g.id === id) && !state.contribs.some((c) => c.goalId === id);
}

// ── Tarjetas de crédito ──────────────────────────────────────────────────────

const hasCard = (state: AppState, id: string) => state.cards.some((c) => c.id === id);
const hasActiveCard = (state: AppState, id: string) => state.cards.some((c) => c.id === id && c.active);

/** Los campos de una tarjeta tal como los acepta el servidor; null si alguno no vale. */
export interface CardInput {
  name: string;
  bank?: string | null;
  last4?: string | null;
  cur?: Currency;
  limit?: number | null;
  cutoffDay?: number | null;
  dueDay?: number | null;
  active?: boolean;
}

const validDay = (n: number | null | undefined) => n == null || (Number.isInteger(n) && n >= 1 && n <= 31);
const validLast4 = (v: string | null | undefined) => v == null || v === '' || /^\d{4}$/.test(v);
const validLimit = (n: number | null | undefined) => n == null || positive(n);

/** Nombre (obligatorio, único sin distinguir mayúsculas), día de corte y de pago entre 1 y 31, límite > 0 y 4 dígitos. Queda al final. */
export function newCard(state: AppState, input: CardInput, id: string): CreditCard | null {
  const name = named(input.name);
  const bank = input.bank?.trim() || null;
  if (!name || (bank !== null && bank.length > MAX_LEN.name) || sameCardName(state, name)) return null;
  if (!validDay(input.cutoffDay) || !validDay(input.dueDay) || !validLimit(input.limit) || !validLast4(input.last4)) return null;
  const cur = input.cur ?? state.mainCurrency;
  if (!isCurrency(cur)) return null;
  const sort = state.cards.reduce((max, c) => Math.max(max, c.sort), -1) + 1;
  return {
    id,
    name,
    bank,
    last4: input.last4 || null,
    cur,
    limit: input.limit ?? null,
    cutoffDay: input.cutoffDay ?? null,
    dueDay: input.dueDay ?? null,
    active: input.active !== false,
    sort,
  };
}

function sameCardName(state: AppState, name: string, exceptId?: string): boolean {
  const fold = (t: string) => t.normalize('NFC').toLowerCase();
  return state.cards.some((c) => c.id !== exceptId && fold(c.name) === fold(name));
}

/**
 * Una tarjeta en uso no se puede borrar (el servidor respondería 409): algo la nombra (otros cargos, pagos, un gasto fijo
 * o una transacción) o, siendo la primera activa, hay gastos fijos o transacciones de tarjeta sin nombrar ninguna.
 */
export function cardInUse(state: AppState, id: string): boolean {
  const first = defaultCardId(state);
  return Object.values(state.months).some(
    (m) =>
      (m.cards ?? []).some((c) => c.cardId === id) ||
      m.fixed.some((f) => f.onCard === true && (f.cardId ?? first) === id) ||
      m.tx.some((t) => isCardTx(t) && (t.cardId ?? first) === id),
  );
}

export function canRemoveCard(state: AppState, id: string): boolean {
  return hasCard(state, id) && !cardInUse(state, id);
}

/** Se puede apagar una tarjeta activa solo si en el último mes no debe nada ni tiene cargos (calc.cardOffBlocked). */
export function canTurnOffCard(state: AppState, id: string): boolean {
  return state.cards.some((c) => c.id === id && c.active) && !cardOffBlocked(state, id);
}

/**
 * Editar una tarjeta (los campos que vengan). null si no existe o algo no vale: nombre vacío o repetido, días fuera de 1–31, límite <= 0,
 * apagarla debiendo algo, o cambiarle la moneda estando en uso (el servidor respondería 409).
 */
export function cardPatchChange(state: AppState, id: string, patch: CreditCardPatch): Action | null {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return null;
  const clean: CreditCardPatch = { ...patch };
  if (patch.name !== undefined) {
    const name = named(patch.name);
    if (!name || sameCardName(state, name, id)) return null;
    clean.name = name;
  }
  if (patch.bank !== undefined) clean.bank = patch.bank?.trim() || null;
  if (patch.last4 !== undefined) clean.last4 = patch.last4 || null;
  if (!validDay(patch.cutoffDay) || !validDay(patch.dueDay) || !validLimit(patch.limit) || !validLast4(patch.last4)) return null;
  if (patch.cur !== undefined && (!isCurrency(patch.cur) || (patch.cur !== card.cur && cardInUse(state, id)))) return null;
  if (patch.active === false && card.active && !canTurnOffCard(state, id)) return null;
  const changed = (Object.keys(clean) as (keyof CreditCardPatch)[]).some((k) => clean[k] !== card[k as keyof CreditCard]);
  return changed ? { type: 'creditCard/patch', id, patch: clean } : null;
}

export function cardRemoval(state: AppState, id: string): Action | null {
  return canRemoveCard(state, id) ? { type: 'creditCard/remove', id } : null;
}

/** Los «otros cargos» de una tarjeta en el mes: un mes abierto, una tarjeta que exista y un número finito >= 0. */
export function cardOtherChange(state: AppState, key: MonthKey, cardId: string, other: number): Action | null {
  return openMonth(state, key) && hasCard(state, cardId) && nonNegative(other) ? { type: 'card/other', key, cardId, other } : null;
}

/**
 * Un importe escrito con dos decimales que cae a menos de medio centavo de lo que falta por pagar es eso mismo: el
 * diálogo propone lo que falta redondeado, y confirmarlo tal cual no debe dejar un resto de céntimos.
 */
export function snapToTotal(amount: number, total: number): number {
  return Math.abs(amount - total) < 0.005 ? total : amount;
}

/**
 * Añadir un pago de una tarjeta en el mes: un mes abierto, un importe > 0 y no mayor que lo que falta por pagar
 * (calc.cardCalc.remainder), y una cuenta de dinero que exista. Como el servidor (db.payCard): lo demás no se envía.
 * `date` es hoy; el servidor la lleva al mes si cae fuera. null si no se puede.
 */
export function cardPayment(state: AppState, key: MonthKey, cardId: string, amount: number, accountId: string, id: string, date: ISODate): Action | null {
  if (!openMonth(state, key) || !hasCard(state, cardId) || !hasMoneyAccount(state, accountId) || !positive(amount)) return null;
  const left = cardCalc(state, key, cardId).remainder;
  const paid = snapToTotal(amount, left);
  return left > 0 && paid <= left ? { type: 'card/pay', key, cardId, payment: { id, date: clampToMonth(date, key), accountId, amount: paid } } : null;
}

/** Quitar todos los pagos de una tarjeta: un mes abierto con alguno. */
export function cardUnpay(state: AppState, key: MonthKey, cardId: string): Action | null {
  return openMonth(state, key) && cardOf(state.months[key]!, cardId).payments.length > 0 ? { type: 'card/unpay', key, cardId } : null;
}

/** Quitar un pago: un mes abierto que lo tiene. */
export function cardUnpayOne(state: AppState, key: MonthKey, cardId: string, id: string): Action | null {
  return openMonth(state, key) && cardOf(state.months[key]!, cardId).payments.some((p) => p.id === id) ? { type: 'card/unpayOne', key, cardId, id } : null;
}
