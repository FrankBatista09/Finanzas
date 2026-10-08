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
// (la cuenta por defecto, la tasa del mes de un envío, el saldo inicial que corrige un saldo).

import type {
  AccountPatch,
  ContributionPatch,
  FixedPatch,
  GoalPatch,
  IncomePatch,
  MonthPatch,
  SettingsUpdate,
  TransferPatch,
  TxPatch,
} from '../../shared/api';
import { accountsById, defaultAccount, openingFor, rateFor, sortedKeys } from '../../shared/calc';
import { CURRENCIES, MAX_LEN } from '../../shared/constants';
import { isISODate, isMonthKey } from '../../shared/month';
import type {
  Account,
  AppState,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  Income,
  ISODate,
  Month,
  MonthKey,
  MonthRate,
  Transaction,
  Transfer,
} from '../../shared/types';

export type Action =
  | { type: 'settings/patch'; patch: SettingsUpdate }
  | { type: 'account/add'; row: Account }
  | { type: 'account/patch'; id: string; patch: AccountPatch }
  | { type: 'account/remove'; id: string }
  | { type: 'month/patch'; key: MonthKey; patch: MonthPatch }
  | { type: 'month/reopen'; key: MonthKey }
  | { type: 'rate/set'; key: MonthKey; rate: MonthRate }
  | { type: 'rate/remove'; key: MonthKey; from: Currency; to: Currency }
  | { type: 'fixed/add'; row: FixedExpense }
  | { type: 'fixed/patch'; id: string; patch: FixedPatch }
  | { type: 'fixed/remove'; id: string }
  | { type: 'tx/add'; row: Transaction }
  | { type: 'tx/patch'; id: string; patch: TxPatch }
  | { type: 'tx/remove'; id: string }
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

type MonthList = 'fixed' | 'tx' | 'transfers';
type TopList = 'accounts' | 'incomes' | 'goals' | 'contribs';

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
    if (state.months[key]![list].some((r) => r.id === id)) return key;
  }
  return null;
}

function patchRow<L extends MonthList>(state: AppState, list: L, id: string, patch: Partial<Month[L][number]>): AppState {
  const key = monthWith(state, list, id);
  if (!key) return state;
  return withMonth(state, key, (m) => ({ ...m, [list]: m[list].map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

function removeRow(state: AppState, list: MonthList, id: string): AppState {
  const key = monthWith(state, list, id);
  if (!key) return state;
  return withMonth(state, key, (m) => ({ ...m, [list]: m[list].filter((r) => r.id !== id) }));
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

/** Las partes del presupuesto que vengan sustituyen a las que había; 0 quita la parte, como en el servidor. */
function patchMonth(m: Month, patch: MonthPatch): Month {
  if (!patch.budgets) return m;
  const budgets = { ...m.budgets };
  let changed = false;
  for (const [id, amount] of Object.entries(patch.budgets)) {
    if ((budgets[id] ?? 0) === amount && (amount !== 0 || !Object.hasOwn(budgets, id))) continue;
    changed = true;
    if (amount === 0) Reflect.deleteProperty(budgets, id);
    else budgets[id] = amount;
  }
  return changed ? { ...m, budgets } : m;
}

const samePair = (r: Pick<MonthRate, 'from' | 'to'>, from: Currency, to: Currency) =>
  (r.from === from && r.to === to) || (r.from === to && r.to === from);

/** Una sola tasa escrita por par: la nueva sustituye a la que hubiera, estuviera en el sentido que estuviera. */
function setRate(m: Month, rate: MonthRate): Month {
  const i = m.rates.findIndex((r) => samePair(r, rate.from, rate.to));
  if (i < 0) return { ...m, rates: [...m.rates, rate] };
  const old = m.rates[i]!;
  if (old.from === rate.from && old.to === rate.to && old.rate === rate.rate) return m;
  const rates = m.rates.filter((r) => !samePair(r, rate.from, rate.to));
  rates.splice(i, 0, rate);
  return { ...m, rates };
}

/** Solo cambia lo que venga; `theme: null` vuelve a la paleta original y `defaultAccountId: null` a la cuenta automática. */
function patchSettings(state: AppState, patch: SettingsUpdate): AppState {
  const next = {
    theme: patch.theme !== undefined ? patch.theme : state.theme,
    language: patch.language ?? state.language,
    mainCurrency: patch.mainCurrency ?? state.mainCurrency,
    secondCurrency: patch.secondCurrency ?? state.secondCurrency,
    defaultAccountId: patch.defaultAccountId !== undefined ? patch.defaultAccountId : state.defaultAccountId,
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
      return withMonth(state, action.key, (m) => patchMonth(m, action.patch));
    case 'month/reopen':
      return withMonth(state, action.key, (m) => (m.closed ? { ...m, closed: false, closedAt: null } : m));

    case 'rate/set':
      return withMonth(state, action.key, (m) => setRate(m, action.rate));
    case 'rate/remove':
      return withMonth(state, action.key, (m) =>
        m.rates.some((r) => samePair(r, action.from, action.to))
          ? { ...m, rates: m.rates.filter((r) => !samePair(r, action.from, action.to)) }
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
    return { ...prev, patch: { budgets: { ...prev.patch.budgets, ...next.patch.budgets } } };
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
 * A qué entidad se refiere la acción ('tx:abc', 'month:2026-10', 'rate:2026-10:DOP-USD', 'settings'). Sirve de clave
 * para agrupar ediciones de una fila y para descartar lo que quede en cola de una fila que ya no existe.
 */
export function targetOf(action: Action): string {
  const kind = action.type.slice(0, action.type.indexOf('/'));
  if (action.type === 'settings/patch') return kind;
  if (action.type === 'rate/set') return `${kind}:${action.key}:${pairKey(action.rate.from, action.rate.to)}`;
  if (action.type === 'rate/remove') return `${kind}:${action.key}:${pairKey(action.from, action.to)}`;
  if ('key' in action) return `${kind}:${action.key}`;
  return `${kind}:${'row' in action ? action.row.id : action.id}`;
}

// ── Reglas del contrato ──────────────────────────────────────────────────────
// Lo que shared/api.ts exige a cada escritura se comprueba aquí, contra el estado que se ve, antes de tocarlo:
// una escritura que el servidor rechazaría nunca llega a enviarse.

const positive = (n: number) => Number.isFinite(n) && n > 0;
const nonNegative = (n: number) => Number.isFinite(n) && n >= 0;
const isCurrency = (v: unknown): v is Currency => (CURRENCIES as readonly unknown[]).includes(v);
const hasAccount = (state: AppState, id: string) => state.accounts.some((a) => a.id === id);

const isBlank = (text: string) => text.trim() === '';
const notAmount = (n: number) => !nonNegative(n);
const notDate = (date: string) => !isISODate(date);
const notCurrency = (cur: Currency) => !isCurrency(cur);

/** El texto sin espacios sobrantes, o null si queda vacío o se pasa de `max`. */
function named(text: string, max: number = MAX_LEN.name): string | null {
  const out = text.trim();
  return out && out.length <= max ? out : null;
}

/** La cuenta de una fila nueva: la que se indique (tiene que existir) o, si no se indica, la de por defecto. */
function accountFor(state: AppState, accountId: string | undefined): string | null {
  if (accountId !== undefined) return hasAccount(state, accountId) ? accountId : null;
  return defaultAccount(state)?.id ?? null;
}

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

/** Edición de un gasto fijo: concepto no vacío, monto >= 0 y una cuenta que exista. */
export function fixedChange(state: AppState, patch: FixedPatch): FixedPatch {
  return keepValid(patch, { name: isBlank, amount: notAmount, cur: notCurrency, accountId: (id) => !hasAccount(state, id) });
}

/** Edición de una transacción: descripción no vacía, fecha válida, monto >= 0 y una cuenta que exista. */
export function txChange(state: AppState, patch: TxPatch): TxPatch {
  return keepValid(patch, {
    desc: isBlank,
    date: notDate,
    amount: notAmount,
    cur: notCurrency,
    accountId: (id) => !hasAccount(state, id),
  });
}

/** Edición de un ingreso: fecha válida, monto >= 0 y una cuenta que exista. La descripción puede quedar vacía. */
export function incomeChange(state: AppState, patch: IncomePatch): IncomePatch {
  return keepValid(patch, {
    date: notDate,
    desc: (desc) => desc.length > MAX_LEN.desc,
    amount: notAmount,
    cur: notCurrency,
    accountId: (id) => !hasAccount(state, id),
  });
}

/** Edición de un aporte: una meta que exista, fecha válida y monto >= 0. */
export function contributionChange(state: AppState, patch: ContributionPatch): ContributionPatch {
  return keepValid(patch, {
    goalId: (id) => !state.goals.some((g) => g.id === id),
    date: notDate,
    amount: notAmount,
    cur: notCurrency,
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
}

export interface IncomeInput {
  date: ISODate;
  desc?: string;
  /** Cuenta a la que entra. Sin indicar: la cuenta por defecto del usuario. */
  accountId?: string;
  amount: number;
  cur: Currency;
}

export interface ContributionInput {
  goalId: string;
  date: ISODate;
  amount: number;
  cur: Currency;
}

export interface AccountInput {
  name: string;
  currency: Currency;
  /** Saldo inicial, en la moneda de la cuenta (puede ser negativo). Sin indicar: 0. */
  opening?: number;
}

/** El plan de una meta: los tres valores juntos, o los tres null si es de aportes variables. */
export type GoalPlan = Pick<Goal, 'monthly' | 'start' | 'end'>;

/** Lo que sale del diálogo de una meta. Sin plan basta el nombre (o los tres campos del plan en null). */
export interface GoalInput extends Partial<GoalPlan> {
  name: string;
  /** Moneda de la meta. Sin indicar: la moneda principal del usuario. */
  cur?: Currency;
}

/** Concepto, monto > 0 y una cuenta que exista. Queda al final de la lista, sin pagar. */
export function newFixed(state: AppState, monthKey: MonthKey, input: FixedInput, id: string): FixedExpense | null {
  const month = state.months[monthKey];
  const name = input.name.trim();
  const accountId = accountFor(state, input.accountId);
  if (!month || !name || !positive(input.amount) || !isCurrency(input.cur) || !accountId) return null;
  const sort = month.fixed.reduce((max, f) => Math.max(max, f.sort), -1) + 1;
  return { id, monthKey, name, day: (input.day ?? '').trim(), amount: input.amount, cur: input.cur, paid: false, accountId, sort };
}

/** Descripción, fecha válida, monto > 0 y una cuenta que exista. La transacción va al mes seleccionado, sea cual sea su fecha. */
export function newTx(state: AppState, monthKey: MonthKey, input: TxInput, id: string): Transaction | null {
  const desc = input.desc.trim();
  const accountId = accountFor(state, input.accountId);
  if (!state.months[monthKey] || !desc || !isISODate(input.date) || !positive(input.amount) || !isCurrency(input.cur) || !accountId) return null;
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
  };
}

/**
 * La tasa con la que se guarda un envío entre esas dos cuentas, o null si el envío no vale: falta una cuenta, son
 * la misma, o la tasa indicada no es > 0. Sin tasa indicada es la del mes para ese par; entre monedas iguales, 1.
 */
function transferRate(state: AppState, monthKey: MonthKey, fromId: string, toId: string, given?: number): number | null {
  const accounts = accountsById(state);
  const from = accounts.get(fromId);
  const to = accounts.get(toId);
  if (!from || !to || from.id === to.id) return null;
  if (from.currency === to.currency) return 1;
  if (given === undefined) return rateFor(state, monthKey, from.currency, to.currency).rate;
  return positive(given) ? given : null;
}

/** Vía (texto libre, obligatoria), fecha válida, monto > 0 y dos cuentas distintas que existan. */
export function newTransfer(state: AppState, monthKey: MonthKey, input: TransferInput, id: string): Transfer | null {
  const via = named(input.via, MAX_LEN.label);
  if (!via || !state.months[monthKey] || !isISODate(input.date) || !positive(input.amount)) return null;
  const rate = transferRate(state, monthKey, input.fromAccountId, input.toAccountId, input.rate);
  if (rate === null) return null;
  return { id, monthKey, date: input.date, via, fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, amount: input.amount, rate };
}

/**
 * Lo que hay que mandar para aplicar `patch` a ese envío; {} si no queda nada que guardar (o el envío no existe).
 * Como en las demás celdas, lo que no vale se ignora: una vía vacía, un monto negativo, una tasa que no sea > 0 o
 * un cambio de cuenta que dejaría el envío con una cuenta que no existe o con la misma en los dos lados.
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

  const accounts = accountsById(state);
  let fromId = row.fromAccountId;
  let toId = row.toAccountId;
  const nextFrom = patch.fromAccountId ?? fromId;
  const nextTo = patch.toAccountId ?? toId;
  if ((nextFrom !== fromId || nextTo !== toId) && accounts.has(nextFrom) && accounts.has(nextTo) && nextFrom !== nextTo) {
    if (nextFrom !== fromId) out.fromAccountId = nextFrom;
    if (nextTo !== toId) out.toAccountId = nextTo;
    fromId = nextFrom;
    toId = nextTo;
  }

  const fromCur = accounts.get(fromId)?.currency;
  const toCur = accounts.get(toId)?.currency;
  const typed = patch.rate !== undefined && positive(patch.rate) ? patch.rate : undefined;
  if (fromCur && toCur && fromCur === toCur) {
    if (row.rate !== 1) out.rate = 1;
  } else if (typed !== undefined) {
    out.rate = typed;
  } else if (fromCur && toCur) {
    const moved = fromCur !== accounts.get(row.fromAccountId)?.currency || toCur !== accounts.get(row.toAccountId)?.currency;
    if (moved) out.rate = rateFor(state, monthKey, fromCur, toCur).rate;
  }
  return out;
}

/** Fecha válida, monto > 0 y una cuenta que exista. No pertenece a un mes: vale cualquier fecha. */
export function newIncome(state: AppState, input: IncomeInput, id: string): Income | null {
  const desc = (input.desc ?? '').trim();
  const accountId = accountFor(state, input.accountId);
  if (!accountId || !isISODate(input.date) || !positive(input.amount) || !isCurrency(input.cur) || desc.length > MAX_LEN.desc) return null;
  return { id, date: input.date, desc, accountId, amount: input.amount, cur: input.cur };
}

/** Monto > 0, fecha válida y una meta que exista. */
export function newContribution(state: AppState, input: ContributionInput, id: string): Contribution | null {
  if (!state.goals.some((g) => g.id === input.goalId) || !isISODate(input.date) || !positive(input.amount) || !isCurrency(input.cur)) return null;
  return { id, goalId: input.goalId, date: input.date, amount: input.amount, cur: input.cur };
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

/** Nombre (obligatorio), una de las tres monedas y un saldo inicial finito. Queda al final de la lista, visible. */
export function newAccount(state: AppState, input: AccountInput, id: string): Account | null {
  const name = named(input.name);
  const opening = input.opening ?? 0;
  if (!name || !isCurrency(input.currency) || !Number.isFinite(opening)) return null;
  const sort = state.accounts.reduce((max, a) => Math.max(max, a.sort), -1) + 1;
  return { id, name, currency: input.currency, opening, hidden: false, sort };
}

/** El nombre nuevo de esa cuenta tal como se guarda, o null si la cuenta no existe o el nombre no vale (vacío, demasiado largo). */
export function accountName(state: AppState, id: string, name: string): string | null {
  return hasAccount(state, id) && !isBlank(name) && name.length <= MAX_LEN.name ? name : null;
}

/** true si algo nombra esa cuenta: un gasto fijo, una transacción, un envío, un ingreso o una parte del presupuesto de cualquier mes. */
export function accountInUse(state: AppState, id: string): boolean {
  if (state.incomes.some((i) => i.accountId === id)) return true;
  return Object.values(state.months).some(
    (m) =>
      Object.hasOwn(m.budgets, id) ||
      m.fixed.some((f) => f.accountId === id) ||
      m.tx.some((t) => t.accountId === id) ||
      m.transfers.some((t) => t.fromAccountId === id || t.toAccountId === id),
  );
}

/** Una cuenta en uso no se puede eliminar (el servidor respondería 409): se oculta. */
export function canRemoveAccount(state: AppState, id: string): boolean {
  return hasAccount(state, id) && !accountInUse(state, id);
}

/** Se puede ocultar cualquier cuenta visible menos la última: sin ninguna a la vista no habría de dónde pagar. */
export function canHideAccount(state: AppState, id: string): boolean {
  const visible = state.accounts.filter((a) => !a.hidden);
  return visible.length > 1 && visible.some((a) => a.id === id);
}

/** El último mes del usuario: el único en el que se puede corregir un saldo. null si no hay meses. */
export function latestKey(state: AppState): MonthKey | null {
  return sortedKeys(state).at(-1) ?? null;
}

/**
 * Corregir un saldo: el saldo inicial que hay que guardar para que la cuenta muestre `balance` al final del mes
 * `monthKey` (shared/calc openingFor). null si no se puede: la cuenta no existe, el número no es finito o el mes
 * no es el último del usuario (los saldos de meses pasados son historia: corregirlos movería todos los de después).
 */
export function openingForBalance(state: AppState, monthKey: MonthKey, accountId: string, balance: number): number | null {
  if (latestKey(state) !== monthKey || !hasAccount(state, accountId) || !Number.isFinite(balance)) return null;
  return openingFor(state, accountId, monthKey, balance);
}

// ── Presupuesto y tasas del mes ──────────────────────────────────────────────

const openMonth = (state: AppState, key: MonthKey) => state.months[key] !== undefined && !state.months[key].closed;

/** La parte del presupuesto de una cuenta: un mes abierto, una cuenta que exista y un monto >= 0 (0 la quita; la API rechaza negativos). */
export function budgetPart(state: AppState, key: MonthKey, accountId: string, amount: number): MonthPatch | null {
  const valid = Number.isFinite(amount) && amount >= 0;
  return openMonth(state, key) && hasAccount(state, accountId) && valid ? { budgets: { [accountId]: amount } } : null;
}

/** La tasa escrita de un par: un mes abierto, dos monedas distintas y una tasa > 0. */
export function monthRate(state: AppState, key: MonthKey, from: Currency, to: Currency, rate: number): MonthRate | null {
  return openMonth(state, key) && isCurrency(from) && isCurrency(to) && from !== to && positive(rate) ? { from, to, rate } : null;
}

/** La tasa escrita de ese par en ese mes, en el sentido en que se guardó; null si no hay o el mes está cerrado. */
export function typedRate(state: AppState, key: MonthKey, from: Currency, to: Currency): MonthRate | null {
  return (openMonth(state, key) && state.months[key]!.rates.find((r) => samePair(r, from, to))) || null;
}

// ── Monedas y cuenta por defecto ─────────────────────────────────────────────

/**
 * Lo que hay que mandar para que `cur` sea la moneda principal (o la segunda); {} si ya lo era y null si no es una
 * moneda. Las dos tienen que quedar distintas: elegir la que hoy ocupa el otro puesto las intercambia, y para eso
 * van las dos en la misma petición.
 */
export function currencyChange(state: AppState, role: 'main' | 'second', cur: Currency): SettingsUpdate | null {
  if (!isCurrency(cur)) return null;
  const { mainCurrency: main, secondCurrency: second } = state;
  if (cur === (role === 'main' ? main : second)) return {};
  if (cur === (role === 'main' ? second : main)) return { mainCurrency: second, secondCurrency: main };
  return role === 'main' ? { mainCurrency: cur } : { secondCurrency: cur };
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
  if (!name || !plan || !isCurrency(cur)) return null;
  const sort = state.goals.reduce((max, g) => Math.max(max, g.sort), -1) + 1;
  return { id, name, cur, ...plan, sort };
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
