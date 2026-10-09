// Lo que las pantallas leen ya calculado. Se arma una vez por cambio de estado, siempre con shared/calc.ts: aquí
// no hay cuentas propias, solo se junta lo que cada pantalla pediría por su lado (saldos, tasas, conversiones).
// Funciones puras: sirven igual en el proveedor que en una prueba o en el modelo de una pantalla.

import { balances, convert, defaultAccount, leftoverFor, moneyAccounts, monthCalc, rateFor, visibleAccounts } from '../../shared/calc';
import type { RateInfo } from '../../shared/calc';
import { CURRENCIES } from '../../shared/constants';
import { monthOf } from '../../shared/month';
import type { Account, AppState, AppUser, Currency, ISODate, MonthKey } from '../../shared/types';
import type { Actions, Finanzas } from './context';
import { latestKey } from './reducers';

/** Un importe en las dos monedas del usuario. */
export interface Money {
  /** En la moneda principal. */
  main: number;
  /** En la segunda moneda; null si el usuario no tiene segunda moneda. */
  second: number | null;
}

/**
 * `amount` de `cur` en la moneda principal y en la segunda, con las tasas del mes `key`: la última del mes o, con
 * `date` (una fila con fecha propia), la vigente ese día.
 */
export function inBoth(state: AppState, key: MonthKey, amount: number, cur: Currency, date?: ISODate): Money {
  return {
    main: convert(state, key, amount, cur, state.mainCurrency, date),
    second: state.secondCurrency ? convert(state, key, amount, cur, state.secondCurrency, date) : null,
  };
}

/** La tasa de un par en un mes, ya resuelta: 1 `from` = `rate` `to`, con su origen (RateInfo.source). */
export interface PairRate extends RateInfo {
  from: Currency;
  to: Currency;
}

/**
 * Las tasas del mes, una por cada par de monedas: la vigente al final del mes, con su origen. El par de la barra
 * superior (segunda → principal) va primero. Sentido de cada fila: el que el usuario escribió si la tasa es una
 * escrita en este mes (source === 'month'); si no, el que da un número >= 1 ("1 USD = 58.76 DOP" y no
 * "1 DOP = 0.017 USD"). Las demás tasas escritas del par en el mes (una por fecha) salen de Month.rates.
 */
export function pairRates(state: AppState, key: MonthKey): PairRate[] {
  const typed = state.months[key]?.rates ?? [];
  const pairs = CURRENCIES.flatMap((a, i) => CURRENCIES.slice(i + 1).map((b): [Currency, Currency] => [a, b]));
  const isBar = ([a, b]: [Currency, Currency]) => !!state.secondCurrency && [a, b].includes(state.mainCurrency) && [a, b].includes(state.secondCurrency);
  pairs.sort((x, y) => Number(isBar(y)) - Number(isBar(x)));

  return pairs.map(([a, b]) => {
    const forward = rateFor(state, key, a, b);
    // La escrita que está vigente: la de la fecha que dice rateFor (con la misma fecha vale la última).
    const written =
      forward.source === 'month'
        ? typed.findLast((r) => r.rate > 0 && r.date === forward.date && ((r.from === a && r.to === b) || (r.from === b && r.to === a)))
        : undefined;
    const [from, to] = written ? [written.from, written.to] : forward.rate >= 1 ? [a, b] : [b, a];
    return { from, to, ...(from === a ? forward : rateFor(state, key, from, to)) };
  });
}

/**
 * Las monedas que el usuario usa de verdad en este mes: la principal, la segunda (si hay), las de sus cuentas
 * visibles y las de los gastos del mes (un gasto en liras sin cuenta en liras también se convierte). En el orden de siempre.
 */
export function usedCurrencies(
  main: Currency,
  second: Currency | null,
  visible: readonly { currency: Currency }[],
  month: { fixed: readonly { cur: Currency }[]; tx: readonly { cur: Currency }[] },
): Currency[] {
  const used = new Set<Currency>([main, ...(second ? [second] : []), ...visible.map((a) => a.currency), ...month.fixed.map((f) => f.cur), ...month.tx.map((t) => t.cur)]);
  return CURRENCIES.filter((c) => used.has(c));
}

/**
 * Las tasas que hacen falta de verdad: con k monedas en uso, k-1 pares, cada moneda contra la principal. El par
 * que queda entre dos monedas que no son la principal sale cruzando por ella (calc.rateFor), no se pide.
 * Además, cualquier tasa escrita para este mes (si está escrita se tiene que poder ver, corregir y quitar).
 * Conserva el orden de `rates`.
 */
export function shownRates(rates: readonly PairRate[], used: readonly Currency[], main: Currency): PairRate[] {
  return rates.filter((r) => r.source === 'month' || ((r.from === main || r.to === main) && used.includes(r.from) && used.includes(r.to)));
}

/**
 * La tasa que enseña la barra superior: la de la segunda moneda contra la principal y, sin segunda, la primera tasa
 * que hace falta (null si ninguna: todo el dinero está en una moneda y no hay nada que enseñar).
 */
export function barRate(
  rates: readonly PairRate[],
  used: readonly Currency[],
  main: Currency,
  second: Currency | null,
  secondRate: RateInfo | null,
): PairRate | null {
  if (second && secondRate) return { from: second, to: main, ...secondRate };
  const needed = shownRates(rates, used, main);
  return needed.find((r) => r.source !== 'month') ?? needed[0] ?? null;
}

export interface AccountOption {
  /** Id de la cuenta. */
  value: string;
  /** Su nombre (lo escribe el usuario: no se traduce). */
  label: string;
}

function optionsOf(state: AppState, offered: readonly Account[], include: readonly (string | null | undefined)[]): AccountOption[] {
  const options = offered.map((a) => ({ value: a.id, label: a.name }));
  for (const id of include) {
    if (!id || options.some((o) => o.value === id)) continue;
    options.push({ value: id, label: state.accounts.find((a) => a.id === id)?.name ?? '—' });
  }
  return options;
}

/**
 * Opciones de un selector de cuenta para lo que es dinero (un gasto, un envío): las visibles que no son de oro,
 * en su orden, y detrás las de `include` que no estén entre ellas (la cuenta de una fila que después se ocultó
 * tiene que seguir viéndose con su nombre, no cambiarse sola por otra).
 */
export function accountOptions(state: AppState, ...include: (string | null | undefined)[]): AccountOption[] {
  return optionsOf(state, moneyAccounts(state), include);
}

/** Como accountOptions, con las cuentas de oro: un ingreso sí puede entrar a una (en gramos). */
export function incomeAccountOptions(state: AppState, ...include: (string | null | undefined)[]): AccountOption[] {
  return optionsOf(state, visibleAccounts(state), include);
}

export interface FinanzasInput {
  user: AppUser;
  state: AppState;
  monthKey: MonthKey;
  today: ISODate;
  actions: Actions;
}

/**
 * El valor de useFinanzas() para ese usuario, ese estado y ese mes; null si el mes no existe. Es lo que arma
 * FinanzasProvider en cada cambio; las pruebas lo usan para montar un componente con un estado fijo.
 */
export function buildFinanzas({ user, state, monthKey, today, actions }: FinanzasInput): Finanzas | null {
  const month = state.months[monthKey];
  if (!month) return null;
  const calc = monthCalc(state, monthKey);
  const rates = pairRates(state, monthKey);
  const money = moneyAccounts(state);
  return {
    user,
    state,
    monthKey,
    month,
    calc,
    rate: calc.rate,
    barRate: barRate(rates, usedCurrencies(calc.main, calc.second, money, month), calc.main, calc.second, calc.rate),
    main: calc.main,
    second: calc.second,
    accounts: [...state.accounts].sort((a, b) => a.sort - b.sort),
    visibleAccounts: money,
    defaultAccount: defaultAccount(state),
    accountOptions: (...include) => accountOptions(state, ...include),
    incomeAccountOptions: (...include) => incomeAccountOptions(state, ...include),
    balances: balances(state, monthKey),
    latestMonth: latestKey(state) === monthKey,
    inBoth: (amount, cur, key = monthKey, date) => inBoth(state, key, amount, cur, date),
    rates,
    rateOf: (from, to, key = monthKey, date) => rateFor(state, key, from, to, date),
    leftover: leftoverFor(state, monthKey),
    readOnly: month.closed,
    today,
    draftDate: monthOf(today) === monthKey ? today : `${monthKey}-01`,
    actions,
  };
}
