// Cálculos puros sobre AppState: tasas, saldos de cuentas, el mes, las metas y los ingresos.
// Devuelven números; el formato (f2/f0), los textos y los colores los pone quien los muestre.
//
// Todo importe se guarda en su moneda original. Aquí se convierte, siempre con la tasa de una fecha concreta:
//  · lo que tiene fecha propia (transacciones, ingresos, aportes, la tasa por defecto de un envío) usa la tasa
//    vigente en SU fecha: escribir hoy una tasa nueva no cambia lo que ya estaba registrado;
//  · lo que es del mes entero (gastos fijos, partes del presupuesto, totales) usa la última tasa del mes;
//  · un saldo se expresa en otra moneda con la última tasa del mes que se está mirando.

import { CREDIT_CARD_METHOD, DEFAULT_USD_RATES, isGold } from './constants';
import { firstDay, monthOf, monthSpan } from './month';
import type {
  Account,
  AccountCurrency,
  AppState,
  BudgetEntry,
  BudgetEntryKind,
  Contribution,
  CreditCard,
  Currency,
  FixedExpense,
  Goal,
  Income,
  ISODate,
  Month,
  CardPayment,
  MonthCard,
  MonthKey,
  OutsideExpense,
  Transaction,
  Transfer,
} from './types';

/** Los gastos fuera de presupuesto de un mes (Month.outside es opcional). */
export function outsideOf(m: Month): readonly OutsideExpense[] {
  return m.outside ?? [];
}

/** Lo guardado de una tarjeta en un mes (Month.cards es opcional). */
export function cardOf(m: Month, cardId: string): MonthCard {
  return m.cards?.find((c) => c.cardId === cardId) ?? { cardId, other: 0, payments: [] };
}

/** Las tarjetas activas, en su orden. Solo estas suman a algo (se usan las activas AHORA en todos los meses). */
export function activeCards(state: Pick<AppState, 'cards'>): CreditCard[] {
  return state.cards.filter((c) => c.active).sort((a, b) => a.sort - b.sort);
}

/** La tarjeta a la que va lo que no dice cuál: la primera activa. null si no hay ninguna. */
export function defaultCardId(state: Pick<AppState, 'cards'>): string | null {
  return activeCards(state)[0]?.id ?? null;
}

/** Un gasto fijo que se paga con la tarjeta. */
export const isOnCard = (f: Pick<FixedExpense, 'onCard'>): boolean => f.onCard === true;

/** Un gasto fijo cargado a la tarjeta: es de la tarjeta Y está marcado. Marcarlo no lo paga de ninguna cuenta. */
export const isCharged = (f: Pick<FixedExpense, 'onCard' | 'paid'>): boolean => f.onCard === true && f.paid;

/** Una transacción hecha con la tarjeta de crédito: queda cargada a ella. */
export const isCardTx = (t: Pick<Transaction, 'method'>): boolean => t.method === CREDIT_CARD_METHOD;

export function sortedKeys(state: AppState): MonthKey[] {
  return Object.keys(state.months).sort();
}

/** Mes "en curso": el último mes abierto; si todos están cerrados, el último; null si no hay meses. */
export function currentKey(state: AppState): MonthKey | null {
  const keys = sortedKeys(state);
  const open = keys.filter((k) => !state.months[k]!.closed);
  return open[open.length - 1] ?? keys[keys.length - 1] ?? null;
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

export function accountsById(state: AppState): Map<string, Account> {
  return new Map(state.accounts.map((a) => [a.id, a]));
}

/** Las cuentas que se muestran (no ocultas), en su orden. */
export function visibleAccounts(state: AppState): Account[] {
  return state.accounts.filter((a) => !a.hidden).sort((a, b) => a.sort - b.sort);
}

/** Una cuenta de dinero: en una moneda, no en gramos de oro. */
export type MoneyAccount = Account & { currency: Currency };

/**
 * Solo las cuentas de dinero pagan gastos, llevan parte del presupuesto, envían o reciben envíos y pueden ser la
 * cuenta por defecto. Una de oro guarda gramos: solo tiene saldo inicial e ingresos (en gramos).
 */
export function isMoneyAccount(account: Account): account is MoneyAccount {
  return !isGold(account.currency);
}

/** Las cuentas visibles de dinero, en su orden: las que se ofrecen en la hoja del mes. */
export function moneyAccounts(state: AppState): MoneyAccount[] {
  return visibleAccounts(state).filter(isMoneyAccount);
}

/**
 * Cuenta de la que sale un gasto cuando no se indica otra: la elegida en Settings si sigue visible; si no,
 * la primera visible en la moneda principal; si no, la primera visible; si no hay visibles, la primera que haya.
 * Nunca una de oro: null si el usuario no tiene ninguna cuenta de dinero.
 */
export function defaultAccount(state: AppState): MoneyAccount | null {
  const visible = moneyAccounts(state);
  return (
    visible.find((a) => a.id === state.defaultAccountId) ??
    visible.find((a) => a.currency === state.mainCurrency) ??
    visible[0] ??
    [...state.accounts].sort((a, b) => a.sort - b.sort).filter(isMoneyAccount)[0] ??
    null
  );
}

// ── Tasas ────────────────────────────────────────────────────────────────────

/**
 * De dónde salió una tasa, de más a menos fiable:
 *  same      misma moneda (1)
 *  month     escrita a mano (o la inversa de la escrita), con fecha en ese mes y vigente en la fecha pedida
 *  transfers promedio ponderado de los envíos de ese mes entre esas dos monedas
 *  cross     cruzando por la tercera moneda (cada tramo: la escrita vigente o, si no, los envíos de ese mes)
 *  previous  de un mes anterior: la última escrita, que sigue vigente (`date` dice de cuándo es), o, si nunca
 *            se escribió ninguna, los envíos o el cruce del mes anterior más reciente que los tenga
 *  default   valor fijo de respaldo: nadie la ha escrito nunca. La interfaz debe avisarlo.
 */
export type RateSource = 'same' | 'month' | 'transfers' | 'cross' | 'previous' | 'default';

export interface RateInfo {
  /** 1 `from` = `rate` `to`. */
  rate: number;
  source: RateSource;
  /** Mes del que salió la tasa; null para 'same' y 'default'. */
  monthKey: MonthKey | null;
  /** Fecha de la tasa escrita a mano que se usó; null si la tasa no es una escrita ('month' siempre la trae). */
  date: ISODate | null;
}

interface TypedRate {
  from: Currency;
  to: Currency;
  rate: number;
  date: ISODate;
  monthKey: MonthKey;
}

const pairId = (a: Currency, b: Currency) => (a < b ? `${a}/${b}` : `${b}/${a}`);

// Las tasas se piden una vez por fila y por columna; se memorizan por objeto de estado (el estado no se muta:
// cada cambio produce uno nuevo, así que la memoria nunca queda desfasada).
const typedMemo = new WeakMap<AppState, Map<string, TypedRate[]>>();
const rateMemo = new WeakMap<AppState, Map<string, RateInfo>>();

/** Todas las tasas escritas del histórico, por par (sin sentido) y ordenadas por fecha. */
function typedRates(state: AppState): Map<string, TypedRate[]> {
  let byPair = typedMemo.get(state);
  if (byPair) return byPair;
  byPair = new Map();
  for (const key of sortedKeys(state)) {
    for (const r of state.months[key]!.rates) {
      if (!(r.rate > 0) || r.from === r.to) continue;
      const id = pairId(r.from, r.to);
      const list = byPair.get(id) ?? [];
      // Una tasa sin fecha (datos de antes de que la tuvieran) vale desde el primer día de su mes.
      list.push({ from: r.from, to: r.to, rate: r.rate, date: r.date ?? firstDay(key), monthKey: key });
      byPair.set(id, list);
    }
  }
  // Orden estable: con la misma fecha queda después la que se escribió después, y es la que vale.
  for (const list of byPair.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  typedMemo.set(state, byPair);
  return byPair;
}

/** La tasa escrita vigente en `date` para ese par: la última con fecha <= `date`, de cualquier mes. */
function typedAt(state: AppState, from: Currency, to: Currency, date: ISODate): { rate: number; date: ISODate; monthKey: MonthKey } | null {
  let hit: TypedRate | null = null;
  for (const r of typedRates(state).get(pairId(from, to)) ?? []) {
    if (r.date > date) break;
    hit = r;
  }
  return hit && { rate: hit.from === from ? hit.rate : 1 / hit.rate, date: hit.date, monthKey: hit.monthKey };
}

/** Tasa que dan los envíos de un mes entre dos monedas, en cualquier sentido: lo que salió en `from` frente a lo que entró en `to`. */
function transfersRate(month: Month, accounts: Map<string, Account>, from: Currency, to: Currency): number | null {
  let sumFrom = 0;
  let sumTo = 0;
  for (const t of month.transfers) {
    const a = accounts.get(t.fromAccountId)?.currency;
    const b = accounts.get(t.toAccountId)?.currency;
    if (!(t.amount > 0) || !(t.rate > 0)) continue;
    if (a === from && b === to) {
      sumFrom += t.amount;
      sumTo += t.amount * t.rate;
    } else if (a === to && b === from) {
      sumTo += t.amount;
      sumFrom += t.amount * t.rate;
    }
  }
  return sumFrom > 0 && sumTo > 0 ? sumTo / sumFrom : null;
}

const ALL: readonly Currency[] = ['DOP', 'USD', 'TRY'];

/**
 * Tasa para convertir `from` → `to` en la fecha `date` (por defecto, el final del mes `key`: la última tasa del
 * mes). Nunca falla. Se resuelve en este orden:
 *  1. la tasa escrita vigente en `date`: la última escrita para el par con fecha <= `date`, sea del mes `key`
 *     ('month') o de uno anterior ('previous'). Una tasa escrita después de `date` no cuenta: por eso escribir
 *     una tasa nueva no cambia lo convertido en filas anteriores;
 *  2. si no hay ninguna vigente: los envíos del mes `key`; cruzando por la tercera moneda; lo mismo en el mes
 *     registrado anterior más reciente que lo tenga; y, al final, el valor de respaldo ('default').
 * Acepta claves sin mes registrado (un ingreso con fecha de un mes que no existe): usa los anteriores.
 * `key` es el mes al que pertenece la fila (el de sus envíos); `date`, la fecha de la fila.
 */
export function rateFor(state: AppState, key: MonthKey, from: Currency, to: Currency, date?: ISODate): RateInfo {
  if (from === to) return { rate: 1, source: 'same', monthKey: null, date: null };
  // '-31' es una cota: ninguna fecha del mes la supera al comparar como texto.
  const at = date ?? `${key}-31`;
  let memo = rateMemo.get(state);
  if (!memo) rateMemo.set(state, (memo = new Map()));
  const id = `${key}|${at}|${from}|${to}`;
  const hit = memo.get(id);
  if (hit) return hit;

  let found: RateInfo | null = null;
  const typed = typedAt(state, from, to, at);
  if (typed) {
    found = { rate: typed.rate, source: typed.monthKey === key ? 'month' : 'previous', monthKey: typed.monthKey, date: typed.date };
  } else {
    const accounts = accountsById(state);
    const keys = sortedKeys(state);
    for (let i = keys.length - 1; i >= 0 && !found; i--) {
      const k = keys[i]!;
      if (k > key) continue;
      const month = state.months[k]!;
      const own = k === key;
      const direct = transfersRate(month, accounts, from, to);
      if (direct) {
        found = { rate: direct, source: own ? 'transfers' : 'previous', monthKey: k, date: null };
        break;
      }
      const leg = (a: Currency, b: Currency) => typedAt(state, a, b, at)?.rate ?? transfersRate(month, accounts, a, b);
      for (const via of ALL) {
        if (via === from || via === to) continue;
        const a = leg(from, via);
        const b = a && leg(via, to);
        if (a && b) {
          found = { rate: a * b, source: own ? 'cross' : 'previous', monthKey: k, date: null };
          break;
        }
      }
    }
  }
  if (!found) {
    const usd = { ...DEFAULT_USD_RATES, DOP: state.defaultRate > 0 ? state.defaultRate : DEFAULT_USD_RATES.DOP };
    found = { rate: usd[to] / usd[from], source: 'default', monthKey: null, date: null };
  }
  memo.set(id, found);
  return found;
}

/**
 * `amount` de `from` expresado en `to`. Sin `date`, con la última tasa del mes `key` (gastos fijos, presupuesto,
 * totales, saldos); con `date`, con la tasa vigente ese día (una fila con fecha propia).
 */
export function convert(state: AppState, key: MonthKey, amount: number, from: Currency, to: Currency, date?: ISODate): number {
  return from === to ? amount || 0 : (amount || 0) * rateFor(state, key, from, to, date).rate;
}

/** Como `convert`, para lo que no pertenece a un mes (ingresos, aportes): con la tasa vigente en `date`. */
export function convertOn(state: AppState, date: ISODate, amount: number, from: Currency, to: Currency): number {
  return convert(state, monthOf(date), amount, from, to, date);
}

/**
 * La tasa propia de una fila (ingreso o aporte) si cuenta: escrita (> 0) y con la moneda de la fila distinta de
 * la principal. Es moneda principal por 1 de la moneda de la fila. Si no, null: vale la automática (rateFor).
 */
export function ownRate(state: Pick<AppState, 'mainCurrency'>, row: { cur: AccountCurrency; rate?: number | null }): number | null {
  return row.rate != null && row.rate > 0 && row.cur !== state.mainCurrency && !isGold(row.cur) ? row.rate : null;
}

/**
 * Como `convertOn`, pero respetando la tasa propia de la fila. Solo gobierna la conversión moneda de la fila →
 * moneda PRINCIPAL; cualquier otro destino (la moneda de una cuenta o de una meta distinta de la principal) sigue
 * por la tasa vigente en la fecha, porque lo que el usuario fijó es a cuánto cambió ese dinero a la principal.
 */
function convertRow(
  state: AppState,
  date: ISODate,
  amount: number,
  from: Currency,
  to: Currency,
  rate: number | null | undefined,
): number {
  const own = to === state.mainCurrency ? ownRate(state, { cur: from, rate }) : null;
  return own && from !== to ? (amount || 0) * own : convertOn(state, date, amount, from, to);
}

/**
 * Gramos de oro expresados en `to`, con el precio escrito por el usuario (AppState.goldPrice): gramos × precio,
 * y de la moneda del precio a `to` con la conversión de siempre (la última tasa del mes `key`). null sin precio:
 * el oro no tiene valor en dinero hasta que alguien lo escribe (no hay precio por defecto).
 */
export function goldValue(state: AppState, key: MonthKey, grams: number, to: Currency): number | null {
  const price = state.goldPrice;
  if (!price || !(price.amount > 0)) return null;
  return convert(state, key, (grams || 0) * price.amount, price.currency, to);
}

/** Lo que entra a la cuenta de destino de un envío, en su moneda. */
export function transferReceived(t: Pick<Transfer, 'amount' | 'rate'>): number {
  return (t.amount || 0) * (t.rate || 0);
}

/** La comisión de un envío como gasto del mes: sale de la cuenta de origen, en su moneda, el día del envío. */
export interface TransferFee {
  /** Id del envío del que sale: la fila no existe por sí sola, cambia con él. */
  transferId: string;
  date: ISODate;
  /** La vía del envío ("Remitly"): con ella se nombra la fila ("Remitly fee"). */
  via: string;
  account: MoneyAccount;
  /** En la moneda de la cuenta de origen. Mayor que 0. */
  amount: number;
  cur: Currency;
}

/** Categoría (canónica) en la que cuentan las comisiones de los envíos. */
export const FEE_CATEGORY = 'Other';

/**
 * Las comisiones de los envíos de ese mes, en el orden de los envíos: una por envío con `fee` > 0. No se guardan
 * como transacciones: se derivan aquí, y cuentan como una transacción del mes (monthCalc) pagada desde la cuenta
 * de origen (balances). La de un envío cuya cuenta de origen ya no existe no sale: no se sabe en qué moneda era.
 */
export function transferFees(state: AppState, key: MonthKey): TransferFee[] {
  const byId = accountsById(state);
  const out: TransferFee[] = [];
  for (const t of state.months[key]?.transfers ?? []) {
    const account = byId.get(t.fromAccountId);
    if (!(t.fee > 0) || !account || !isMoneyAccount(account)) continue;
    out.push({ transferId: t.id, date: t.date, via: t.via, account, amount: t.fee, cur: account.currency });
  }
  return out;
}

// ── Saldos ───────────────────────────────────────────────────────────────────

export interface AccountBalance {
  account: Account;
  /** Saldo en la moneda de la cuenta. */
  balance: number;
  /**
   * El mismo saldo en la moneda principal y en la segunda, con las tasas del mes que se mira. De una cuenta de
   * oro, sus gramos al precio del oro; 0 si no hay precio (ver `valued`).
   */
  inMain: number;
  /** null sin segunda moneda. */
  inSecond: number | null;
  /** false solo para una cuenta de oro sin precio escrito: `inMain` e `inSecond` no dicen nada y no suma al total. */
  valued: boolean;
}

export interface Balances {
  /** Todas las cuentas (también las ocultas), en su orden. */
  accounts: AccountBalance[];
  /** Suma de las cuentas visibles: el "Total money". */
  totalMain: number;
  /** null sin segunda moneda. */
  totalSecond: number | null;
  /** true si alguna cuenta visible de oro quedó fuera del total porque no hay precio del oro. La interfaz lo avisa. */
  goldExcluded: boolean;
}

/**
 * Saldo de cada cuenta al final del mes `asOf`: su saldo inicial más todo lo que la movió hasta ese mes incluido.
 *  + ingresos (por su fecha)          − transacciones pagadas desde ella
 *  + envíos que le entran             − gastos fijos marcados como pagados desde ella
 *                                     − envíos que salen de ella, y su comisión
 *                                     − pagos de la tarjeta de crédito desde ella (Month.cards)
 *                                     − aportes a metas que dicen salir de ella (Contribution.accountId)
 * Un movimiento en otra moneda entra o sale convertido con la tasa vigente en su fecha (un gasto fijo, que no
 * tiene fecha, con la última de su mes). Lo cargado a la tarjeta (transacciones con tarjeta de crédito y gastos
 * fijos marcados "en tarjeta") NO mueve ningún saldo hasta que se paga la tarjeta. Un aporte a una meta solo mueve un saldo si indica su cuenta (en la moneda de la cuenta, con contribIn). Un movimiento
 * cuya cuenta ya no existe se ignora.
 * Una cuenta de oro lleva gramos: su saldo inicial más los ingresos en gramos que le entran. En dinero vale lo
 * que diga el precio del oro (goldValue); sin precio no tiene valor y no suma al total.
 */
export function balances(state: AppState, asOf: MonthKey): Balances {
  const byId = accountsById(state);
  const sum = new Map<string, number>(state.accounts.map((a) => [a.id, a.opening || 0]));
  const move = (accountId: string, key: MonthKey, amount: number, cur: AccountCurrency, sign: 1 | -1, date?: ISODate) => {
    const acc = byId.get(accountId);
    if (!acc) return;
    const to = acc.currency;
    if (isGold(to) || isGold(cur)) {
      // Gramos con gramos. Dinero y oro no se mezclan en un movimiento (la API lo rechaza): convertirlo con el
      // precio de hoy cambiaría los gramos de la cuenta cada vez que se corrige el precio.
      if (to === cur) sum.set(acc.id, sum.get(acc.id)! + sign * (amount || 0));
      return;
    }
    sum.set(acc.id, sum.get(acc.id)! + sign * convert(state, key, amount, cur, to, date));
  };

  for (const inc of state.incomes) {
    const k = monthOf(inc.date);
    if (k <= asOf) move(inc.accountId, k, inc.amount, inc.cur, 1, inc.date);
  }
  for (const c of state.contribs) {
    const acc = c.accountId ? byId.get(c.accountId) : undefined;
    // Un aporte es siempre dinero: una cuenta de oro no puede ser su origen (la API lo rechaza).
    if (acc && !isGold(acc.currency) && monthOf(c.date) <= asOf) sum.set(acc.id, sum.get(acc.id)! - contribIn(state, c, acc.currency));
  }
  for (const key of sortedKeys(state)) {
    if (key > asOf) break;
    const m = state.months[key]!;
    // Una transacción con tarjeta de crédito no sale de ninguna cuenta: lo hace el pago de la tarjeta (abajo).
    for (const t of m.tx) if (!isCardTx(t)) move(t.accountId, key, t.amount, t.cur, -1, t.date);
    // Fuera de presupuesto: resta del saldo igual que una transacción, pero monthCalc no lo cuenta.
    for (const o of outsideOf(m)) move(o.accountId, key, o.amount, o.cur, -1, o.date);
    for (const f of m.fixed) if (f.paid && !isOnCard(f)) move(f.accountId, key, f.amount, f.cur, -1);
    // Lo ÚNICO que la tarjeta le resta a una cuenta: lo que se pagó, en la moneda principal, convertido a la de la
    // cuenta con la última tasa del mes (como un gasto fijo, que tampoco guarda fecha).
    // Todos los pagos de tarjetas (también de una apagada: el dinero salió de verdad), en la moneda de su tarjeta.
    for (const mc of m.cards ?? []) {
      const cur = state.cards.find((c) => c.id === mc.cardId)?.cur ?? state.mainCurrency;
      for (const p of mc.payments) move(p.accountId, key, p.amount, cur, -1);
    }
    for (const t of m.transfers) {
      const from = byId.get(t.fromAccountId);
      const to = byId.get(t.toAccountId);
      // La comisión se cobra aparte, de la cuenta de origen y en su moneda: nunca se convierte.
      if (from) sum.set(from.id, sum.get(from.id)! - (t.amount || 0) - (t.fee || 0));
      if (to) sum.set(to.id, sum.get(to.id)! + transferReceived(t));
    }
  }

  const accounts = [...state.accounts]
    .sort((a, b) => a.sort - b.sort)
    .map((account) => {
      const balance = sum.get(account.id)!;
      const cur = account.currency;
      const inCur = (to: Currency) => (isGold(cur) ? goldValue(state, asOf, balance, to) : convert(state, asOf, balance, cur, to));
      const inMain = inCur(state.mainCurrency);
      const inSecond = state.secondCurrency ? inCur(state.secondCurrency) : null;
      return {
        account,
        balance,
        inMain: inMain ?? 0,
        inSecond: state.secondCurrency ? (inSecond ?? 0) : null,
        // Sin segunda moneda solo cuenta que el valor en la principal exista.
        valued: inMain !== null && (!state.secondCurrency || inSecond !== null),
      };
    });
  const visible = accounts.filter((a) => !a.account.hidden);
  return {
    accounts,
    totalMain: visible.reduce((a, b) => a + b.inMain, 0),
    totalSecond: state.secondCurrency ? visible.reduce((a, b) => a + (b.inSecond ?? 0), 0) : null,
    goldExcluded: visible.some((a) => !a.valued),
  };
}

/** El saldo de una cuenta de dinero. */
export type MoneyBalance = AccountBalance & { account: MoneyAccount };

export function isMoneyBalance(b: AccountBalance): b is MoneyBalance {
  return isMoneyAccount(b.account);
}

/**
 * Saldo inicial que hay que guardar para que la cuenta muestre `desired` al final del mes `asOf`.
 * Es como se "corrige" un saldo a mano: los movimientos no se tocan, se ajusta el punto de partida.
 */
export function openingFor(state: AppState, accountId: string, asOf: MonthKey, desired: number): number {
  const row = balances(state, asOf).accounts.find((a) => a.account.id === accountId);
  return row ? row.account.opening + ((desired || 0) - row.balance) : desired || 0;
}

// ── Tarjeta de crédito ───────────────────────────────────────────────────────

/**
 * Una tarjeta de crédito en un mes: un pago diferido. Lo que se carga a ella no toca ninguna cuenta ni el
 * presupuesto; solo el pago de la tarjeta lo hace. Todo en la moneda de la tarjeta (`cur`).
 *  total = previous + other + charged
 * El saldo de un mes que se arrastra al siguiente se deriva, nunca se guarda: es su `remainder`.
 */
export interface CardCalc {
  key: MonthKey;
  card: CreditCard;
  /** La moneda de la tarjeta: la de todos los importes de abajo. */
  cur: Currency;
  /** Lo que quedó sin pagar del mes registrado anterior más cercano (0 si no hay). Negativo si allí se pagó de más. */
  previous: number;
  /** "Otros cargos" escritos a mano en este mes. */
  other: number;
  /** Lo cargado en este mes: gastos fijos "en tarjeta" marcados + transacciones con tarjeta de crédito. */
  charged: number;
  /** previous + other + charged: lo que se debe a la tarjeta este mes (T). */
  total: number;
  /** Lo pagado este mes (P): la suma de los pagos; 0 si no hay. */
  paid: number;
  /** Los pagos del mes, cada uno con su cuenta y su fecha. */
  payments: CardPayment[];
  /** Lo que falta por pagar: total − paid. Sigue pendiente este mes y, si el mes se cierra así, pasa al siguiente. */
  remainder: number;
}

// El saldo de un mes depende del anterior: se calculan todos de una vez, en orden, y se memorizan por objeto de
// estado (que nunca se muta). Se calculan todas las tarjetas; quien suma elige las activas.
const cardMemo = new WeakMap<AppState, Map<MonthKey, Map<string, CardCalc>>>();

/** A qué tarjeta va un gasto fijo o una transacción: la suya, o la primera activa si no dice (null si no hay). */
export function chargedTo(state: AppState, cardId: string | null | undefined): string | null {
  return cardId ?? defaultCardId(state);
}

function cardTable(state: AppState): Map<MonthKey, Map<string, CardCalc>> {
  const hit = cardMemo.get(state);
  if (hit) return hit;
  const table = new Map<MonthKey, Map<string, CardCalc>>();
  const previous = new Map<string, number>();
  for (const key of sortedKeys(state)) {
    const m = state.months[key]!;
    const row = new Map<string, CardCalc>();
    for (const card of state.cards) {
      const cur = card.cur;
      // Un gasto fijo, con la última tasa del mes; una transacción, con la de su fecha (igual que en monthCalc).
      let charged = 0;
      for (const f of m.fixed) if (isCharged(f) && chargedTo(state, f.cardId) === card.id) charged += convert(state, key, f.amount, f.cur, cur);
      for (const t of m.tx) if (isCardTx(t) && chargedTo(state, t.cardId) === card.id) charged += convert(state, key, t.amount, t.cur, cur, t.date);
      const stored = cardOf(m, card.id);
      const prev = previous.get(card.id) ?? 0;
      const other = stored.other || 0;
      const total = prev + other + charged;
      const paid = stored.payments.reduce((a, p) => a + p.amount, 0);
      const remainder = total - paid;
      row.set(card.id, { key, card, cur, previous: prev, other, charged, total, paid, payments: stored.payments, remainder });
      previous.set(card.id, remainder);
    }
    table.set(key, row);
  }
  cardMemo.set(state, table);
  return table;
}

/**
 * Cuenta que se ofrece para pagar la tarjeta `cardId` en el mes `key`: la del último pago de esa tarjeta (de este mes o
 * del anterior más cercano que tenga uno) si sigue siendo una cuenta de dinero visible; si no, la cuenta por defecto.
 * null si el usuario no tiene ninguna cuenta de dinero.
 */
export function cardAccountFor(state: AppState, key: MonthKey, cardId: string): MoneyAccount | null {
  const usable = new Map(moneyAccounts(state).map((a) => [a.id, a]));
  for (const k of sortedKeys(state).filter((k) => k <= key).reverse()) {
    const payments = state.months[k]!.cards?.find((c) => c.cardId === cardId)?.payments ?? [];
    for (const p of [...payments].reverse()) if (usable.has(p.accountId)) return usable.get(p.accountId)!;
  }
  return defaultAccount(state);
}

/** Una tarjeta de crédito (activa o no) en el mes `key` (que tiene que estar registrado). */
export function cardCalc(state: AppState, key: MonthKey, cardId: string): CardCalc {
  const month = cardTable(state).get(key);
  if (!month) throw new Error(`Month not found: ${key}`);
  const hit = month.get(cardId);
  if (!hit) throw new Error(`Credit card not found: ${cardId}`);
  return hit;
}

/** Las tarjetas ACTIVAS en el mes `key`, en su orden: lo único que suma a los totales del mes. */
export function cardCalcs(state: AppState, key: MonthKey): CardCalc[] {
  const month = cardTable(state).get(key);
  if (!month) throw new Error(`Month not found: ${key}`);
  return activeCards(state).map((c) => month.get(c.id)!);
}

// ── Tarjeta de crédito: aviso de uso y fechas ────────────────────────────────

/** Uso del límite (0–∞, 0.1 = 10 %) de lo que se debe; null si la tarjeta no tiene límite. Lo que se pagó de más cuenta 0. */
export function cardUtilization(card: Pick<CreditCard, 'limit'>, remainder: number): number | null {
  return card.limit ? Math.max(0, remainder) / card.limit : null;
}

export interface CardHint {
  /** remainder / límite. */
  utilization: number;
  /** Lo que hay que pagar antes del corte para que el saldo del corte quede por debajo del 10 % del límite; 0 si ya lo está. */
  payToUnder10: number;
  nextCutoff: ISODate;
  daysToCutoff: number;
  /** El primer vencimiento después del corte más reciente; null si la tarjeta no tiene día de pago. */
  nextDue: ISODate | null;
  /** Días de `today` al vencimiento: negativo si ya pasó sin pagarse. */
  daysToDue: number | null;
  /**
   * El vencimiento que conviene enseñar: `nextDue` mientras no haya pasado; si ya pasó (el estado del corte anterior),
   * el del corte que viene, que es el que se puede todavía cumplir. null si no hay día de pago.
   */
  upcomingDue: { date: ISODate; days: number } | null;
}

const DAY_MS = 86_400_000;
const utcMs = (date: ISODate) => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (from: ISODate, to: ISODate) => Math.round((utcMs(to) - utcMs(from)) / DAY_MS);

/** La fecha del día `day` (1–31) de ese año y mes, recortada al largo del mes (el 31 en abril → 30). */
function clampedDate(year: number, month: number, day: number): ISODate {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** El mismo día `day` en el mes `offset` meses después (o antes) del de `date`. */
function dateInMonth(date: ISODate, offset: number, day: number): ISODate {
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7) - 1 + offset;
  return clampedDate(y + Math.floor(m / 12), (((m % 12) + 12) % 12) + 1, day);
}

/**
 * El aviso "paga para quedar por debajo del 10 %" de una tarjeta, a la fecha `today`. `remainder` es lo que se debe
 * ahora, en la moneda de la tarjeta (el del último mes). null si falta el límite o el día de corte: sin ellos no
 * hay aviso. payToUnder10 = max(0, remainder − 10 % del límite) + 0.01, redondeado a centavos.
 */
export function cardHint(card: Pick<CreditCard, 'limit' | 'cutoffDay' | 'dueDay'>, remainder: number, today: ISODate): CardHint | null {
  if (!card.limit || !card.cutoffDay) return null;
  const owed = Math.max(0, remainder);
  const tenth = 0.1 * card.limit;
  const payToUnder10 = owed < tenth ? 0 : Math.round((owed - tenth + 0.01) * 100) / 100;

  const thisCutoff = dateInMonth(today, 0, card.cutoffDay);
  // Corte más reciente (hoy cuenta) y próximo (hoy cuenta).
  const lastCutoff = thisCutoff <= today ? thisCutoff : dateInMonth(today, -1, card.cutoffDay);
  const nextCutoff = thisCutoff >= today ? thisCutoff : dateInMonth(today, 1, card.cutoffDay);

  let nextDue: ISODate | null = null;
  if (card.dueDay) {
    const sameMonth = dateInMonth(lastCutoff, 0, card.dueDay);
    nextDue = sameMonth > lastCutoff ? sameMonth : dateInMonth(lastCutoff, 1, card.dueDay);
  }
  const daysToDue = nextDue ? daysBetween(today, nextDue) : null;
  let upcomingDue: CardHint['upcomingDue'] = nextDue && daysToDue !== null ? { date: nextDue, days: daysToDue } : null;
  if (card.dueDay && nextDue && daysToDue! < 0) {
    // El estado del corte anterior ya venció: el pago que aún se puede cumplir es el del corte que viene.
    const after = dateInMonth(nextCutoff, 0, card.dueDay);
    const date = after > nextCutoff ? after : dateInMonth(nextCutoff, 1, card.dueDay);
    upcomingDue = { date, days: daysBetween(today, date) };
  }
  return { utilization: owed / card.limit, payToUnder10, nextCutoff, daysToCutoff: daysBetween(today, nextCutoff), nextDue, daysToDue, upcomingDue };
}

/**
 * Una tarjeta solo se puede apagar si en el último mes no debe nada y no tiene nada cargado: apagarla con deuda la
 * sacaría de los totales sin que se haya pagado. Sin meses, se puede.
 */
export function cardOffBlocked(state: AppState, cardId: string): boolean {
  const last = sortedKeys(state).at(-1);
  if (!last) return false;
  const c = cardCalc(state, last, cardId);
  return Math.abs(c.remainder) > 0.005 || Math.abs(c.charged) > 0.005;
}

// ── El mes ───────────────────────────────────────────────────────────────────

export interface CategorySum {
  name: string;
  /** En la moneda principal. */
  value: number;
  /** true solo para la fila de gastos fijos. */
  fixed: boolean;
}

/** Nombre canónico de la fila de gastos fijos; en pantalla se traduce (shared/i18n.ts FIXED_CATEGORY_NAMES). */
export const FIXED_CATEGORY = 'Fixed expenses';

export interface BudgetPart {
  account: MoneyAccount;
  /** Parte del presupuesto que sale de esta cuenta, en su moneda: fromLog + fromIncomes + fromTransfers. Puede ser negativa. */
  amount: number;
  /** Lo que viene del registro del presupuesto (Month.budgetLog): es lo que se edita con PATCH { budgets }. */
  fromLog: number;
  /** Lo que suman los ingresos del mes con `budget: true` que entran a esta cuenta, en su moneda. */
  fromIncomes: number;
  /**
   * El neto de los envíos del mes con `budget: true`, en su moneda: lo recibido de los que llegan a esta cuenta
   * menos lo enviado por los que salen de ella. Negativo si de ella sale más presupuesto del que le llega.
   */
  fromTransfers: number;
  /** `amount` en la moneda principal, con la última tasa del mes. */
  inMain: number;
}

/** Todas las cifras son en la moneda principal (`main`) salvo las que terminan en Second. */
export interface MonthCalc {
  key: MonthKey;
  closed: boolean;
  main: Currency;
  /** null = sin segunda moneda: no hay cifras en ella (usedSecond, budgetSecond y rate son null). */
  second: Currency | null;
  /** 1 segunda = rate principal, con las tasas del mes: el "1 USD = 58.76 DOP" de la barra superior. null sin segunda. */
  rate: RateInfo | null;

  /**
   * Σ de los fijos, sin los cargados a la tarjeta (no salen del presupuesto: entran a la fila de la tarjeta), más
   * esa fila: su total si está sin pagar o lo pagado si se pagó (el resto pasa al mes siguiente).
   */
  fixedAll: number;
  /** Σ de los fijos pagados desde una cuenta, más lo pagado de la tarjeta. */
  fixedPaid: number;
  /** Σ de los fijos no pagados, más el total de la tarjeta mientras no se pague. */
  pending: number;
  paidCount: number;
  fixedCount: number;

  /**
   * Σ de las transacciones, contando como tales las comisiones de los envíos (transferFees). Sin las hechas con
   * tarjeta de crédito: esas entran a la fila de la tarjeta y cuentan cuando se paga.
   */
  varSpent: number;
  /** Cuántas son: las transacciones más las comisiones. */
  txCount: number;

  /** fijosPagados + transacciones */
  used: number;
  usedSecond: number | null;
  /** Presupuesto del mes: Σ de las partes por cuenta (registro + ingresos que lo suben + envíos que lo mueven). */
  budget: number;
  budgetSecond: number | null;
  /** Una fila por cuenta visible (y por cualquier cuenta oculta que tenga parte o que toque un envío con `budget`), en el orden de las cuentas. */
  budgetParts: BudgetPart[];
  /** presupuesto − usado */
  avail: number;
  /** disponible − pendientes */
  after: number;
  /** max(0, after): el segmento "Free" de la dona. */
  free: number;
  /** usado / presupuesto × 100 (0 si no hay presupuesto). */
  pctUsed: number;

  /** Σ de los ingresos con fecha en este mes. */
  income: number;
  /** ingreso − usado */
  incomeLeft: number;
  /** Σ de los aportes a metas con fecha en este mes. */
  saved: number;

  /** Las tarjetas de crédito ACTIVAS de este mes, en su orden (vacío si no hay ninguna). Cada una en su moneda. */
  cards: CardCalc[];

  /** La fila de gastos fijos (pagados) + cada categoría con gasto, de mayor a menor. Solo valores > 0. */
  categories: CategorySum[];
  /** Mayor valor de `categories` (mínimo 1), para escalar las barras. */
  catMax: number;
}

/** Un ingreso de dinero (no gramos de oro). */
export type MoneyIncome = Income & { cur: Currency };

export function isMoneyIncome(income: Income): income is MoneyIncome {
  return !isGold(income.cur);
}

/**
 * Ingresos con fecha en ese mes, sumados en `to`, cada uno con la tasa vigente en su fecha. Los gramos que entran
 * a una cuenta de oro no cuentan: no son dinero cobrado, y valorarlos con el precio de hoy cambiaría el ingreso
 * de meses pasados cada vez que se corrige el precio.
 */
export function incomeInMonth(state: AppState, key: MonthKey, to: Currency = state.mainCurrency): number {
  return state.incomes
    .filter(isMoneyIncome)
    .filter((i) => monthOf(i.date) === key)
    .reduce((a, i) => a + convertRow(state, i.date, i.amount, i.cur, to, i.rate), 0);
}

/** Aportes a metas con fecha en ese mes, sumados en `to`, cada uno con la tasa vigente en su fecha. */
export function savedInMonth(state: AppState, key: MonthKey, to: Currency = state.mainCurrency): number {
  return state.contribs
    .filter((c) => monthOf(c.date) === key)
    .reduce((a, c) => a + contribIn(state, c, to), 0);
}

// ── Presupuesto ──────────────────────────────────────────────────────────────

/**
 * Quita el ruido de la coma flotante de una suma de montos (0.1 + 0.2 → 0.3) sin recortar los decimales de un
 * monto que sale de convertir (el sobrante llevado a otra moneda).
 */
const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * Month.budgets a partir de Month.budgetLog: accountId → suma de sus movimientos, en la moneda de la cuenta.
 * Las cuentas que suman 0 no aparecen. No incluye los ingresos ni los envíos que suben el presupuesto.
 */
export function budgetsFromLog(log: readonly Pick<BudgetEntry, 'accountId' | 'amount'>[]): Record<string, number> {
  const sum = new Map<string, number>();
  for (const e of log) sum.set(e.accountId, (sum.get(e.accountId) ?? 0) + (e.amount || 0));
  const out: Record<string, number> = {};
  for (const [accountId, amount] of sum) if (tidy(amount) !== 0) out[accountId] = tidy(amount);
  return out;
}

/** Los ingresos que suben el presupuesto de ese mes: los de `budget: true` con fecha en él. */
export function budgetIncomes(state: AppState, key: MonthKey): MoneyIncome[] {
  return state.incomes.filter(isMoneyIncome).filter((i) => i.budget && monthOf(i.date) === key);
}

/** Lo que un ingreso con `budget: true` le suma a la parte de `account`: su monto en la moneda de la cuenta, a la tasa de su fecha. */
function incomeInAccount(state: AppState, income: MoneyIncome, account: MoneyAccount): number {
  return convertOn(state, income.date, income.amount, income.cur, account.currency);
}

/**
 * Los envíos que mueven presupuesto en ese mes: los de `budget: true` de su hoja (Transfer.monthKey, no el
 * mes de su fecha: un envío pertenece a un mes, a diferencia de un ingreso).
 */
export function budgetTransfers(state: AppState, key: MonthKey): Transfer[] {
  return (state.months[key]?.transfers ?? []).filter((t) => t.budget);
}

/**
 * El neto que esos envíos dejan en la parte de una cuenta, en su moneda: un envío con `budget: true` MUEVE
 * presupuesto, no lo crea. A la parte de la cuenta de destino le suma lo recibido (monto × tasa) y a la de origen
 * le resta lo enviado (monto). Sumarlo solo en el destino contaba dos veces el dinero: el sueldo presupuestado
 * en la cuenta de origen y, otra vez, lo que de él se enviaba.
 */
function transfersInAccount(moving: readonly Transfer[], accountId: string): number {
  let net = 0;
  for (const t of moving) {
    if (t.toAccountId === accountId) net += transferReceived(t);
    if (t.fromAccountId === accountId) net -= t.amount || 0;
  }
  return net;
}

/**
 * Lo que los ingresos y los envíos con `budget: true` le ponen a la parte de una cuenta en ese mes, en la moneda
 * de la cuenta: lo que el cálculo pone encima del registro (los ingresos suman; los envíos, su neto, que es
 * negativo en la cuenta de la que sale más de lo que le llega). Quien fija una parte "en total" se lo resta para
 * saber cuánto tiene que sumar el registro (0 si la cuenta no existe o el mes no está registrado).
 */
export function budgetRaised(state: AppState, key: MonthKey, accountId: string): number {
  const account = accountsById(state).get(accountId);
  if (!account || !isMoneyAccount(account) || !state.months[key]) return 0;
  const incomes = budgetIncomes(state, key)
    .filter((i) => i.accountId === accountId)
    .reduce((a, i) => a + incomeInAccount(state, i, account), 0);
  return incomes + transfersInAccount(budgetTransfers(state, key), accountId);
}

export interface BudgetHistoryRow {
  /** Los tres tipos del registro, 'income' (un ingreso con `budget: true`) o 'transfer' (un envío con `budget: true`). */
  kind: BudgetEntryKind | 'income' | 'transfer';
  /** Id del BudgetEntry o, si kind es 'income' o 'transfer', del ingreso o del envío. */
  id: string;
  /**
   * Solo en un envío, que sale en dos filas con el mismo id: 'out' la de la cuenta de origen (resta lo enviado) e
   * 'in' la de la de destino (suma lo recibido).
   */
  side?: 'out' | 'in';
  date: ISODate;
  /** La cuenta del movimiento o del ingreso; en un envío, la de origen o la de destino según `side`. */
  account: MoneyAccount;
  /**
   * En la moneda de la cuenta (un ingreso en otra moneda, ya convertido a la tasa de su fecha; de un envío, lo
   * enviado en negativo o lo recibido: monto × tasa). Puede ser negativo.
   */
  amount: number;
  /** La nota del movimiento, la descripción del ingreso o la vía del envío. */
  note: string;
  /** `amount` en la moneda principal, con la última tasa del mes. */
  inMain: number;
  /** Presupuesto acumulado hasta esta fila incluida, en la moneda principal. El de la última fila es monthCalc().budget. */
  total: number;
}

/**
 * La historia del presupuesto del mes en una sola lista cronológica: los movimientos del registro, los ingresos
 * que lo suben y los envíos que lo mueven, con el total acumulado en la moneda principal. Con la misma fecha van
 * primero los movimientos del registro, en su orden, después los ingresos y después los envíos. Un envío sale en
 * dos filas seguidas: lo que resta a la cuenta de origen y lo que suma a la de destino (si la tasa del envío es
 * la del mes, el total vuelve a donde estaba). Lo de una cuenta que ya no existe no sale (tampoco cuenta en
 * monthCalc). Un mes sin registrar da una lista vacía.
 */
export function budgetHistory(state: AppState, key: MonthKey): BudgetHistoryRow[] {
  const m = state.months[key];
  if (!m) return [];
  // El presupuesto es dinero: lo de una cuenta de oro no cuenta (la API no deja escribirlo).
  const byId = new Map(state.accounts.filter(isMoneyAccount).map((a) => [a.id, a]));
  const rows: Omit<BudgetHistoryRow, 'inMain' | 'total'>[] = [];
  for (const e of m.budgetLog) {
    const account = byId.get(e.accountId);
    if (account) rows.push({ kind: e.kind, id: e.id, date: e.date, account, amount: e.amount || 0, note: e.note });
  }
  for (const i of budgetIncomes(state, key)) {
    const account = byId.get(i.accountId);
    if (account) rows.push({ kind: 'income', id: i.id, date: i.date, account, amount: incomeInAccount(state, i, account), note: i.desc });
  }
  for (const t of budgetTransfers(state, key)) {
    const from = byId.get(t.fromAccountId);
    const to = byId.get(t.toAccountId);
    if (from) rows.push({ kind: 'transfer', id: t.id, side: 'out', date: t.date, account: from, amount: -(t.amount || 0), note: t.via });
    if (to) rows.push({ kind: 'transfer', id: t.id, side: 'in', date: t.date, account: to, amount: transferReceived(t), note: t.via });
  }
  // Orden estable: con la misma fecha se conserva el de arriba.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let total = 0;
  return rows.map((r) => {
    const inMain = convert(state, key, r.amount, r.account.currency, state.mainCurrency);
    total += inMain;
    return { ...r, inMain, total };
  });
}

export interface Leftover {
  /** El mes registrado anterior más cercano a `key`; null si no hay ninguno. */
  previousKey: MonthKey | null;
  /** Lo que sobró en ese mes: su `avail` (presupuesto − usado), en la moneda principal. Puede ser negativo. null sin mes anterior. */
  leftover: number | null;
  /** true si el mes `key` ya tiene un movimiento 'leftover' en su registro: el sobrante ya se sumó. */
  added: boolean;
}

/** El sobrante del mes anterior a `key` y si `key` ya lo tiene sumado a su presupuesto. */
export function leftoverFor(state: AppState, key: MonthKey): Leftover {
  const previousKey =
    sortedKeys(state)
      .filter((k) => k < key)
      .at(-1) ?? null;
  return {
    previousKey,
    leftover: previousKey === null ? null : monthCalc(state, previousKey).avail,
    added: state.months[key]?.budgetLog.some((e) => e.kind === 'leftover') ?? false,
  };
}

export function monthCalc(state: AppState, key: MonthKey): MonthCalc {
  const m = state.months[key];
  if (!m) throw new Error(`Month not found: ${key}`);
  const main = state.mainCurrency;
  const second = state.secondCurrency;
  const toMain = (amount: number, cur: Currency) => convert(state, key, amount, cur, main);

  const cards = cardCalcs(state, key);
  let fixedAll = 0;
  let fixedPaid = 0;
  let paidCount = 0;
  // Lo comprado en fijos cargados a la tarjeta: sale de "usado" (lo paga la tarjeta) pero sigue siendo gasto fijo
  // en el desglose por categoría, que describe en qué se gastó y no cuándo salió el dinero.
  let fixedCharged = 0;
  for (const f of m.fixed) {
    const v = toMain(f.amount, f.cur);
    if (f.paid) paidCount++;
    if (isCharged(f)) {
      fixedCharged += v;
      continue;
    }
    fixedAll += v;
    if (f.paid) fixedPaid += v;
  }
  // La fila de la tarjeta: lo pagado cuenta como pagado y lo que falta sigue siendo un pendiente de este mes (puede
  // pagarse aún); si el mes se cierra así, pasa al siguiente por el saldo derivado (cardCalc.previous).
  let cardPaid = 0;
  for (const card of cards) {
    const inMain = (amount: number) => convert(state, key, amount, card.cur, main);
    fixedAll += inMain(card.payments.length ? card.paid + Math.max(card.remainder, 0) : card.total);
    fixedPaid += inMain(card.paid);
    cardPaid += inMain(card.paid);
  }
  const pending = fixedAll - fixedPaid;

  let varSpent = 0;
  const byCat = new Map<string, number>();
  for (const t of m.tx) {
    // Cada transacción, con la tasa vigente en su fecha.
    const v = convert(state, key, t.amount, t.cur, main, t.date);
    // Con tarjeta de crédito no cuenta como usada (la tarjeta lo hace al pagarse), pero sí por categoría.
    if (!isCardTx(t)) varSpent += v;
    byCat.set(t.cat, (byCat.get(t.cat) ?? 0) + v);
  }
  // La comisión de un envío es un gasto más del mes: cuenta como una transacción en la moneda de la cuenta de
  // origen, con la tasa vigente en la fecha del envío.
  const fees = transferFees(state, key);
  for (const fee of fees) {
    const v = convert(state, key, fee.amount, fee.cur, main, fee.date);
    varSpent += v;
    byCat.set(FEE_CATEGORY, (byCat.get(FEE_CATEGORY) ?? 0) + v);
  }

  // El registro es la fuente de verdad (no Month.budgets, que es su suma ya hecha).
  const fromLog = budgetsFromLog(m.budgetLog);
  const raising = budgetIncomes(state, key);
  const moving = budgetTransfers(state, key);
  const budgetParts: BudgetPart[] = state.accounts
    .filter(isMoneyAccount)
    .sort((a, b) => a.sort - b.sort)
    .map((account) => {
      const log = fromLog[account.id] ?? 0;
      const incomes = raising.filter((i) => i.accountId === account.id).reduce((a, i) => a + incomeInAccount(state, i, account), 0);
      const transfers = transfersInAccount(moving, account.id);
      const amount = log + incomes + transfers;
      return { account, amount, fromLog: log, fromIncomes: incomes, fromTransfers: transfers, inMain: toMain(amount, account.currency) };
    })
    .filter((p) => !p.account.hidden || p.amount !== 0 || p.fromLog !== 0 || p.fromTransfers !== 0);
  const budget = budgetParts.reduce((a, p) => a + p.inMain, 0);

  const used = fixedPaid + varSpent;
  const avail = budget - used;
  const after = avail - pending;
  const income = incomeInMonth(state, key);
  const rate = second ? rateFor(state, key, second, main) : null;

  const catSums: CategorySum[] = [...byCat]
    .map(([name, value]) => ({ name, value, fixed: false }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  // «Fixed expenses» = lo pagado en fijos desde una cuenta + lo cargado a la tarjeta; el pago de la tarjeta no es
  // una categoría (lo que contiene ya está repartido en ellas).
  const categories = [{ name: FIXED_CATEGORY, value: fixedPaid - cardPaid + fixedCharged, fixed: true }, ...catSums].filter((c) => c.value > 0);

  return {
    key,
    closed: m.closed,
    main,
    second,
    rate,
    fixedAll,
    fixedPaid,
    pending,
    paidCount,
    fixedCount: m.fixed.length,
    varSpent,
    txCount: m.tx.length + fees.length,
    cards,
    used,
    usedSecond: second ? convert(state, key, used, main, second) : null,
    budget,
    budgetSecond: second ? convert(state, key, budget, main, second) : null,
    budgetParts,
    avail,
    after,
    free: Math.max(0, after),
    pctUsed: budget ? (used / budget) * 100 : 0,
    income,
    incomeLeft: income - used,
    saved: savedInMonth(state, key),
    categories,
    catMax: Math.max(1, ...categories.map((c) => c.value)),
  };
}

/** Cuántos gastos fuera de presupuesto tiene el mes y cuánto suman, en la moneda principal (cada uno con la tasa de su fecha). */
export function outsideSummary(state: AppState, key: MonthKey): { count: number; total: number } {
  const m = state.months[key];
  const rows = m ? outsideOf(m) : [];
  const total = rows.reduce((a, o) => a + convert(state, key, o.amount, o.cur, state.mainCurrency, o.date), 0);
  return { count: rows.length, total };
}

export interface BudgetOverrun {
  account: MoneyAccount;
  /** Cuánto se pasa la parte, en la moneda de su cuenta (> 0). */
  over: number;
}

/**
 * Las partes del presupuesto que quedaron en negativo (p. ej. un envío con "Moves budget" sacó más de lo que la
 * cuenta tenía), con lo que se pasan. Solo lee `amount`: no calcula nada nuevo.
 */
export function budgetOverruns(parts: readonly BudgetPart[]): BudgetOverrun[] {
  return parts.filter((p) => p.amount < 0).map((p) => ({ account: p.account, over: -p.amount }));
}

// ── Donas ────────────────────────────────────────────────────────────────────

export const DONUT = { size: 168, r: 64, stroke: 20 } as const;

export interface DonutSegment {
  /** stroke-dasharray: "<largo> <circunferencia>" */
  dash: string;
  /** stroke-dashoffset */
  offset: number;
}

/**
 * Segmentos encadenados de una dona: cada valor ocupa su parte de `scale` (por defecto, la suma).
 * Los valores negativos o no finitos no ocupan nada.
 */
export function ring(values: readonly number[], scale?: number): DonutSegment[] {
  const circ = 2 * Math.PI * DONUT.r;
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = Math.max(scale ?? clean.reduce((a, v) => a + v, 0), 1);
  let acc = 0;
  return clean.map((v) => {
    const len = (v / total) * circ;
    const s = { dash: `${len} ${circ}`, offset: -acc };
    acc += len;
    return s;
  });
}

/**
 * Dona del presupuesto, en el orden en que se acumulan: fijos pagados, transacciones, fijos pendientes.
 * Escala = max(presupuesto, usado + pendientes): si se pasa del presupuesto, la dona completa es el total.
 */
export function donut(
  c: Pick<MonthCalc, 'budget' | 'used' | 'pending' | 'fixedPaid' | 'varSpent'>,
): { fixed: DonutSegment; variable: DonutSegment; pending: DonutSegment } {
  const [fixed, variable, pending] = ring([c.fixedPaid, c.varSpent, c.pending], Math.max(c.budget, c.used + c.pending, 1));
  return { fixed: fixed!, variable: variable!, pending: pending! };
}

// ── Ahorros ──────────────────────────────────────────────────────────────────

/**
 * Aporte expresado en `to` (la moneda de su meta se pasa aparte), con la tasa vigente en su fecha o, hacia la
 * moneda principal, con la propia del aporte si la tiene (convertRow).
 */
export function contribIn(state: AppState, c: Pick<Contribution, 'amount' | 'cur' | 'date'> & { rate?: number | null }, to: Currency): number {
  return convertRow(state, c.date, c.amount, c.cur, to, c.rate);
}

/** Un ingreso (de dinero) expresado en `to`: igual que contribIn, con la tasa propia hacia la principal. */
export function incomeIn(state: AppState, i: Pick<Income, 'amount' | 'date'> & { cur: Currency; rate?: number | null }, to: Currency): number {
  return convertRow(state, i.date, i.amount, i.cur, to, i.rate);
}

export interface GoalTarget {
  /** Ahorro mensual planeado, en la moneda de la meta. */
  monthly: number;
  /** meses del plan × ahorro mensual */
  targetAmount: number;
  /** 0..100 */
  pct: number;
  end: MonthKey;
  /** Aportes que faltan hasta `end` (mínimo 1; no cuenta el mes en curso si ya se aportó). */
  left: number;
  /** Lo que hay que aportar por mes para llegar, en la moneda de la meta. */
  needPerMonth: number;
}

export interface GoalProgress {
  id: string;
  name: string;
  /** Moneda de la meta. `saved` y `target` van en ella. */
  cur: Currency;
  saved: number;
  /** Lo ahorrado en la moneda principal, a la última tasa del mes en curso. Es lo que suma totalSaved. */
  savedMain: number;
  /** Moneda de la línea "≈" de la meta: Goal.approxCur o, si es null, la moneda principal. */
  approxCur: Currency;
  /** Lo ahorrado en `approxCur`, a la última tasa del mes en curso. Si approxCur es la principal, igual a savedMain. */
  savedApprox: number;
  contribCount: number;
  /** null = meta de aportes variables. */
  target: GoalTarget | null;
}

export function goalProgress(state: AppState, goal: Goal): GoalProgress {
  const cur = currentKey(state);
  const mine = state.contribs.filter((c) => c.goalId === goal.id);
  const saved = mine.reduce((a, c) => a + contribIn(state, c, goal.cur), 0);
  const approxCur = goal.approxCur ?? state.mainCurrency;
  // Aportes con tasa propia en una meta que NO está en la principal: `saved` los cuenta como siempre (moneda del
  // aporte → moneda de la meta, tasa de su fecha), pero su valor en la principal es el que fijó el usuario y no
  // se recalcula con la tasa del mes en curso. Los demás siguen por `saved` convertido a la tasa de hoy. Con la
  // meta en la principal contribIn ya aplicó la tasa propia, y sin tasas propias esto es igual que antes.
  const fixed = goal.cur === state.mainCurrency ? [] : mine.filter((c) => ownRate(state, c));
  const fixedMain = fixed.reduce((a, c) => a + c.amount * ownRate(state, c)!, 0);
  const fixedSaved = fixed.reduce((a, c) => a + contribIn(state, c, goal.cur), 0);
  // Sin ningún mes no hay con qué convertir: queda la cifra tal cual, como siempre.
  const inCur = (to: Currency) => {
    if (!cur) return saved;
    const rest = convert(state, cur, saved - fixedSaved, goal.cur, to);
    return fixed.length ? rest + convert(state, cur, fixedMain, state.mainCurrency, to) : rest;
  };
  const base = {
    id: goal.id,
    name: goal.name,
    cur: goal.cur,
    saved,
    savedMain: inCur(state.mainCurrency),
    approxCur,
    savedApprox: inCur(approxCur),
    contribCount: mine.length,
  };
  if (!goal.monthly || !goal.start || !goal.end) return { ...base, target: null };

  const targetAmount = monthSpan(goal.start, goal.end) * goal.monthly;
  const from = cur ?? goal.start;
  const doneThis = mine.some((c) => monthOf(c.date) === from);
  const left = Math.max(1, monthSpan(from, goal.end) - (doneThis ? 1 : 0));
  return {
    ...base,
    target: {
      monthly: goal.monthly,
      targetAmount,
      pct: targetAmount > 0 ? Math.min(100, (saved / targetAmount) * 100) : 0,
      end: goal.end,
      left,
      needPerMonth: Math.max(0, targetAmount - saved) / left,
    },
  };
}

export function goalsProgress(state: AppState): GoalProgress[] {
  return [...state.goals].sort((a, b) => a.sort - b.sort).map((g) => goalProgress(state, g));
}

/** Todo lo ahorrado en todas las metas, en la moneda principal, a la tasa del mes en curso. */
export function totalSaved(state: AppState): number {
  return goalsProgress(state).reduce((a, g) => a + g.savedMain, 0);
}

export interface IncomeRow {
  key: MonthKey;
  /** Ingresos del mes, en la moneda principal. */
  income: number;
  /** Aportes del mes, en la moneda principal. */
  saved: number;
  /** ahorrado / ingreso × 100; null si no hubo ingreso. */
  pct: number | null;
  /** 1 segunda = rate principal en ese mes; null sin segunda moneda. */
  rate: RateInfo | null;
}

/** Una fila por mes registrado: lo que entró, lo que se apartó y qué porcentaje es. */
export function incomeRows(state: AppState): IncomeRow[] {
  return sortedKeys(state).map((key) => {
    const income = incomeInMonth(state, key);
    const saved = savedInMonth(state, key);
    return {
      key,
      income,
      saved,
      pct: income ? (saved / income) * 100 : null,
      rate: state.secondCurrency ? rateFor(state, key, state.secondCurrency, state.mainCurrency) : null,
    };
  });
}

/** Ingresos ordenados del más reciente al más antiguo (estable). */
export function sortedIncomes(state: AppState): Income[] {
  return [...state.incomes].sort((a, b) => b.date.localeCompare(a.date));
}
