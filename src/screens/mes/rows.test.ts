import { describe, expect, it } from 'vitest';
import { CATS, METHODS } from '../../../shared/constants';
import { seedState } from '../../../shared/seed';
import type { AppState, CreditCard, Currency, ISODate, MonthKey } from '../../../shared/types';
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
  it('ordena por `sort` sin tocar la lista original', () => {
    const rows = [
      { id: 'c', sort: 2 },
      { id: 'a', sort: 0 },
      { id: 'b', sort: 1 },
    ];
    expect(sortFixed(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('los empates conservan el orden de llegada', () => {
    const rows = [
      { id: 'x', sort: 5 },
      { id: 'primero', sort: 1 },
      { id: 'segundo', sort: 1 },
      { id: 'tercero', sort: 1 },
    ];
    expect(sortFixed(rows).map((r) => r.id)).toEqual(['primero', 'segundo', 'tercero', 'x']);
  });

  it('los datos de ejemplo salen en el orden de la hoja', () => {
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
  it('de la más reciente a la más antigua, sin tocar la lista original', () => {
    const rows = [
      { id: 'a', date: '2026-10-01' },
      { id: 'b', date: '2026-10-07' },
      { id: 'c', date: '2026-09-30' },
      { id: 'd', date: '2026-10-03' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('es estable: las del mismo día quedan como estaban (la recién agregada, debajo)', () => {
    const rows = [
      { id: 'vieja', date: '2026-10-05' },
      { id: 'hoy-1', date: '2026-10-07' },
      { id: 'hoy-2', date: '2026-10-07' },
      { id: 'recién-agregada', date: '2026-10-07' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['hoy-1', 'hoy-2', 'recién-agregada', 'vieja']);
  });

  it('una fecha vacía (dato importado incompleto) va al final', () => {
    const rows = [
      { id: 'sin-fecha', date: '' },
      { id: 'a', date: '2026-10-02' },
    ];
    expect(sortTxDesc(rows).map((r) => r.id)).toEqual(['a', 'sin-fecha']);
  });

  it('las transacciones de ejemplo de octubre: del 7 al 1', () => {
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
  it('un valor de la lista la deja tal cual (la misma, sin copiar)', () => {
    expect(optionsWith(CATS, 'Health')).toBe(CATS);
    expect(optionsWith(METHODS, 'Debit card')).toBe(METHODS);
  });

  it('un valor de fuera se agrega al final, sin tocar la lista base', () => {
    expect(optionsWith(CATS, 'Pets')).toEqual([...CATS, 'Pets']);
    expect(optionsWith(METHODS, 'Cheque')).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash', 'Cheque']);
    // La tarjeta de antes ('Card') ya no está en la lista: una fila vieja que la traiga la conserva como opción.
    expect(optionsWith(METHODS, 'Card')).toEqual([...METHODS, 'Card']);
    expect(CATS).toHaveLength(11);
    expect(METHODS).toHaveLength(5);
  });

  it('distingue mayúsculas y espacios: no adivina a qué opción se parece', () => {
    expect(optionsWith(CATS, 'food')).toEqual([...CATS, 'food']);
    expect(optionsWith(CATS, '')).toEqual([...CATS, '']);
  });

  it('un nombre traducido no es el valor guardado: también va aparte', () => {
    expect(optionsWith(CATS, 'Comida')).toEqual([...CATS, 'Comida']);
  });
});

describe('labelled', () => {
  it('el valor es el canónico y el texto, el del idioma', () => {
    expect(labelled(METHODS, createI18n('es').methodLabel)).toEqual([
      { value: 'Debit card', label: 'Tarjeta de débito' },
      { value: 'Credit card', label: 'Tarjeta de crédito' },
      { value: 'Transfer', label: 'Transferencia' },
      { value: 'Bank app', label: 'App del banco' },
      { value: 'Cash', label: 'Efectivo' },
    ]);
    expect(labelled(METHODS, createI18n('tr').methodLabel).map((o) => o.label)).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
    expect(labelled(METHODS, createI18n('en').methodLabel).map((o) => o.label)).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    // El valor guardado es el mismo en los tres idiomas.
    expect(labelled(METHODS, createI18n('tr').methodLabel).map((o) => o.value)).toEqual([...METHODS]);
    expect(labelled(CATS, createI18n('tr').catLabel).slice(0, 2)).toEqual([
      { value: 'Food', label: 'Yemek' },
      { value: 'Groceries', label: 'Market' },
    ]);
    expect(labelled(CATS, createI18n('en').catLabel).map((o) => o.label)).toEqual([...CATS]);
  });

  it('un valor de fuera de la lista sale tal cual en cualquier idioma', () => {
    for (const lang of ['en', 'es', 'tr'] as const) {
      expect(labelled(optionsWith(CATS, 'Pets'), createI18n(lang).catLabel).at(-1)).toEqual({ value: 'Pets', label: 'Pets' });
      // Un nombre traducido ('Efectivo') no es el valor guardado ('Cash'): va aparte y no se traduce.
      expect(labelled(optionsWith(METHODS, 'Efectivo'), createI18n(lang).methodLabel).at(-1)).toEqual({ value: 'Efectivo', label: 'Efectivo' });
      // Tampoco la tarjeta de antes: 'Card' se ve tal cual, no como la de débito.
      expect(labelled(optionsWith(METHODS, 'Card'), createI18n(lang).methodLabel).at(-1)).toEqual({ value: 'Card', label: 'Card' });
    }
  });
});

describe('withMoney: las dos columnas calculadas de una fila', () => {
  const state = seedState();
  const both = (amount: number, cur: Currency) => inBoth(state, '2026-10', amount, cur);

  it('cada fila lleva su importe en la moneda principal y en la segunda, con las tasas del mes', () => {
    const fixed = state.months['2026-10']!.fixed;
    const rows = withMoney(fixed, both);
    expect(rows).toHaveLength(fixed.length);
    expect(rows.map((r) => r.row)).toEqual(fixed);
    const claude = rows.find((r) => r.row.name === 'Claude')!;
    // 106 USD × 58.76 (la tasa escrita de octubre).
    expect(claude.main).toBeCloseTo(6228.56, 6);
    expect(claude.second).toBe(106);
    const light = rows.find((r) => r.row.name === 'Electricity')!;
    expect(light.main).toBe(1337.15);
    expect(light.second).toBeCloseTo(1337.15 / 58.76, 6);
  });

  it('sigue a las monedas del usuario: con USD de principal y TRY de segunda', () => {
    const other = { ...seedState(), mainCurrency: 'USD' as const, secondCurrency: 'TRY' as const };
    other.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const [row] = withMoney([{ amount: 5876, cur: 'DOP' as const }], (amount, cur) => inBoth(other, '2026-10', amount, cur));
    expect(row!.main).toBeCloseTo(100, 6);
    expect(row!.second).toBeCloseTo(4000, 6);
  });

  it('sin filas, nada', () => {
    expect(withMoney([], both)).toEqual([]);
  });

  it('pasa la fecha de la fila: una sin fecha (gasto fijo) pide la última tasa del mes', () => {
    const calls: unknown[][] = [];
    const spy = (...args: [number, Currency, string?, string?]) => {
      calls.push(args);
      return { main: 0, second: 0 };
    };
    withMoney([{ amount: 10, cur: 'USD' as const, date: '2026-10-03' }, { amount: 20, cur: 'DOP' as const }], spy);
    // El mes no se indica (el seleccionado); la fecha, la de la fila o ninguna.
    expect(calls).toEqual([
      [10, 'USD', undefined, '2026-10-03'],
      [20, 'DOP', undefined, undefined],
    ]);
  });

  it('con dos tasas escritas en el mes, cada transacción se convierte con la vigente en su fecha', () => {
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
    // La tasa nueva vale desde su fecha, incluida; la fila anterior conserva la que tenía.
    expect(main).toEqual({ antes: 580, 'el-dia': 600, despues: 600, 'en-dop': 1200, 'sin-fecha': 600 });
    // 1,200 DOP del día 2, a 58.
    expect(rows.find((r) => r.row.id === 'en-dop')!.second).toBeCloseTo(1200 / 58, 9);
  });
});

describe('rowAccountOptions', () => {
  const state = seedState();
  state.accounts.push({ id: 'old', name: 'Old wallet', currency: 'TRY', opening: 0, hidden: true, sort: 9 });
  const base = accountOptions(state);

  it('la cuenta visible de una fila no cambia la lista: es la misma para todas (las filas memorizadas no se repintan)', () => {
    expect(base).toEqual([
      { value: 'us', label: 'US account' },
      { value: 'dr', label: 'DR account' },
    ]);
    expect(rowAccountOptions(base, state.accounts, 'dr')).toBe(base);
    expect(rowAccountOptions(base, state.accounts, 'us')).toBe(base);
    expect(rowAccountOptions(base, state.accounts, '')).toBe(base);
  });

  it('la cuenta de la fila que se ocultó después va detrás, con su nombre', () => {
    expect(rowAccountOptions(base, state.accounts, 'old')).toEqual([...base, { value: 'old', label: 'Old wallet' }]);
    expect(base).toHaveLength(2);
    // Lo mismo que arma la capa de datos.
    expect(rowAccountOptions(base, state.accounts, 'old')).toEqual(accountOptions(state, 'old'));
  });

  it('una cuenta que ya no existe sale con una raya', () => {
    expect(rowAccountOptions(base, state.accounts, 'gone').at(-1)).toEqual({ value: 'gone', label: '—' });
  });
});

describe('tasas del mes: qué pares se ven', () => {
  const acc = (currency: Currency): { currency: Currency } => ({ currency });
  const none = { fixed: [], tx: [] };

  it('usedCurrencies: la principal, la segunda, las de las cuentas visibles y las de los gastos del mes, en el orden de siempre', () => {
    expect(usedCurrencies('DOP', 'USD', [], none)).toEqual(['DOP', 'USD']);
    expect(usedCurrencies('USD', 'DOP', [acc('USD'), acc('DOP')], none)).toEqual(['DOP', 'USD']);
    expect(usedCurrencies('DOP', 'USD', [acc('TRY')], none)).toEqual(['DOP', 'USD', 'TRY']);
    expect(usedCurrencies('TRY', 'USD', [acc('USD')], none)).toEqual(['USD', 'TRY']);
    // Un gasto en liras sin cuenta en liras también cuenta.
    expect(usedCurrencies('DOP', 'USD', [acc('DOP')], { fixed: [{ cur: 'TRY' }], tx: [] })).toEqual(['DOP', 'USD', 'TRY']);
    expect(usedCurrencies('DOP', 'USD', [acc('DOP')], { fixed: [], tx: [{ cur: 'TRY' }] })).toEqual(['DOP', 'USD', 'TRY']);
  });

  it('con los datos de ejemplo (DOP y USD) solo se ve el par de la barra superior', () => {
    const state = seedState();
    const october = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD'], 'DOP');
    // Octubre tiene dos escritas (el 1 y el 6): la fila es la vigente al final del mes, con su fecha.
    expect(october).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' }]);
    const september = shownRates(pairRates(state, '2026-09'), ['DOP', 'USD'], 'DOP');
    expect(september).toHaveLength(1);
    // No sale de una tasa escrita: no trae fecha.
    expect(september[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-09', date: null });
    expect(september[0]!.rate).toBeCloseTo(134721 / 2300, 9);
  });

  it('con las tres monedas en uso solo se piden k-1 pares: cada una contra la principal; el tercero se cruza', () => {
    const rates = pairRates(seedState(), '2026-10');
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'DOP').map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'TRY>DOP:default']);
    // Con otra principal los pares son otros: USD>TRY y DOP>TRY; el que queda (USD>DOP, escrito) sale por ser escrito.
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'TRY').map((r) => `${r.from}>${r.to}`).sort()).toEqual(['TRY>DOP', 'USD>DOP', 'USD>TRY']);
  });

  it('con principal TRY y cuentas en DOP y USD: dos filas pedidas y el par cruzado no es una fila, salvo que esté escrito', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [];
    // Sin los envíos del ejemplo (que dan USD/DOP directo), el par USD/DOP solo puede salir cruzando.
    state.months['2026-10']!.transfers = [];
    for (const key of Object.keys(state.months)) if (key !== '2026-10') delete state.months[key];
    const rows = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD', 'TRY'], 'TRY');
    expect(rows.map((r) => [r.from, r.to].sort().join('-')).sort()).toEqual(['DOP-TRY', 'TRY-USD']);
    // Con las dos escritas, el par DOP/USD se resuelve cruzando por la principal.
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
      { from: 'DOP', to: 'TRY', rate: 0.8, date: '2026-10-01' },
    ];
    // Un objeto de estado nuevo: calc memoriza por objeto, y el anterior ya se consultó.
    const rates = pairRates({ ...state }, '2026-10');
    expect(rates.find((r) => [r.from, r.to].sort().join('-') === 'DOP-USD')).toMatchObject({ source: 'cross' });
    expect(shownRates(rates, ['DOP', 'USD', 'TRY'], 'TRY')).toHaveLength(2);
  });

  it('sin segunda moneda: usedCurrencies no la cuenta y sin otra moneda en uso no hace falta ninguna tasa', () => {
    expect(usedCurrencies('DOP', null, [acc('DOP')], none)).toEqual(['DOP']);
    expect(usedCurrencies('DOP', null, [acc('DOP'), acc('USD')], none)).toEqual(['DOP', 'USD']);
    const rates = pairRates({ ...seedState(), secondCurrency: null }, '2026-09');
    expect(noRatesNeeded(shownRates(rates, ['DOP'], 'DOP'))).toBe(true);
    expect(noRatesNeeded(shownRates(rates, ['DOP', 'USD'], 'DOP'))).toBe(false);
  });

  it('barRate: segunda → principal; sin segunda, la primera tasa que hace falta; ninguna si no hace falta', () => {
    const state = seedState();
    // Septiembre no tiene tasas escritas: con una sola moneda en uso no hay nada que enseñar.
    const rates = pairRates(state, '2026-09');
    const info = rates[0]!;
    expect(barRate(rates, ['DOP', 'USD'], 'DOP', 'USD', info)).toMatchObject({ from: 'USD', to: 'DOP' });
    expect(barRate(rates, ['DOP', 'USD'], 'DOP', null, null)).toMatchObject({ from: 'USD', to: 'DOP' });
    expect(barRate(rates, ['DOP'], 'DOP', null, null)).toBeNull();
  });

  it('una tasa escrita para el mes se ve siempre, aunque su par no esté en uso', () => {
    const state = seedState();
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' });
    const shown = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD'], 'DOP');
    expect(shown.map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'USD>TRY:month']);
    // El tercer par (cruzado por USD) no se usa y no está escrito: no sale.
    expect(pairRates(state, '2026-10').find((r) => r.source === 'cross')).toBeDefined();
  });
});

describe('tasas del mes: una cuenta vacía no pide tasa', () => {
  // Un usuario nuevo: principal TRY, segunda USD, y una cuenta en DOP sin dinero ni filas.
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

  it('la cuenta en DOP sin saldo ni filas no cuenta: una sola fila (USD>TRY) y la barra la sigue', () => {
    const state = empty();
    expect(used(state)).toEqual(['USD', 'TRY']);
    expect(rowsOf(state)).toEqual(['USD>TRY']);
    const rates = pairRates(state, '2026-10');
    const info = rates.find((r) => r.from === 'USD' && r.to === 'TRY')!;
    expect(barRate(rates, used(state), 'TRY', 'USD', info)).toMatchObject({ from: 'USD', to: 'TRY' });
  });

  it('con saldo inicial distinto de cero, la moneda cuenta', () => {
    const state = empty();
    state.accounts[2]!.opening = 500;
    expect(used(state)).toEqual(['DOP', 'USD', 'TRY']);
    expect(rowsOf(state).sort()).toEqual(['TRY>DOP', 'USD>TRY']);
  });

  it('solo con un ingreso, un envío, un gasto fijo o una transacción que nombra la cuenta, cuenta', () => {
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

  it('una tasa escrita para el mes se ve siempre, aunque su moneda no esté en uso', () => {
    const state = empty();
    state.months['2026-10']!.rates = [{ from: 'DOP', to: 'TRY', rate: 0.7, date: '2026-10-01' }];
    expect(rowsOf(state).sort()).toEqual(['DOP>TRY', 'USD>TRY']);
  });

  it('una cuenta oculta sigue sin contar', () => {
    const state = empty();
    state.accounts[2]!.hidden = true;
    expect(used(state)).toEqual(['USD', 'TRY']);
  });
});

describe('tasas del mes: sin actividad no hace falta ninguna tasa', () => {
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

  it('sin filas ni dinero: solo la principal, ninguna fila y la barra superior vacía', () => {
    const state = fresh();
    expect(hasActivity(state, '2026-10')).toBe(false);
    expect(currenciesInUse(state, '2026-10')).toEqual(['TRY']);
    expect(rowsOf(state)).toEqual([]);
    expect(bar(state)).toBeNull();
  });

  it('un gasto fijo en la moneda principal trae el par principal-segunda con su valor por defecto', () => {
    const state = fresh();
    state.months['2026-10']!.fixed = [{ id: 'f', monthKey: '2026-10', name: 'Rent', day: '', amount: 100, cur: 'TRY', paid: false, accountId: 'try', sort: 0 }];
    expect(rowsOf(state)).toEqual(['USD>TRY:default']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY', source: 'default' });
  });

  it('una cuenta con saldo inicial distinto de cero cuenta como actividad', () => {
    const state = fresh();
    state.accounts[1]!.opening = 50;
    expect(rowsOf(state)).toEqual(['USD>TRY:default']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY' });
  });

  it('una tasa escrita se ve siempre, aunque no haya actividad', () => {
    const state = fresh();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' }];
    expect(hasActivity(state, '2026-10')).toBe(false);
    expect(rowsOf(state)).toEqual(['USD>TRY:month']);
    expect(bar(state)).toMatchObject({ from: 'USD', to: 'TRY', rate: 41.5, source: 'month' });
  });
});

describe('tasas del mes: las filas de la tarjeta', () => {
  /** Las filas de un mes de ese estado, como las arma la tarjeta. */
  const rowsOf = (state: AppState, key: MonthKey, draftDate: ISODate, used: Currency[] = ['DOP', 'USD']) => {
    const rates = pairRates(state, key);
    return rateRows(shownRates(rates, used, 'DOP'), state.months[key]!.rates, rates, key, draftDate);
  };

  it('datos de ejemplo: octubre tiene dos tasas escritas del mismo par, una fila por fecha', () => {
    expect(rowsOf(seedState(), '2026-10', '2026-10-07')).toEqual([
      { kind: 'typed', key: 'DOP-USD:2026-10-01', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { kind: 'typed', key: 'DOP-USD:2026-10-06', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
  });

  it('las escritas de un par van por fecha, lleguen como lleguen, cada una en el sentido en que se escribió', () => {
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
    // La clave no depende del sentido: es el par y la fecha.
    expect(rows.map((r) => r.key)).toEqual(['DOP-USD:2026-10-01', 'DOP-USD:2026-10-08', 'DOP-USD:2026-10-20']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('un par sin ninguna escrita en el mes da UNA fila con la vigente y su origen', () => {
    // Septiembre: la tasa sale de sus envíos. Nadie ha escrito ninguna: la fila propone el primer día del mes.
    const [row, ...rest] = rowsOf(seedState(), '2026-09', '2026-09-01');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: 'resolved', key: 'DOP-USD:2026-09-01', from: 'USD', to: 'DOP', date: '2026-09-01' });
    expect(row!.rate).toBeCloseTo(134721 / 2300, 9);
    expect(row!.kind === 'resolved' && row.info).toMatchObject({ source: 'transfers', monthKey: '2026-09', date: null });
  });

  it('las tres monedas en uso: las escritas con su fecha y, de los otros pares, la vigente', () => {
    const rows = rowsOf(seedState(), '2026-10', '2026-10-07', ['DOP', 'USD', 'TRY']);
    expect(rows.map((r) => `${r.kind} ${r.from}>${r.to} ${r.date}`)).toEqual([
      'typed USD>DOP 2026-10-01',
      'typed USD>DOP 2026-10-06',
      // Sin ninguna escrita nunca: desde el primer día del mes, aunque hoy sea el 7. USD>TRY ya no es una fila: se cruza.
      'resolved TRY>DOP 2026-10-01',
    ]);
    expect(rows.slice(2).map((r) => r.kind === 'resolved' && r.info.source)).toEqual(['default']);
  });

  it('un par cuya tasa vigente es una escrita en un mes anterior: la fila es la vigente, y escribir en ella crea una desde hoy', () => {
    const state = seedState();
    state.months['2026-11'] = { ...state.months['2026-10']!, key: '2026-11', rates: [], fixed: [], transfers: [], tx: [], budgetLog: [], budgets: {} };
    const [row, ...rest] = rowsOf(state, '2026-11', '2026-11-12');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: 'resolved', from: 'USD', to: 'DOP', rate: 58.76, date: '2026-11-12', key: 'DOP-USD:2026-11-12' });
    // El origen es la del 6 de octubre.
    expect(row!.kind === 'resolved' && row.info).toMatchObject({ source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('una tasa escrita que no vale (0 o negativa) no es una fila: el par sale con la vigente', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 0, date: '2026-10-01' }];
    const rows = rowsOf(state, '2026-10', '2026-10-07');
    expect(rows.map((r) => r.kind)).toEqual(['resolved']);
  });

  it('solo salen los pares que se ven', () => {
    const state = seedState();
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-03' });
    const rates = pairRates(state, '2026-10');
    // Con solo el par de la barra a la vista, la escrita de USD → TRY no sale aunque esté en el mes.
    const rows = rateRows(rates.slice(0, 1), state.months['2026-10']!.rates, rates, '2026-10', '2026-10-07');
    expect(rows.map((r) => `${r.from}>${r.to}`)).toEqual(['USD>DOP', 'USD>DOP']);
    expect(rateRows([], state.months['2026-10']!.rates, rates, '2026-10', '2026-10-07')).toEqual([]);
  });
});

describe('newRateDate: desde cuándo vale una tasa nueva', () => {
  const state = seedState();
  const october = pairRates(state, '2026-10');

  it('el par ya tiene una escrita vigente y el mes es el actual: hoy', () => {
    expect(newRateDate('USD', 'DOP', october, '2026-10', '2026-10-07')).toBe('2026-10-07');
    // En cualquiera de los dos sentidos.
    expect(newRateDate('DOP', 'USD', october, '2026-10', '2026-10-07')).toBe('2026-10-07');
  });

  it('el par ya tiene una escrita vigente y el mes no es el actual: su primer día (la fecha de sus borradores)', () => {
    expect(newRateDate('USD', 'DOP', october, '2026-10', '2026-10-01')).toBe('2026-10-01');
  });

  it('el par no tiene ninguna escrita: el primer día del mes, para que cubra también las filas anteriores', () => {
    expect(newRateDate('USD', 'TRY', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(newRateDate('TRY', 'DOP', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
    // Septiembre: la tasa de USD → DOP sale de los envíos, no de una escrita.
    expect(newRateDate('USD', 'DOP', pairRates(state, '2026-09'), '2026-09', '2026-09-15')).toBe('2026-09-01');
  });

  it('una escrita en un mes anterior también cuenta como vigente', () => {
    const next = seedState();
    next.months['2026-11'] = { ...next.months['2026-10']!, key: '2026-11', rates: [], fixed: [], transfers: [], tx: [], budgetLog: [], budgets: {} };
    expect(newRateDate('USD', 'DOP', pairRates(next, '2026-11'), '2026-11', '2026-11-12')).toBe('2026-11-12');
  });

  it('un par que no está en la lista (o la misma moneda dos veces): el primer día del mes', () => {
    expect(newRateDate('USD', 'DOP', [], '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(newRateDate('USD', 'USD', october, '2026-10', '2026-10-07')).toBe('2026-10-01');
  });
});

describe('viaSuggestions', () => {
  /** Meses con un envío por cada vía de la lista, en ese orden. */
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

  it('sin envíos, las de siempre', () => {
    expect(viaSuggestions({}, '2026-10')).toEqual(['Remitly', 'PayPal']);
    expect(viaSuggestions(months({ '2026-10': [] }), '2026-10')).toEqual(['Remitly', 'PayPal']);
  });

  it('después van las ya usadas en este mes y en los anteriores, de la más reciente a la más antigua', () => {
    const all = months({
      '2026-08': ['Western Union', 'Remitly'],
      '2026-09': ['Wise'],
      '2026-10': ['Zelle', 'Banco Popular'],
      '2026-11': ['Revolut'],
    });
    expect(viaSuggestions(all, '2026-10')).toEqual(['Remitly', 'PayPal', 'Banco Popular', 'Zelle', 'Wise', 'Western Union']);
    // Un mes anterior no ve las de los posteriores; el último las ve todas.
    expect(viaSuggestions(all, '2026-08')).toEqual(['Remitly', 'PayPal', 'Western Union']);
    expect(viaSuggestions(all, '2026-11')).toEqual(['Remitly', 'PayPal', 'Revolut', 'Banco Popular', 'Zelle', 'Wise', 'Western Union']);
  });

  it('no repite: ni las de siempre, ni la misma con otras mayúsculas o espacios; una vacía no se ofrece', () => {
    const all = months({ '2026-09': ['paypal', ' Wise '], '2026-10': ['Wise', 'WISE', '', '   ', 'PayPal'] });
    expect(viaSuggestions(all, '2026-10')).toEqual(['Remitly', 'PayPal', 'WISE']);
  });

  it('los datos de ejemplo no agregan nada: solo usan Remitly y PayPal', () => {
    expect(viaSuggestions(seedState().months, '2026-10')).toEqual(['Remitly', 'PayPal']);
  });
});

describe('formatos', () => {
  it('shortDate: día/mes', () => {
    expect(shortDate('2026-10-02')).toBe('02/10');
    expect(shortDate('2027-01-31')).toBe('31/01');
  });

  it('transferName: vía y fecha corta, para las etiquetas de las celdas de un envío', () => {
    expect(transferName({ via: 'Remitly', date: '2026-10-02' })).toBe('Remitly 02/10');
    expect(transferName({ via: '', date: '2026-10-02' })).toBe('02/10');
  });

  it('showRate: dos decimales; cuatro cuando la tasa es menor que 1', () => {
    expect(showRate(58.76)).toBe('58.76');
    expect(showRate(134721 / 2300)).toBe('58.57');
    expect(showRate(1)).toBe('1.00');
    expect(showRate(1 / 58.76)).toBe('0.0170');
    expect(showRate(0.714285)).toBe('0.7143');
    expect(showRate(0)).toBe('0.00');
    expect(showRate(Number.NaN)).toBe('0.00');
  });

  it('rateText: dos decimales al menos, sin recortar lo que se haya escrito de más', () => {
    expect(rateText(58.7)).toBe('58.70');
    expect(rateText(58)).toBe('58.00');
    expect(rateText(58.76)).toBe('58.76');
    expect(rateText(0)).toBe('0.00');
    expect(rateText(58.755)).toBe('58.755');
    expect(rateText(58.5743)).toBe('58.5743');
    expect(rateText(Number.NaN)).toBe('0.00');
    // Una tasa menor que 1 se queda entera.
    expect(rateText(0.01702)).toBe('0.01702');
  });

  it('barWidth: porcentaje del valor mayor', () => {
    expect(barWidth(38304.71, 38304.71)).toBe('100%');
    expect(barWidth(50, 200)).toBe('25%');
    expect(barWidth(0, 1)).toBe('0%');
  });
});

describe('historyRows: transacciones y comisiones de envíos, juntas', () => {
  it('de la más reciente a la más antigua; con la misma fecha, primero las transacciones', () => {
    const tx = seedState().months['2026-10']!.tx;
    const account = seedState().accounts[0]! as TransferFee['account'];
    const fee = (transferId: string, date: ISODate): TransferFee => ({ transferId, date, via: 'Remitly', account, amount: 2.99, cur: 'USD' });
    const rows = historyRows(tx, [fee('a', '2026-10-02'), fee('b', '2026-10-07')]);
    expect(rows).toHaveLength(tx.length + 2);
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort().reverse());
    // El 7 hay una transacción (Coffee) y una comisión: la transacción va antes.
    expect(rows.slice(0, 2).map((r) => [r.kind, r.key])).toEqual([
      ['tx', tx.find((t) => t.date === '2026-10-07')!.id],
      ['fee', 'fee:b'],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(historyRows([], [])).toEqual([]);
  });
});

describe('lastFee: la comisión que se propone para un envío nuevo', () => {
  const months = () => {
    const s = seedState();
    s.months['2026-09']!.transfers.at(-1)!.fee = 2.99;
    return s.months;
  };

  it('la del envío más reciente por esa vía, sin distinguir mayúsculas ni espacios, hasta el mes que se mira', () => {
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

describe('tarjetas de crédito en los selectores', () => {
  const card = (id: string, name: string, over: Partial<CreditCard> = {}): CreditCard => ({ id, name, bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0, ...over });
  const cards = [card('a', 'Visa'), card('b', 'Master', { sort: 1 }), card('c', 'Old', { sort: 2, active: false })];

  it('«Pagar con»: la cuenta y una opción por tarjeta activa; la de la fila se queda aunque esté apagada', () => {
    expect(payWithOptions('Account', cards)).toEqual([
      { value: 'account', label: 'Account' },
      { value: 'card:a', label: 'Visa' },
      { value: 'card:b', label: 'Master' },
    ]);
    expect(payWithOptions('Account', cards, 'c').map((o) => o.value)).toEqual(['account', 'card:a', 'card:b', 'card:c']);
    expect(payWithOptions('Account', [])).toEqual([{ value: 'account', label: 'Account' }]);
  });

  it('el valor del selector y su vuelta', () => {
    expect(payWithValue(false, 'a', 'a')).toBe('account');
    expect(payWithValue(true, 'b', 'a')).toBe('card:b');
    expect(payWithValue(true, null, 'a')).toBe('card:a');
    expect(parsePayWith('account')).toEqual({ onCard: false });
    expect(parsePayWith('card:b')).toEqual({ onCard: true, cardId: 'b' });
  });

  it('sin tarjetas activas no se ofrece «Credit card» (salvo que la fila ya la tenga)', () => {
    expect(methodChoices(true)).toContain('Credit card');
    expect(methodChoices(false)).not.toContain('Credit card');
    expect(methodChoices(false, 'Credit card')).toContain('Credit card');
    expect(cardOptions(cards).map((o) => o.label)).toEqual(['Visa', 'Master']);
  });
});
