import { describe, expect, it } from 'vitest';
import { CATS, METHODS } from '../../../shared/constants';
import { seedState } from '../../../shared/seed';
import type { Account, Currency } from '../../../shared/types';
import { createI18n } from '../../i18n';
import { accountOptions, inBoth, pairRates } from '../../store';
import {
  barWidth,
  labelled,
  optionsWith,
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
    expect(optionsWith(METHODS, 'Card')).toBe(METHODS);
  });

  it('un valor de fuera se agrega al final, sin tocar la lista base', () => {
    expect(optionsWith(CATS, 'Pets')).toEqual([...CATS, 'Pets']);
    expect(optionsWith(METHODS, 'Cash')).toEqual(['Card', 'Transfer', 'Bank app', 'Cash']);
    expect(CATS).toHaveLength(10);
    expect(METHODS).toHaveLength(3);
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
      { value: 'Card', label: 'Tarjeta' },
      { value: 'Transfer', label: 'Transferencia' },
      { value: 'Bank app', label: 'App del banco' },
    ]);
    expect(labelled(CATS, createI18n('tr').catLabel).slice(0, 2)).toEqual([
      { value: 'Food', label: 'Yemek' },
      { value: 'Groceries', label: 'Market' },
    ]);
    expect(labelled(CATS, createI18n('en').catLabel).map((o) => o.label)).toEqual([...CATS]);
  });

  it('un valor de fuera de la lista sale tal cual en cualquier idioma', () => {
    for (const lang of ['en', 'es', 'tr'] as const) {
      expect(labelled(optionsWith(CATS, 'Pets'), createI18n(lang).catLabel).at(-1)).toEqual({ value: 'Pets', label: 'Pets' });
      expect(labelled(optionsWith(METHODS, 'Efectivo'), createI18n(lang).methodLabel).at(-1)).toEqual({ value: 'Efectivo', label: 'Efectivo' });
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
    other.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40 });
    const [row] = withMoney([{ amount: 5876, cur: 'DOP' as const }], (amount, cur) => inBoth(other, '2026-10', amount, cur));
    expect(row!.main).toBeCloseTo(100, 6);
    expect(row!.second).toBeCloseTo(4000, 6);
  });

  it('sin filas, nada', () => {
    expect(withMoney([], both)).toEqual([]);
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
  const acc = (currency: Currency): Pick<Account, 'currency'> => ({ currency });
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
    const october = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD']);
    expect(october).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: '2026-10' }]);
    const september = shownRates(pairRates(state, '2026-09'), ['DOP', 'USD']);
    expect(september).toHaveLength(1);
    expect(september[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-09' });
    expect(september[0]!.rate).toBeCloseTo(134721 / 2300, 9);
  });

  it('con las tres monedas en uso se ven los tres pares, el de la barra primero', () => {
    const shown = shownRates(pairRates(seedState(), '2026-10'), ['DOP', 'USD', 'TRY']);
    expect(shown.map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'TRY>DOP:default', 'USD>TRY:default']);
  });

  it('una tasa escrita para el mes se ve siempre, aunque su par no esté en uso', () => {
    const state = seedState();
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5 });
    const shown = shownRates(pairRates(state, '2026-10'), ['DOP', 'USD']);
    expect(shown.map((r) => `${r.from}>${r.to}:${r.source}`)).toEqual(['USD>DOP:month', 'USD>TRY:month']);
    // El tercer par (cruzado por USD) no se usa y no está escrito: no sale.
    expect(pairRates(state, '2026-10').find((r) => r.source === 'cross')).toBeDefined();
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
