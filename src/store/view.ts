// What the screens read already computed. It is built once per state change, always with shared/calc.ts: there is
// no math of its own here; it only gathers what each screen would ask for separately (balances, rates, conversions).
// Pure functions: they work the same in the provider as in a test or in a screen's model.

import { balances, convert, defaultAccount, leftoverFor, moneyAccounts, monthCalc, outsideOf, rateFor, visibleAccounts } from '../../shared/calc';
import type { RateInfo } from '../../shared/calc';
import { CURRENCIES } from '../../shared/constants';
import { monthOf } from '../../shared/month';
import type { Account, AppState, AppUser, Currency, ISODate, MonthKey } from '../../shared/types';
import type { Actions, Finanzas } from './context';
import { latestKey } from './reducers';

/** An amount in the user's two currencies. */
export interface Money {
  /** In the main currency. */
  main: number;
  /** In the second currency; null if the user has no second currency. */
  second: number | null;
}

/**
 * `amount` of `cur` in the main currency and in the second one, with the rates of month `key`: the last of the month
 * or, with `date` (a row with its own date), the one in effect that day.
 */
export function inBoth(state: AppState, key: MonthKey, amount: number, cur: Currency, date?: ISODate): Money {
  return {
    main: convert(state, key, amount, cur, state.mainCurrency, date),
    second: state.secondCurrency ? convert(state, key, amount, cur, state.secondCurrency, date) : null,
  };
}

/** The rate of a pair in a month, already resolved: 1 `from` = `rate` `to`, with its source (RateInfo.source). */
export interface PairRate extends RateInfo {
  from: Currency;
  to: Currency;
}

/**
 * The month rates, one per currency pair: the one in effect at the end of the month, with its source. The top bar
 * pair (second → main) goes first. Direction of each row: the one the user typed if the rate is one typed in this
 * month (source === 'month'); otherwise, the one that gives a number >= 1 ("1 USD = 58.76 DOP" and not
 * "1 DOP = 0.017 USD"). The other typed rates of the pair in the month (one per date) come from Month.rates.
 */
export function pairRates(state: AppState, key: MonthKey): PairRate[] {
  const typed = state.months[key]?.rates ?? [];
  const pairs = CURRENCIES.flatMap((a, i) => CURRENCIES.slice(i + 1).map((b): [Currency, Currency] => [a, b]));
  const isBar = ([a, b]: [Currency, Currency]) => !!state.secondCurrency && [a, b].includes(state.mainCurrency) && [a, b].includes(state.secondCurrency);
  pairs.sort((x, y) => Number(isBar(y)) - Number(isBar(x)));

  return pairs.map(([a, b]) => {
    const forward = rateFor(state, key, a, b);
    // The typed one that is in effect: the one with the date rateFor reports (with the same date, the last one wins).
    const written =
      forward.source === 'month'
        ? typed.findLast((r) => r.rate > 0 && r.date === forward.date && ((r.from === a && r.to === b) || (r.from === b && r.to === a)))
        : undefined;
    const [from, to] = written ? [written.from, written.to] : forward.rate >= 1 ? [a, b] : [b, a];
    return { from, to, ...(from === a ? forward : rateFor(state, key, from, to)) };
  });
}

/** Ids of the accounts that some row names (income, transfer, expense, credit card payment, contribution, budget). */
function namedAccountIds(state: AppState): Set<string> {
  const named = new Set<string>();
  for (const i of state.incomes) named.add(i.accountId);
  for (const c of state.contribs) if (c.accountId) named.add(c.accountId);
  for (const m of Object.values(state.months)) {
    for (const f of m.fixed) named.add(f.accountId);
    for (const t of m.tx) named.add(t.accountId);
    for (const o of outsideOf(m)) named.add(o.accountId);
    for (const b of m.budgetLog) named.add(b.accountId);
    for (const t of m.transfers) named.add(t.fromAccountId).add(t.toAccountId);
    for (const c of m.cards ?? []) for (const p of c.payments) named.add(p.accountId);
  }
  return named;
}

/**
 * The visible money accounts that hold something: a nonzero balance in `key` or some row that names them
 * (income, transfer, expense, credit card payment, contribution, budget). An empty account with no movements does
 * not make its currency need a rate: there is no money in it yet.
 */
export function accountsInUse<T extends { id: string }>(state: AppState, key: MonthKey, visible: readonly T[]): T[] {
  const named = namedAccountIds(state);
  const nonZero = new Set(balances(state, key).accounts.filter((b) => b.balance !== 0).map((b) => b.account.id));
  return visible.filter((a) => named.has(a.id) || nonZero.has(a.id));
}

/**
 * Whether the user has anything to convert: money in some account (opening balance or movements) or any row (also a
 * goal contribution with no account). Without this, not even the second currency asks for a rate: there are no amounts.
 */
export function hasActivity(state: AppState, key: MonthKey): boolean {
  if (state.contribs.length > 0 || namedAccountIds(state).size > 0) return true;
  if (Object.values(state.months[key]?.budgets ?? {}).some((v) => v !== 0)) return true;
  return balances(state, key).accounts.some((b) => b.balance !== 0);
}

/**
 * The currencies the user really uses in this month: the main one, the second one (if any), those of their visible
 * accounts and those of the month's expenses (an expense in lira with no lira account is converted too). In the usual order.
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
 * The currencies that ask for a rate in month `key` of that state. With no activity there is nothing to convert: only
 * the main one, and not even the second currency is needed (a typed rate is shown anyway: shownRates).
 */
export function currenciesInUse(state: AppState, key: MonthKey): Currency[] {
  const month = state.months[key];
  if (!month || !hasActivity(state, key)) return [state.mainCurrency];
  return usedCurrencies(state.mainCurrency, state.secondCurrency, accountsInUse(state, key, moneyAccounts(state)), month);
}

/**
 * The rates that are really needed: with k currencies in use, k-1 pairs, each currency against the main one. The pair
 * left between two currencies that are not the main one comes from crossing through it (calc.rateFor); it is not asked for.
 * Plus any rate typed for this month (if it is typed, it must be possible to see, correct and remove it).
 * Keeps the order of `rates`.
 */
export function shownRates(rates: readonly PairRate[], used: readonly Currency[], main: Currency): PairRate[] {
  return rates.filter((r) => r.source === 'month' || ((r.from === main || r.to === main) && used.includes(r.from) && used.includes(r.to)));
}

/**
 * The rate the top bar shows: the second currency's against the main one and, with no second, the first rate
 * that is needed (null if none: all the money is in one currency and there is nothing to show).
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
  /** Id of the account. */
  value: string;
  /** Its name (the user types it: it is not translated). */
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
 * Options of an account select for what is money (an expense, a transfer): the visible ones that are not gold accounts,
 * in their order, followed by those in `include` that are not among them (a row's account that was later hidden must
 * still show with its name, not switch to another one by itself).
 */
export function accountOptions(state: AppState, ...include: (string | null | undefined)[]): AccountOption[] {
  return optionsOf(state, moneyAccounts(state), include);
}

/** Like accountOptions, with the gold accounts: an income can indeed go into one (in grams). */
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
 * The value of useFinanzas() for that user, that state and that month; null if the month does not exist. It is what
 * FinanzasProvider builds on every change; the tests use it to mount a component with a fixed state.
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
    // With no activity there is nothing to convert: the second currency's rate is not shown either (a typed one is).
    barRate: hasActivity(state, monthKey)
      ? barRate(rates, currenciesInUse(state, monthKey), calc.main, calc.second, calc.rate)
      : barRate(rates, [calc.main], calc.main, null, null),
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
