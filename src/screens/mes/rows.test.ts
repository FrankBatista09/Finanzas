import { describe, expect, it } from 'vitest';
import { CATS, METHODS } from '../../../shared/constants';
import { seedState } from '../../../shared/seed';
import type { AppState, CreditCard, Currency, ISODate, MonthKey, Transaction } from '../../../shared/types';
import { createI18n } from '../../i18n';
import { accountOptions, barRate, inBoth, pairRates } from '../../store';
import { accountsInUse, currenciesInUse, hasActivity } from '../../store/view';
import { buildFinanzas } from '../../store';
import type { Actions } from '../../store';
import { moneyAccounts } from '../../../shared/calc';
import type { TransferFee } from '../../../shared/calc';
import {
  barWidth,
  cardOptions,
  historyRows,
  lastFee,
  labelled,
  methodChoices,
  newRateDate,
  noRatesNeeded,
  optionsWith,
  parsePayWith,
  payWithOptions,
  payWithValue,
  rateRows,
  rateText,
  rowAccountOptions,
  shortDate,
  showRate,
  shownRates,
  sortFixed,
  sortTxDesc,
  transferName,
  usedCurrencies,
  viaSuggestions,
  withMoney,
} from './rows';

describe('sortFixed', () => {
  it('sorts by `sort` without touching the original list', () => {
    const rows = [
      { id: 'c', sort: 2 },
      { id: 'a', sort: 0 },
      { id: 'b', sort: 1 },
    ];
    expect(sortFixed(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('ties keep their arrival order', () => {
    const rows = [
      { id: 'x', sort: 5 },
      { id: 'primero', sort: 1 },
      { id: 'segundo', sort: 1 },
      { id: 'tercero', sort: 1 },
    ];
    expect(sortFixed(rows).map((r) => r.id)).toEqual(['primero', 'segundo', 'tercero', 'x']);
  });

  it('the sample data comes out in the order of the sheet', () => {
    const fixed = seedState().months['2026-10']!.fixed;
    expect(sortFixed([...fixed].reverse()).map((f) => f.name)).toEqual([
      'Electricity',
      'Internet',
      'Health insurance',
      'Fridge payment',
      'Claude',
      'Google One',
      'iCloud+',
      'Cluely',
      'Smartfit',
      'Netflix',
      'Unicaribe',
    ]);
  });
});

describe('sortTxDesc', () => {
  it('from the most recent to the oldest, without touching the original list', () => {
    const rows = [
      { id: 'a', date: '2026-10-01' },
      { id: 'b', date: '2026-10-07' },
      { id: 'c', date: '2026-09-30' },
      { id: 'd', date: '2026-10-03' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is stable: those of the same day stay as they were (the newly added one, below)', () => {
    const rows = [
      { id: 'vieja', date: '2026-10-05' },
      { id: 'hoy-1', date: '2026-10-07' },
      { id: 'hoy-2', date: '2026-10-07' },
      { id: 'recién-agregada', date: '2026-10-07' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['hoy-1', 'hoy-2', 'recién-agregada', 'vieja']);
  });

  it('an empty date (incomplete imported data) goes last', () => {
    const rows = [
      { id: 'sin-fecha', date: '' },
      { id: 'a', date: '2026-10-02' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['a', 'sin-fecha']);
  });

  it('the sample transactions of October: from the 7th to the 1st', () => {
    const tx = seedState().months['2026-10']!.tx;
    expect(sortTxDesc(tx).map((t) => t.desc)).toEqual([
      'Coffee',
      'Gas',
      'Pharmacy',
      'Movies',
      'Lunch',
      'Uber to work',
      'Weekly groceries',
    ]);
  });
});

describe('optionsWith', () => {
  it('a value in the list leaves it as is (the same one, not a copy)', () => {
    expect(optionsWith(CATS, 'Health')).toBe(CATS);
    expect(optionsWith(METHODS, 'Debit card')).toBe(METHODS);
  });

  it('a value from outside is added at the end, without touching the base list', () => {
    expect(optionsWith(CATS, 'Pets')).toEqual([...CATS, 'Pets']);
    expect(optionsWith(METHODS, 'Cheque')).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash', 'Cheque']);
    // The former 'Card' method is no longer in the list: an old row that carries it keeps it as an option.
    expect(optionsWith(METHODS, 'Card')).toEqual([...METHODS, 'Card']);
    expect(CATS).toHaveLength(11);
    expect(METHODS).toHaveLength(5);
  });

  it('is sensitive to case and spaces: it does not guess which option it resembles', () => {
    expect(optionsWith(CATS, 'food')).toEqual([...CATS, 'food']);
    expect(optionsWith(CATS, '')).toEqual([...CATS, '']);
  });

  it('a translated name is not the stored value: it also goes separately', () => {
    expect(optionsWith(CATS, 'Comida')).toEqual([...CATS, 'Comida']);
  });
});

describe('labelled', () => {
  it('the value is the canonical one and the text, that of the language', () => {
    expect(labelled(METHODS, createI18n('es').methodLabel)).toEqual([
      { value: 'Debit card', label: 'Tarjeta de débito' },
      { value: 'Credit card', label: 'Tarjeta de crédito' },
      { value: 'Transfer', label: 'Transferencia' },
      { value: 'Bank app', label: 'App del banco' },
      { value: 'Cash', label: 'Efectivo' },
    ]);
    expect(labelled(METHODS, createI18n('tr').methodLabel).map((o) => o.label)).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
    expect(labelled(METHODS, createI18n('en').methodLabel).map((o) => o.label)).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    // The stored value is the same in all three languages.
    expect(labelled(METHODS, createI18n('tr').methodLabel).map((o) => o.value)).toEqual([...METHODS]);
    expect(labelled(CATS, createI18n('tr').catLabel).slice(0, 2)).toEqual([
      { value: 'Food', label: 'Yemek' },
      { value: 'Groceries', label: 'Market' },
    ]);
    expect(labelled(CATS, createI18n('en').catLabel).map((o) => o.label)).toEqual([...CATS]);
  });

  it('a value from outside the list shows as is in any language', () => {
    for (const lang of ['en', 'es', 'tr'] as const) {
      expect(labelled(optionsWith(CATS, 'Pets'), createI18n(lang).catLabel).at(-1)).toEqual({ value: 'Pets', label: 'Pets' });
      // A translated name ('Efectivo') is not the stored value ('Cash'): it goes separately and is not translated.
      expect(labelled(optionsWith(METHODS, 'Efectivo'), createI18n(lang).methodLabel).at(-1)).toEqual({ value: 'Efectivo', label: 'Efectivo' });
      // Nor is the former 'Card' method: 'Card' shows as is, not as the debit card.
      expect(labelled(optionsWith(METHODS, 'Card'), createI18n(lang).methodLabel).at(-1)).toEqual({ value: 'Card', label: 'Card' });
    }
  });
});

describe('withMoney: the two computed columns of a row', () => {
  const state = seedState();
  const both = (amount: number, cur: Currency) => inBoth(state, '2026-10', amount, cur);

  it('each row carries its amount in the main currency and in the second one, with the month rates', () => {
    const fixed = state.months['2026-10']!.fixed;
    const rows = withMoney(fixed, both);
    expect(rows).toHaveLength(fixed.length);
    expect(rows.map((r) => r.row)).toEqual(fixed);
    const claude = rows.find((r) => r.row.name === 'Claude')!;
    // 106 USD × 58.76 (the typed rate of October).
    expect(claude.main).toBeCloseTo(6228.56, 6);
    expect(claude.second).toBe(106);
    const light = rows.find((r) => r.row.name === 'Electricity')!;
    expect(light.main).toBe(1337.15);
    expect(light.second).toBeCloseTo(1337.15 / 58.76, 6);
  });

  it('follows the currencies of the user: with USD as main and TRY as second', () => {
    const other = { ...seedState(), mainCurrency: 'USD' as const, secondCurrency: 'TRY' as const };
    other.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const [row] = withMoney([{ amount: 5876, cur: 'DOP' as const }], (amount, cur) => inBoth(other, '2026-10', amount, cur));
    expect(row!.main).toBeCloseTo(100, 6);
    expect(row!.second).toBeCloseTo(4000, 6);
  });

  it('no rows, nothing', () => {
    expect(withMoney([], both)).toEqual([]);
  });

  it('passes the date of the row: one with no date (fixed expense) asks for the last rate of the month', () => {
    const calls: unknown[][] = [];
    const spy = (...args: [number, Currency, string?, string?]) => {
      calls.push(args);
      return { main: 0, second: 0 };
    };
    withMoney([{ amount: 10, cur: 'USD' as const, date: '2026-10-03' }, { amount: 20, cur: 'DOP' as const }], spy);
    // The month is not given (the selected one); the date, that of the row or none.
    expect(calls).toEqual([
      [10, 'USD', undefined, '2026-10-03'],
      [20, 'DOP', undefined, undefined],
    ]);
  });

  it('with two typed rates in the month, each transaction is converted with the one in effect on its date', () => {
    const dated = seedState();
    dated.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
    ];
    const rows = withMoney(
      [
        { id: 'antes', amount: 10, cur: 'USD' as const, date: '2026-10-04' },
        { id: 'el-dia', amount: 10, cur: 'USD' as const, date: '2026-10-05' },
        { id: 'despues', amount: 10, cur: 'USD' as const, date: '2026-10-20' },
        { id: 'en-dop', amount: 1200, cur: 'DOP' as const, date: '2026-10-02' },
        { id: 'sin-fecha', amount: 10, cur: 'USD' as const },
      ],
      (amount, cur, key = '2026-10', date) => inBoth(dated, key, amount, cur, date),
    );
    const main = Object.fromEntries(rows.map((r) => [r.row.id, r.main]));
    // The new rate applies from its date, inclusive; the earlier row keeps the one it had.
    expect(main).toEqual({ antes: 580, 'el-dia': 600, despues: 600, 'en-dop': 1200, 'sin-fecha': 600 });
    // 1,200 DOP from day 2, at 58.
    expect(rows.find((r) => r.row.id === 'en-dop')!.second).toBeCloseTo(1200 / 58, 9);
  });
});

describe('rowAccountOptions', () => {
  const state = seedState();
  state.accounts.push({ id: 'old', name: 'Old wallet', currency: 'TRY', opening: 0, hidden: true, sort: 9 });
  const base = accountOptions(state);

  it('the visible account of a row does not change the list: it is the same for all of them (memoized rows do not repaint)', () => {
    expect(base).toEqual([
      { value: 'us', label: 'US account' },
      { value: 'dr', label: 'DR account' },
    ]);
    expect(rowAccountOptions(base, state.accounts, 'dr')).toBe(base);
    expect(rowAccountOptions(base, state.accounts, 'us')).toBe(base);
    expect(rowAccountOptions(base, state.accounts, '')).toBe(base);
  });

  it('the account of the row that was hidden afterwards goes at the end, with its name', () => {
    expect(rowAccountOptions(base, state.accounts, 'old')).toEqual([...base, { value: 'old', label: 'Old wallet' }]);
    expect(base).toHaveLength(2);
    // The same thing the data layer builds.
    expect(rowAccountOptions(base, state.accounts, 'old')).toEqual(accountOptions(state, 'old'));
  });

  it('an account that no longer exists shows as a dash', () => {
    expect(rowAccountOptions(base, state.accounts, 'gone').at(-1)).toEqual({ value: 'gone', label: '—' });
  });
});

describe('month rates: which pairs are shown', () => {
  const acc = (currency: Currency): { currency: Currency } => ({ currency });
  const none = { fixed: [], tx: [] };

  it('usedCurrencies: the main one, the second one, those of the visible accounts and those of the expenses of the month, in the usual order', () => {
    expect(usedCurrencies('DOP', 'USD', [], none)).toEqual(['DOP', 'USD']);
    expect(usedCurrencies('USD', 'DOP', [acc('USD'), acc('DOP')], none)).toEqual(['DOP', 'USD']);
    expect(usedCurrencies('DOP', 'USD', [acc('TRY')], none)).toEqual(['DOP', 'USD', 'TRY']);
    expect(usedCurrencies('TRY', 'USD', [acc('USD')], none)).toEqual(['USD', 'TRY']);
    // An expense in liras with no account in liras also counts.
    expect(usedCurrencies('DOP', 'USD', [acc('DOP')], { fixed: [{ cur: 'TRY' }], tx: [] })).toEqual(['DOP', 'USD', 'TRY']);
    expect(usedCurrencies('DOP', 'USD', [acc('DOP')], { fixed: [], tx: [{ cur: 'TRY' }] })).toEqual(['DOP', 'USD', 'TRY']);
  });

  it('with the sample data (DOP and USD) only the pair of the top bar is shown', () => {
    const state = seedState();
    const october = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD'], 'DOP');
    // October has two typed ones (on the 1st and the 6th): the row is the one in effect at the end of the month, with its date.
    expect(october).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' }]);
    const september = shownRates(pairRates(state, '2026-09'), ['DOP', 'USD'], 'DOP');
    expect(september).toHaveLength(1);
    // It does not come from a typed rate: it carries no date.
    expect(september[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-09', date: null });
    expect(september[0]!.rate).toBeCloseTo(134721 / 2300, 9);
  });

  it('with the three currencies in use only k-1 pairs are asked for: each one against the main one; the third is crossed', () => {
    const rates = pairRates(seedState(), '2026-10');
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'DOP').map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'TRY>DOP:default']);
    // With another main currency the pairs are different: USD>TRY and DOP>TRY; the remaining one (USD>DOP, typed) shows because it is typed.
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'TRY').map((r) => `${r.from}>${r.to}`).sort()).toEqual(['TRY>DOP', 'USD>DOP', 'USD>TRY']);
  });

  it('with TRY as main and accounts in DOP and USD: two rows asked for and the crossed pair is not a row, unless it is typed', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [];
    // Without the sample transfers (which give USD/DOP directly), the USD/DOP pair can only come from crossing.
    state.months['2026-10']!.transfers = [];
    for (const key of Object.keys(state.months)) if (key !== '2026-10') delete state.months[key];
    const rows = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD', 'TRY'], 'TRY');
    expect(rows.map((r) => [r.from, r.to].sort().join('-')).sort()).toEqual(['DOP-TRY', 'TRY-USD']);
    // With both typed, the DOP/USD pair is resolved by crossing through the main currency.
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
      { from: 'DOP', to: 'TRY', rate: 0.8, date: '2026-10-01' },
    ];
    // A new state object: calc memoizes by object, and the previous one was already queried.
    const rates = pairRates({ ...state }, '2026-10');
    expect(rates.find((r) => [r.from, r.to].sort().join('-') === 'DOP-USD')).toMatchObject({ source: 'cross' });
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'TRY')).toHaveLength(2);
  });

  it('no second currency: usedCurrencies does not count it and with no other currency in use no rate is needed', () => {
    expect(usedCurrencies('DOP', null, [acc('DOP')], none)).toEqual(['DOP']);
    expect(usedCurrencies('DOP', null, [acc('DOP'), acc('USD')], none)).toEqual(['DOP', 'USD']);
    const rates = pairRates({ ...seedState(), secondCurrency: null }, '2026-09');
    expect(noRatesNeeded(shownRates(rates, ['DOP'], 'DOP'))).toBe(true);
    expect(noRatesNeeded(shownRates(rates, ['DOP', 'USD'], 'DOP'))).toBe(false);
  });

  it('barRate: second → main; with no second, the first rate that is needed; none if none is needed', () => {
    const state = seedState();
    // September has no typed rates: with a single currency in use there is nothing to show.
    const rates = pairRates(state, '2026-09');
    const info = rates[0]!;
    expect(barRate(rates, ['DOP', 'USD'], 'DOP', 'USD', info)).toMatchObject({ from: 'USD', to: 'DOP' });
    expect(barRate(rates, ['DOP', 'USD'], 'DOP', null, null)).toMatchObject({ from: 'USD', to: 'DOP' });
    expect(barRate(rates, ['DOP'], 'DOP', null, null)).toBeNull();
  });

  it('a rate typed for the month is always shown, even if its pair is not in use', () => {
    const state = seedState();
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' });
    const shown = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD'], 'DOP');
    expect(shown.map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'USD>TRY:month']);
    // The third pair (crossed through USD) is not used and is not typed: it does not show.
    expect(pairRates(state, '2026-10').find((r) => r.source === 'cross')).toBeDefined();
  });
});

describe('month rates: an empty account needs no rate', () => {
  // A new user: main TRY, second USD, and an account in DOP with no money and no rows.
  const empty = (): AppState => {
    const state = seedState();
    state.mainCurrency = 'TRY';
    state.secondCurrency = 'USD';
    state.accounts = [
      { id: 'try', name: 'TRY account', currency: 'TRY', opening: 0, hidden: false, sort: 0 },
      { id: 'usd', name: 'USD account', currency: 'USD', opening: 0, hidden: false, sort: 1 },
      { id: 'dop', name: 'DR account', currency: 'DOP', opening: 0, hidden: false, sort: 2 },
    ];
    state.incomes = [];
    state.contribs = [];
    state.months = { '2026-10': { ...state.months['2026-10']!, rates: [], fixed: [], tx: [], transfers: [], outside: [], cards: [], budgetLog: [], budgets: {} } };
    return state;
  };
  const used = (state: AppState) => {
    const visible = moneyAccounts(state);
    const month = state.months['2026-10']!;
    return usedCurrencies('TRY', 'USD', accountsInUse(state, '2026-10', visible), month);
  };
  const rowsOf = (state: AppState) => shownRates(pairRates(state, '2026-10'), used(state), 'TRY').map((r) => `${r.from}>${r.to}`);

  it('the account in DOP with no balance and no rows does not count: a single row (USD>TRY) and the bar follows it', () => {
    const state = empty();
    expect(used(state)).toEqual(['USD', 'TRY']);
    expect(rowsOf(state)).toEqual(['USD>TRY']);
    const rates = pairRates(state, '2026-10');
    const info = rates.find((r) => r.from === 'USD' && r.to === 'TRY')!;
    expect(barRate(rates, used(state), 'TRY', 'USD', info)).toMatchObject({ from: 'USD', to: 'TRY' });
  });

  it('with a nonzero opening balance, the currency counts', () => {
    const state = empty();
    state.accounts[2]!.opening = 500;
    expect(used(state)).toEqual(['DOP', 'USD', 'TRY']);
    expect(rowsOf(state).sort()).toEqual(['TRY>DOP', 'USD>TRY']);
  });

  it('with only an income, a transfer, a fixed expense or a transaction that names the account, it counts', () => {
    const base = empty();
    const income = { id: 'i', date: '2026-10-02', desc: '', accountId: 'dop', amount: 0, cur: 'DOP', budget: false } as const;
    const withIncome = { ...base, incomes: [{ ...income }] } as AppState;
    expect(used(withIncome)).toContain('DOP');

    const withTransfer = empty();
    withTransfer.months['2026-10']!.transfers = [
      { id: 't', monthKey: '2026-10', date: '2026-10-02', via: '', fromAccountId: 'usd', toAccountId: 'dop', amount: 0, rate: 58, budget: false, fee: 0 },
    ];
    expect(used(withTransfer)).toContain('DOP');

    const withFixed = empty();
    withFixed.months['2026-10']!.fixed = [
      { id: 'f', monthKey: '2026-10', name: 'Rent', day: '', amount: 10, cur: 'TRY', paid: false, accountId: 'dop', sort: 0 },
    ];
    expect(used(withFixed)).toContain('DOP');
  });

  it('a rate typed for the month is always shown, even if its currency is not in use', () => {
    const state = empty();
    state.months['2026-10']!.rates = [{ from: 'DOP', to: 'TRY', rate: 0.7, date: '2026-10-01' }];
    expect(rowsOf(state).sort()).toEqual(['DOP>TRY', 'USD>TRY']);
  });

  it('a hidden account still does not count', () => {
    const state = empty();
    state.accounts[2]!.hidden = true;
    expect(used(state)).toEqual(['USD', 'TRY']);
  });
});

describe('month rates: with no activity no rate is needed', () => {
  // A brand-new user: main TRY, second USD, accounts at zero and no rows.
  const fresh = (): AppState => {
    const state = seedState();
    state.mainCurrency = 'TRY';
    state.secondCurrency = 'USD';
    state.accounts = [
      { id: 'try', name: 'TRY account', currency: 'TRY', opening: 0, hidden: false, sort: 0 },
      { id: 'usd', name: 'USD account', currency: 'USD', opening: 0, hidden: false, sort: 1 },
    ];
    state.incomes = [];
    state.contribs = [];
    state.months = { '2026-10': { ...state.months['2026-10']!, rates: [], fixed: [], tx: [], transfers: [], outside: [], cards: [], budgetLog: [], budgets: {} } };
    return state;
  };
  const bar = (state: AppState) => buildFinanzas({ user: { id: 'eda', name: 'Eda' }, state, monthKey: '2026-10', today: '2026-10-07', actions: {} as Actions })!.barRate;
  const rowsOf = (state: AppState) => shownRates(pairRates(state, '2026-10'), currenciesInUse(state, '2026-10'), 'TRY').map((r) => `${r.from}>${r.to}:${r.source}`);

  it('no rows and no money: only the main currency, no rows and an empty top bar', () => {
    const state = fresh();
    expect(hasActivity(state, '2026-10')).toBe(false);
    expect(currenciesInUse(state, '2026-10')).toEqual(['TRY']);
    expect(rowsOf(state)).toEqual([]);
    expect(bar(state)).toBeNull();
  });

  it('a fixed expense in the main currency brings the main-second pair with its default value', () => {
    const state = fresh();
    state.months['2026-10']!.fixed = [{ id: 'f', monthKey: '2026-10', name: 'Rent', day: '', amount: 100, cur: 'TRY', paid: false, accountId: 'try', sort: 0 }];
    expect(rowsOf(state)).toEqual(['USD>TRY:default']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY', source: 'default' });
  });

  it('an account with a nonzero opening balance counts as activity', () => {
    const state = fresh();
    state.accounts[1]!.opening = 50;
    expect(rowsOf(state)).toEqual(['USD>TRY:default']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY' });
  });

  it('a typed rate is always shown, even with no activity', () => {
    const state = fresh();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' }];
    expect(hasActivity(state, '2026-10')).toBe(false);
    expect(rowsOf(state)).toEqual(['USD>TRY:month']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY', rate: 41.5, source: 'month' });
  });
});

describe('month rates: the rows of the card', () => {
  /** The rows of a month of that state, as the card builds them. */
  const rowsOf = (state: AppState, key: MonthKey, draftDate: ISODate, used: Currency[] = ['DOP', 'USD']) => {
    const rates = pairRates(state, key);
    return rateRows(shownRates(rates, used, 'DOP'), state.months[key]!.rates, rates, key, draftDate);
  };

  it('sample data: October has two typed rates for the same pair, one row per date', () => {
    expect(rowsOf(seedState(), '2026-10', '2026-10-07')).toEqual([
      { kind: 'typed', key: 'DOP-USD:2026-10-01', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { kind: 'typed', key: 'DOP-USD:2026-10-06', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
  });

  it('the typed rates of a pair go by date, however they arrive, each in the direction it was typed', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-20' },
      { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-08' },
    ];
    const rows = rowsOf(state, '2026-10', '2026-10-07');
    expect(rows.map((r) => `${r.kind} ${r.date} ${r.from}>${r.to} ${r.rate}`)).toEqual([
      'typed 2026-10-01 DOP>USD 0.017',
      'typed 2026-10-08 USD>DOP 59',
      'typed 2026-10-20 USD>DOP 60',
    ]);
    // The key does not depend on the direction: it is the pair and the date.
    expect(rows.map((r) => r.key)).toEqual(['DOP-USD:2026-10-01', 'DOP-USD:2026-10-08', 'DOP-USD:2026-10-20']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('a pair with no typed rate in the month gives ONE row with the one in effect and its source', () => {
    // September: the rate comes from its transfers. Nobody has typed one: the row proposes the first day of the month.
    const [row, ...rest] = rowsOf(seedState(), '2026-09', '2026-09-01');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: 'resolved', key: 'DOP-USD:2026-09-01', from: 'USD', to: 'DOP', date: '2026-09-01' });
    expect(row!.rate).toBeCloseTo(134721 / 2300, 9);
    expect(row!.kind === 'resolved' && row.info).toMatchObject({ source: 'transfers', monthKey: '2026-09', date: null });
  });

  it('the three currencies in use: the typed rates with their date and, for the other pairs, the one in effect', () => {
    const rows = rowsOf(seedState(), '2026-10', '2026-10-07', ['DOP', 'USD', 'TRY']);
    expect(rows.map((r) => `${r.kind} ${r.from}>${r.to} ${r.date}`)).toEqual([
      'typed USD>DOP 2026-10-01',
      'typed USD>DOP 2026-10-06',
      // With none ever typed: from the first day of the month, even though today is the 7th. USD>TRY is no longer a row: it is crossed.
      'resolved TRY>DOP 2026-10-01',
    ]);
    expect(rows.slice(2).map((r) => r.kind === 'resolved' && r.info.source)).toEqual(['default']);
  });

  it('a pair whose rate in effect is one typed in an earlier month: the row is the one in effect, and typing in it creates one from today', () => {
    const state = seedState();
    state.months['2026-11'] = { ...state.months['2026-10']!, key: '2026-11', rates: [], fixed: [], transfers: [], tx: [], budgetLog: [], budgets: {} };
    const [row, ...rest] = rowsOf(state, '2026-11', '2026-11-12');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: 'resolved', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-11-12', key: 'DOP-USD:2026-11-12' });
    // The source is the one from October 6.
    expect(row!.kind === 'resolved' && row.info).toMatchObject({ source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('a typed rate that is not valid (0 or negative) is not a row: the pair shows with the one in effect', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 0, date: '2026-10-01' }];
    const rows = rowsOf(state, '2026-10', '2026-10-07');
    expect(rows.map((r) => r.kind)).toEqual(['resolved']);
  });

  it('only the pairs that are shown come out', () => {
    const state = seedState();
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-03' });
    const rates = pairRates(state, '2026-10');
    // With only the pair of the bar in view, the typed USD → TRY rate does not show even though it is in the month.
    const rows = rateRows(rates.slice(0, 1), state.months['2026-10']!.rates, rates, '2026-10', '2026-10-07');
    expect(rows.map((r) => `${r.from}>${r.to}`)).toEqual(['USD>DOP', 'USD>DOP']);
    expect(rateRows([], state.months['2026-10']!.rates, rates, '2026-10', '2026-10-07')).toEqual([]);
  });
});

describe('newRateDate: from when a new rate applies', () => {
  const state = seedState();
  const october = pairRates(state, '2026-10');

  it('the pair already has a typed rate in effect and the month is the current one: today', () => {
    expect(newRateDate('USD', 'DOP', october, '2026-10', '2026-10-07')).toBe('2026-10-07');
    // In either direction.
    expect(newRateDate('DOP', 'USD', october, '2026-10', '2026-10-07')).toBe('2026-10-07');
  });

  it('the pair already has a typed rate in effect and the month is not the current one: its first day (the date of its drafts)', () => {
    expect(newRateDate('USD', 'DOP', october, '2026-10', '2026-10-01')).toBe('2026-10-01');
  });

  it('the pair has no typed rate: the first day of the month, so that it also covers the earlier rows', () => {
    expect(newRateDate('USD', 'TRY', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(newRateDate('TRY', 'DOP', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
    // September: the USD → DOP rate comes from the transfers, not from a typed one.
    expect(newRateDate('USD', 'DOP', pairRates(state, '2026-09'), '2026-09', '2026-09-15')).toBe('2026-09-01');
  });

  it('one typed in an earlier month also counts as in effect', () => {
    const next = seedState();
    next.months['2026-11'] = { ...next.months['2026-10']!, key: '2026-11', rates: [], fixed: [], transfers: [], tx: [], budgetLog: [], budgets: {} };
    expect(newRateDate('USD', 'DOP', pairRates(next, '2026-11'), '2026-11', '2026-11-12')).toBe('2026-11-12');
  });

  it('a pair that is not in the list (or the same currency twice): the first day of the month', () => {
    expect(newRateDate('USD', 'DOP', [], '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(newRateDate('USD', 'USD', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
  });
});

describe('viaSuggestions', () => {
  /** Months with one transfer for each via in the list, in that order. */
  const months = (vias: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(vias).map(([key, list]) => [
        key,
        {
          transfers: list.map((via, i) => ({
            id: `${key}-${i}`,
            monthKey: key,
            date: `${key}-01`,
            via,
            fromAccountId: 'us',
            toAccountId: 'dr',
            amount: 100,
            rate: 58,
            budget: false,
            fee: 0,
          })),
        },
      ]),
    );

  it('with no transfers, the usual ones', () => {
    expect(viaSuggestions({}, '2026-10')).toEqual(['Remitly', 'PayPal']);
    expect(viaSuggestions(months({ '2026-10': [] }), '2026-10')).toEqual(['Remitly', 'PayPal']);
  });

  it('then come those already used in this month and in the earlier ones, from the most recent to the oldest', () => {
    const all = months({
      '2026-08': ['Western Union', 'Remitly'],
      '2026-09': ['Wise'],
      '2026-10': ['Zelle', 'Banco Popular'],
      '2026-11': ['Revolut'],
    });
    expect(viaSuggestions(all, '2026-10')).toEqual(['Remitly', 'PayPal', 'Banco Popular', 'Zelle', 'Wise', 'Western Union']);
    // An earlier month does not see those of the later ones; the last one sees them all.
    expect(viaSuggestions(all, '2026-08')).toEqual(['Remitly', 'PayPal', 'Western Union']);
    expect(viaSuggestions(all, '2026-11')).toEqual(['Remitly', 'PayPal', 'Revolut', 'Banco Popular', 'Zelle', 'Wise', 'Western Union']);
  });

  it('does not repeat: neither the usual ones, nor the same one with different case or spaces; an empty one is not offered', () => {
    const all = months({ '2026-09': ['paypal', ' Wise '], '2026-10': ['Wise', 'WISE', '', '   ', 'PayPal'] });
    expect(viaSuggestions(all, '2026-10')).toEqual(['Remitly', 'PayPal', 'WISE']);
  });

  it('the sample data adds nothing: it only uses Remitly and PayPal', () => {
    expect(viaSuggestions(seedState().months, '2026-10')).toEqual(['Remitly', 'PayPal']);
  });
});

describe('formats', () => {
  it('shortDate: day/month', () => {
    expect(shortDate('2026-10-02')).toBe('02/10');
    expect(shortDate('2027-01-31')).toBe('31/01');
  });

  it('transferName: via and short date, for the labels of the cells of a transfer', () => {
    expect(transferName({ via: 'Remitly', date: '2026-10-02' })).toBe('Remitly 02/10');
    expect(transferName({ via: '', date: '2026-10-02' })).toBe('02/10');
  });

  it('showRate: two decimals; four when the rate is lower than 1', () => {
    expect(showRate(58.76)).toBe('58.76');
    expect(showRate(134721 / 2300)).toBe('58.57');
    expect(showRate(1)).toBe('1.00');
    expect(showRate(1 / 58.76)).toBe('0.0170');
    expect(showRate(0.714285)).toBe('0.7143');
    expect(showRate(0)).toBe('0.00');
    expect(showRate(Number.NaN)).toBe('0.00');
  });

  it('rateText: at least two decimals, without trimming whatever extra was typed', () => {
    expect(rateText(58.7)).toBe('58.70');
    expect(rateText(58)).toBe('58.00');
    expect(rateText(58.76)).toBe('58.76');
    expect(rateText(0)).toBe('0.00');
    expect(rateText(58.755)).toBe('58.755');
    expect(rateText(58.5743)).toBe('58.5743');
    expect(rateText(Number.NaN)).toBe('0.00');
    // A rate lower than 1 stays whole.
    expect(rateText(0.01702)).toBe('0.01702');
  });

  it('barWidth: percentage of the largest value', () => {
    expect(barWidth(38304.71, 38304.71)).toBe('100%');
    expect(barWidth(50, 200)).toBe('25%');
    expect(barWidth(0, 1)).toBe('0%');
  });
});

describe('historyRows: transactions and transfer fees, together', () => {
  it('from the most recent to the oldest; on the same date, transactions first', () => {
    const tx = seedState().months['2026-10']!.tx;
    const account = seedState().accounts[0]! as TransferFee['account'];
    const fee = (transferId: string, date: ISODate): TransferFee => ({ transferId, date, via: 'Remitly', account, amount: 2.99, cur: 'USD' });
    const rows = historyRows(tx, [fee('a', '2026-10-02'), fee('b', '2026-10-07')]);
    expect(rows).toHaveLength(tx.length + 2);
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort().reverse());
    // On the 7th there is a transaction (Coffee) and a fee: the transaction goes first.
    expect(rows.slice(0, 2).map((r) => [r.kind, r.key])).toEqual([
      ['tx', tx.find((t) => t.date === '2026-10-07')!.id],
      ['fee', 'fee:b'],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(historyRows([], [])).toEqual([]);
  });
});

describe('historyRows: order', () => {
  const base = seedState().months['2026-10']!.tx[0]!;
  const tx = (id: string, date: ISODate, createdAt: string | null): Transaction => ({ ...base, id, date, createdAt });
  const list = [tx('a', '2026-10-05', '2026-10-06 10:00:00'), tx('b', '2026-10-09', '2026-10-06 09:00:00'), tx('c', '2026-10-01', null), tx('d', '2026-10-09', '2026-10-06 09:00:00')];

  it('by date, oldest first is the reverse of newest first', () => {
    expect(historyRows(list, [], 'dateNewest').map((r) => r.key)).toEqual(['b', 'd', 'a', 'c']);
    expect(historyRows(list, [], 'dateOldest').map((r) => r.key)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('by when it was recorded: the stamp, then the list place; no stamp yet counts as the newest', () => {
    expect(historyRows(list, [], 'addedOldest').map((r) => r.key)).toEqual(['b', 'd', 'a', 'c']);
    expect(historyRows(list, [], 'addedNewest').map((r) => r.key)).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('lastFee: the fee proposed for a new transfer', () => {
  const months = () => {
    const s = seedState();
    s.months['2026-09']!.transfers.at(-1)!.fee = 2.99;
    return s.months;
  };

  it('that of the most recent transfer through that via, ignoring case and spaces, up to the month being viewed', () => {
    expect(lastFee(months(), '2026-10', 'Remitly')).toBe(0);
    const m = months();
    m['2026-10']!.transfers = [];
    expect(lastFee(m, '2026-10', ' REMITLY ')).toBe(2.99);
    expect(lastFee(months(), '2026-09', 'Remitly')).toBe(2.99);
    expect(lastFee(months(), '2026-08', 'Remitly')).toBe(0);
    expect(lastFee(months(), '2026-10', 'Wise')).toBe(0);
    expect(lastFee({}, '2026-10', 'Remitly')).toBe(0);
  });
});

describe('credit cards in the selects', () => {
  const card = (id: string, name: string, over: Partial<CreditCard> = {}): CreditCard => ({ id, name, bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0, ...over });
  const cards = [card('a', 'Visa'), card('b', 'Master', { sort: 1 }), card('c', 'Old', { sort: 2, active: false })];

  it('"Pay with": the account and one option per active credit card; that of the row stays even if it is turned off', () => {
    expect(payWithOptions('Account', cards)).toEqual([
      { value: 'account', label: 'Account' },
      { value: 'card:a', label: 'Visa' },
      { value: 'card:b', label: 'Master' },
    ]);
    expect(payWithOptions('Account', cards, 'c').map((o) => o.value)).toEqual(['account', 'card:a', 'card:b', 'card:c']);
    expect(payWithOptions('Account', [])).toEqual([{ value: 'account', label: 'Account' }]);
  });

  it('the value of the select and its way back', () => {
    expect(payWithValue(false, 'a', 'a')).toBe('account');
    expect(payWithValue(true, 'b', 'a')).toBe('card:b');
    expect(payWithValue(true, null, 'a')).toBe('card:a');
    expect(parsePayWith('account')).toEqual({ onCard: false });
    expect(parsePayWith('card:b')).toEqual({ onCard: true, cardId: 'b' });
  });

  it('with no active credit cards "Credit card" is not offered (unless the row already has it)', () => {
    expect(methodChoices(true)).toContain('Credit card');
    expect(methodChoices(false)).not.toContain('Credit card');
    expect(methodChoices(false, 'Credit card')).toContain('Credit card');
    expect(cardOptions(cards).map((o) => o.label)).toEqual(['Visa', 'Master']);
  });
});
