// Lo que las pantallas leen ya calculado: el valor de useFinanzas() y las piezas con las que se arma.

import { describe, expect, it } from 'vitest';
import { balances, leftoverFor, monthCalc, rateFor } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, AppUser } from '../../shared/types';
import type { Actions } from './context';
import { accountOptions, buildFinanzas, inBoth, pairRates } from './view';

const OCT = '2026-10';
const FRANK: AppUser = { id: 'frank', name: 'Frank' };
const actions = {} as Actions;

const build = (state: AppState = seedState(), monthKey = OCT, today = '2026-10-07') => buildFinanzas({ user: FRANK, state, monthKey, today, actions })!;

/** Los datos de ejemplo con las tres tasas de octubre a la vista: USD → DOP y USD → TRY escritas. */
function withLira(): AppState {
  const s = seedState();
  s.months[OCT]!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
  return s;
}

/** Octubre con dos tasas USD → DOP de fechas distintas: 58 desde el día 1 y 60 desde el día 6. */
function twoRates(): AppState {
  const s = seedState();
  s.months[OCT]!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
  ];
  return s;
}

describe('inBoth: un importe en la moneda principal y en la segunda', () => {
  it('con las tasas del mes que se pida', () => {
    const s = seedState();
    expect(inBoth(s, OCT, 5876, 'DOP')).toEqual({ main: 5876, second: 100 });
    expect(inBoth(s, OCT, 100, 'USD')).toEqual({ main: 5876, second: 100 });
    // Agosto no tiene tasa escrita: la de sus envíos.
    const aug = rateFor(s, '2026-08', 'USD', 'DOP').rate;
    expect(inBoth(s, '2026-08', 100, 'USD').main).toBeCloseTo(100 * aug, 10);
    expect(inBoth(s, '2026-08', 100, 'USD').second).toBe(100);
  });

  it('sigue a las monedas del usuario, también con una tercera', () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'DOP';
    const { main, second } = inBoth(s, OCT, 100, 'USD');
    expect(main).toBeCloseTo(4000, 9);
    expect(second).toBeCloseTo(5876, 9);
    // Un importe en liras: tal cual en la principal, cruzado por USD a la segunda.
    expect(inBoth(s, OCT, 1000, 'TRY').main).toBe(1000);
    expect(inBoth(s, OCT, 1000, 'TRY').second).toBeCloseTo((1000 / 40) * 58.76, 9);
  });

  it('con fecha, la tasa vigente ese día; sin ella, la última del mes', () => {
    const s = twoRates();
    // Una fila del día 3 se convierte a 58 aunque el día 6 se escribiera 60.
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-03')).toEqual({ main: 5800, second: 100 });
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-01').main).toBe(5800);
    expect(inBoth(s, OCT, 5800, 'DOP', '2026-10-05').second).toBeCloseTo(100, 10);
    // Desde el día 6 (incluido), la nueva.
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-06').main).toBe(6000);
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-20').main).toBe(6000);
    expect(inBoth(s, OCT, 100, 'USD')).toEqual({ main: 6000, second: 100 });
    expect(inBoth(s, OCT, 6000, 'DOP').second).toBeCloseTo(100, 10);
  });
});

describe('pairRates: las tasas del mes, una por par, con su origen', () => {
  it('el par de la barra superior va primero; cada fila en un sentido que se lea', () => {
    const rates = pairRates(seedState(), OCT);
    expect(rates.map((r) => [r.from, r.to, r.source])).toEqual([
      ['USD', 'DOP', 'month'],
      ['TRY', 'DOP', 'default'],
      ['USD', 'TRY', 'default'],
    ]);
    // De las dos escritas en octubre (días 1 y 6), la vigente al final del mes.
    expect(rates[0]).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    // Valores de respaldo: 42 TRY y 58.76 DOP por USD. Siempre en el sentido que da un número >= 1.
    expect(rates[1]!.rate).toBeCloseTo(58.76 / 42, 12);
    expect(rates[2]!.rate).toBe(42);
    for (const r of rates) expect(r.rate).toBeGreaterThanOrEqual(1);
  });

  it('una tasa escrita sale en el sentido en que se escribió, aunque sea menor que 1', () => {
    const s = seedState();
    s.months[OCT]!.rates = [
      { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-02' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-03' },
    ];
    const rates = pairRates(s, OCT);
    expect(rates[0]).toEqual({ from: 'DOP', to: 'USD', rate: 0.017, source: 'month', monthKey: OCT, date: '2026-10-02' });
    expect(rates.find((r) => r.from === 'USD' && r.to === 'TRY')).toMatchObject({ rate: 40, source: 'month' });
    // La tercera sale cruzando por USD.
    const cross = rates.find((r) => r.source === 'cross')!;
    expect([cross.from, cross.to]).toEqual(['TRY', 'DOP']);
    expect(cross.rate).toBeCloseTo(1 / 0.017 / 40, 10);
  });

  it('dice de dónde sale cada una: envíos del mes, un mes anterior', () => {
    expect(pairRates(seedState(), '2026-08')[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-08', date: null });
    // Otro estado (no el mismo objeto cambiado: shared/calc.ts memoriza las tasas por objeto de estado).
    const s = seedState();
    s.months[OCT]!.rates = [];
    s.months[OCT]!.transfers = [];
    expect(pairRates(s, OCT)[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'previous', monthKey: '2026-09', date: null });
  });

  it('con varias tasas escritas del mismo par, una fila sola: la vigente al final del mes, con su fecha', () => {
    const rates = pairRates(twoRates(), OCT);
    expect(rates).toHaveLength(3);
    expect(rates.filter((r) => r.from === 'USD' && r.to === 'DOP')).toEqual([
      { from: 'USD', to: 'DOP', rate: 60, source: 'month', monthKey: OCT, date: '2026-10-06' },
    ]);
  });

  it('la vigente sale en el sentido en que se escribió ella, no en el de una anterior del mismo par', () => {
    const s = seedState();
    s.months[OCT]!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.016, date: '2026-10-06' },
    ];
    expect(pairRates(s, OCT)[0]).toEqual({ from: 'DOP', to: 'USD', rate: 0.016, source: 'month', monthKey: OCT, date: '2026-10-06' });
  });

  it('la última escrita sigue vigente en los meses siguientes: sale como de un mes anterior, con su fecha', () => {
    const s = twoRates();
    s.months['2026-11'] = { key: '2026-11', closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    expect(pairRates(s, '2026-11')[0]).toEqual({ from: 'USD', to: 'DOP', rate: 60, source: 'previous', monthKey: OCT, date: '2026-10-06' });
  });

  it('con otras monedas elegidas, el primer par es el suyo', () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'USD';
    expect(pairRates(s, OCT).map((r) => `${r.from}>${r.to}`)).toEqual(['USD>TRY', 'USD>DOP', 'TRY>DOP']);
    // Coincide con la tasa de la barra superior (MonthCalc.rate: 1 segunda = rate principal).
    expect(pairRates(s, OCT)[0]).toMatchObject(monthCalc(s, OCT).rate!);
  });

  it('un mes que no existe: sin tasas escritas, resuelve con lo que haya antes', () => {
    expect(pairRates(seedState(), '2027-03')[0]).toMatchObject({ from: 'USD', to: 'DOP', rate: 58.76, source: 'previous', monthKey: OCT, date: '2026-10-06' });
  });
});

describe('accountOptions: las opciones de un selector de cuenta', () => {
  it('las cuentas visibles, en su orden, con su nombre', () => {
    expect(accountOptions(seedState())).toEqual([
      { value: 'us', label: 'US account' },
      { value: 'dr', label: 'DR account' },
    ]);
  });

  it('la cuenta de una fila que después se ocultó sigue en la lista, con su nombre', () => {
    const s = seedState();
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    expect(accountOptions(s)).toEqual([{ value: 'dr', label: 'DR account' }]);
    expect(accountOptions(s, 'us')).toEqual([
      { value: 'dr', label: 'DR account' },
      { value: 'us', label: 'US account' },
    ]);
    // Las que ya están no se repiten, y lo que no es un id se ignora.
    expect(accountOptions(s, 'dr', null, undefined, 'us', 'us')).toHaveLength(2);
    // Una cuenta que ya no existe no se queda con su id a la vista.
    expect(accountOptions(s, 'gone').at(-1)).toEqual({ value: 'gone', label: '—' });
  });
});

describe('buildFinanzas: el valor de useFinanzas()', () => {
  it('trae lo de shared/calc.ts ya calculado para el mes seleccionado', () => {
    const s = seedState();
    const f = build(s);
    expect(f.calc).toEqual(monthCalc(s, OCT));
    expect(f.rate).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect([f.main, f.second]).toEqual(['DOP', 'USD']);
    expect(f.balances).toEqual(balances(s, OCT));
    expect(f.rates).toEqual(pairRates(s, OCT));
    expect(f.leftover).toEqual(leftoverFor(s, OCT));
    expect(f.month).toBe(s.months[OCT]);
    expect(f.readOnly).toBe(false);
    expect(f.latestMonth).toBe(true);
  });

  it('las cuentas: todas, las visibles y la de por defecto', () => {
    const s = seedState();
    s.accounts.push({ id: 'old', name: 'Old', currency: 'USD', opening: 0, hidden: true, sort: -1 });
    const f = build(s);
    // En su orden (sort), también las ocultas.
    expect(f.accounts.map((a) => a.id)).toEqual(['old', 'us', 'dr']);
    expect(f.visibleAccounts.map((a) => a.id)).toEqual(['us', 'dr']);
    expect(f.defaultAccount!.id).toBe('dr');
    expect(f.accountOptions('old').map((o) => o.label)).toEqual(['US account', 'DR account', 'Old']);
    expect(build({ ...s, accounts: [] }).defaultAccount).toBeNull();
  });

  it('inBoth y rateOf usan el mes seleccionado salvo que se pida otro', () => {
    const f = build();
    expect(f.inBoth(100, 'USD')).toEqual({ main: 5876, second: 100 });
    const aug = rateFor(seedState(), '2026-08', 'USD', 'DOP');
    expect(f.inBoth(100, 'USD', '2026-08').main).toBeCloseTo(100 * aug.rate, 10);
    expect(f.rateOf('USD', 'DOP')).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect(f.rateOf('USD', 'DOP', '2026-08')).toEqual(aug);
    expect(f.rateOf('USD', 'TRY').source).toBe('default');
    expect(f.rateOf('DOP', 'DOP')).toEqual({ rate: 1, source: 'same', monthKey: null, date: null });
  });

  it('inBoth y rateOf con fecha: la tasa vigente ese día, no la última del mes', () => {
    const f = build(twoRates());
    expect(f.inBoth(100, 'USD')).toEqual({ main: 6000, second: 100 });
    expect(f.inBoth(100, 'USD', OCT, '2026-10-03')).toEqual({ main: 5800, second: 100 });
    expect(f.inBoth(100, 'USD', undefined, '2026-10-05').main).toBe(5800);
    expect(f.inBoth(100, 'USD', OCT, '2026-10-06').main).toBe(6000);
    expect(f.rateOf('USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect(f.rateOf('USD', 'DOP', OCT, '2026-10-05')).toEqual({ rate: 58, source: 'month', monthKey: OCT, date: '2026-10-01' });
    expect(f.rateOf('DOP', 'USD', undefined, '2026-10-05').rate).toBeCloseTo(1 / 58, 12);
    // La barra superior y la lista de tasas enseñan la última.
    expect(f.rate!.rate).toBe(60);
    expect(f.rates[0]).toMatchObject({ rate: 60, date: '2026-10-06' });
  });

  it('leftover: lo que sobró del mes anterior, en la moneda principal, y si ya se sumó', () => {
    const s = seedState();
    const sep = monthCalc(s, '2026-09').avail;
    expect(build(s).leftover).toEqual({ previousKey: '2026-09', leftover: sep, added: false });
    // Septiembre: 70,000 de presupuesto menos lo usado.
    expect(sep).toBeCloseTo(70000 - monthCalc(s, '2026-09').used, 8);
    expect(build(s, '2026-09').leftover).toMatchObject({ previousKey: '2026-08', added: false });
    // El primer mes no tiene anterior.
    expect(build(s, '2026-08').leftover).toEqual({ previousKey: null, leftover: null, added: false });

    // Ya sumado: el mes tiene su movimiento 'leftover'.
    const added = seedState();
    added.months[OCT]!.budgetLog.push({ id: 'lo', date: '2026-10-02', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    expect(build(added).leftover).toEqual({ previousKey: '2026-09', leftover: sep, added: true });
  });

  it('leftover: va en la moneda principal del usuario y puede ser negativo', () => {
    const usd = seedState();
    usd.mainCurrency = 'USD';
    usd.secondCurrency = 'DOP';
    expect(build(usd).leftover.leftover).toBeCloseTo(monthCalc(usd, '2026-09').avail, 10);
    expect(build(usd).leftover.leftover).not.toBeCloseTo(monthCalc(seedState(), '2026-09').avail, 0);

    const over = seedState();
    over.months['2026-09']!.budgetLog = [{ id: 'b', date: '2026-09-01', accountId: 'dr', amount: 1000, kind: 'initial', note: '' }];
    expect(build(over).leftover.leftover).toBeLessThan(0);
  });

  it('en un mes pasado: sus saldos, solo lectura si está cerrado, y sin corregir saldos', () => {
    const s = seedState();
    const f = build(s, '2026-09');
    expect(f.readOnly).toBe(true);
    expect(f.latestMonth).toBe(false);
    expect(f.balances).toEqual(balances(s, '2026-09'));
    expect(f.balances.totalMain).not.toBe(build(s).balances.totalMain);
    expect(f.rate!.source).toBe('transfers');
    // El último mes cuenta como tal aunque esté cerrado.
    s.months[OCT]!.closed = true;
    expect(build(s)).toMatchObject({ readOnly: true, latestMonth: true });
  });

  it('con otra moneda principal, todo lo calculado va en ella', () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    const f = build(s);
    expect([f.main, f.second]).toEqual(['TRY', 'USD']);
    expect(f.rate).toEqual({ rate: 40, source: 'month', monthKey: OCT, date: '2026-10-01' });
    expect(f.calc.budget).toBeCloseTo((70000 / 58.76) * 40, 6);
    expect(f.balances.totalMain).toBeCloseTo((13482 + 220641.93 / 58.76) * 40, 4);
    expect(f.inBoth(58.76, 'DOP').main).toBeCloseTo(40, 9);
  });

  it('la fecha de las filas de agregar: hoy si el mes seleccionado es el de hoy; si no, su día 1', () => {
    expect(build().draftDate).toBe('2026-10-07');
    expect(build(seedState(), '2026-09').draftDate).toBe('2026-09-01');
    expect(build(seedState(), OCT, '2026-11-02')).toMatchObject({ today: '2026-11-02', draftDate: '2026-10-01' });
  });

  it('un mes que no existe: null', () => {
    expect(buildFinanzas({ user: FRANK, state: seedState(), monthKey: '2030-01', today: '2026-10-07', actions })).toBeNull();
  });
});
