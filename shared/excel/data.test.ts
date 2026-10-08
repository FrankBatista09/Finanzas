// Pruebas del puente entre el estado de la app y el libro de Excel (data.ts): lo que sale hacia el generador
// (buildExportData) y lo que queda en el estado después de leer un libro (applyImportToState).
// Las cifras esperadas salen de shared/calc.ts o están escritas aquí; el generador y el lector se usan tal
// cual (sus propias pruebas son export*.test.ts e import.test.ts). Que el libro generado se recalcule sin
// errores en una hoja de cálculo de verdad lo comprueba export-libreoffice.test.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { frozenExportData } from '../../tests/reference-export';
import type { ImportMonth, ImportPayload } from '../api';
import { balances, contribIn, convert, goalsProgress, incomeInMonth, monthCalc, rateFor, sortedKeys } from '../calc';
import { f2 } from '../format';
import { seedState } from '../seed';
import type { Account, AppState, Currency, Goal, Language, Month } from '../types';
import { mixedState, newUserState } from './bridge-testkit';
import { BOOK_ACCOUNT_NAMES, IMPORTED_INCOME, applyImportToState, buildExportData } from './data';
import { EXCEL_LOCALES, buildFinanzasXlsx } from './export';
import { unzipText, xmlProblem } from './export-testkit';
import { parseFinanzasXlsx } from './import';
import type { ExportData, ExportMonth } from './types';

const LANGS: Language[] = ['en', 'es', 'tr'];
const KEYS = ['2026-08', '2026-09', '2026-10'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** El mismo valor con cada número cambiado por "más o menos ese número": para comparar con toEqual sin el ruido de la coma flotante. */
function approx<T>(value: T): T {
  if (typeof value === 'number') return expect.closeTo(value, 6) as T;
  if (Array.isArray(value)) return value.map(approx) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, approx(v)])) as T;
  return value;
}

/** Generador de ids repetible: a-1, a-2… */
function ids(prefix = 'new'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const n = (v: number | null | undefined) => v ?? 0;
/** Por fecha, sin cambiar el orden de las filas del mismo día: como escribe el generador el historial y los aportes. */
const byDate = <T extends { date: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.date.localeCompare(b.date));
const balanceOf = (state: AppState, id: string, asOf: string) => balances(state, asOf).accounts.find((a) => a.account.id === id)!.balance;
const exported = (data: ExportData, key: string) => data.months.find((m) => m.key === key)!;

// Lo que calculará el libro con esos datos (las fórmulas de la hoja del mes, export.ts): la tasa del mes es el
// promedio ponderado de sus envíos (o la tasa por defecto), y con ella convierte lo que está en USD.
const bookRate = (m: ExportMonth, defaultRate: number) => {
  const usd = m.transfers.reduce((a, t) => a + n(t.usd), 0);
  return usd ? m.transfers.reduce((a, t) => a + n(t.usd) * n(t.rate), 0) / usd : defaultRate;
};
const bookDOP = (row: { amount: number | null; cur: Currency }, rate: number) => (row.cur === 'USD' ? n(row.amount) * rate : n(row.amount));
const bookTotalDOP = (m: ExportMonth, rate: number) => n(m.accounts.usd) * rate + n(m.accounts.dop);

// ── Estado → libro ───────────────────────────────────────────────────────────

describe('buildExportData · datos de ejemplo', () => {
  const state = seedState();
  const data = buildExportData(state);

  it('salvo los saldos, es la misma entrada con la que se hizo el libro del diseño', () => {
    // En el diseño original los saldos se escribían a mano; ahora salen de los movimientos.
    const withoutBalances = (d: ExportData) => ({ ...d, months: d.months.map(({ accounts: _accounts, ...m }) => m) });
    // La entrada congelada no se toca: dice 'Card', el único método con tarjeta de entonces, que hoy es 'Debit card'.
    const frozen = frozenExportData('en');
    const today: ExportData = { ...frozen, months: frozen.months.map((m) => ({ ...m, tx: m.tx.map((t) => (t.method === 'Card' ? { ...t, method: 'Debit card' } : t)) })) };
    expect(frozen.months.flatMap((m) => m.tx).filter((t) => t.method === 'Card')).toHaveLength(23);
    expect(withoutBalances(data)).toEqual(withoutBalances(today));
    expect(data.months.map((m) => m.key)).toEqual(sortedKeys(state));
    expect(data.defaultRate).toBe(state.defaultRate);
  });

  it.each(KEYS)('%s: presupuesto en DOP, ingreso en USD, saldos y filas como en shared/calc.ts', (key) => {
    const m = exported(data, key);
    const c = monthCalc(state, key);
    const b = balances(state, key);
    // La moneda principal de los datos de ejemplo es DOP: el presupuesto del mes ya está en DOP.
    expect(c.main).toBe('DOP');
    expect(m.budget).toBe(c.budget);
    expect(m.incomeUSD).toBe(incomeInMonth(state, key, 'USD'));
    expect(n(m.incomeUSD) * c.rate.rate).toBeCloseTo(c.income, 6);
    expect(m.accounts).toEqual({ usd: balanceOf(state, 'us', key), dop: balanceOf(state, 'dr', key) });

    // El libro llega a la misma tasa y, con ella, al mismo dinero total y a los mismos gastos.
    const rate = bookRate(m, data.defaultRate);
    expect(rate).toBeCloseTo(c.rate.rate, 10);
    expect(bookTotalDOP(m, rate)).toBeCloseTo(b.totalMain, 6);
    expect(n(m.accounts.usd) + n(m.accounts.dop) / rate).toBeCloseTo(b.totalSecond, 6);
    expect(m.fixed).toHaveLength(c.fixedCount);
    expect(m.fixed.filter((f) => f.paid)).toHaveLength(c.paidCount);
    expect(m.fixed.filter((f) => f.paid).reduce((a, f) => a + bookDOP(f, rate), 0)).toBeCloseTo(c.fixedPaid, 6);
    expect(m.fixed.filter((f) => !f.paid).reduce((a, f) => a + bookDOP(f, rate), 0)).toBeCloseTo(c.pending, 6);
    expect(m.tx).toHaveLength(c.txCount);
    expect(m.tx.reduce((a, t) => a + bookDOP(t, rate), 0)).toBeCloseTo(c.varSpent, 6);
    expect(m.transfers).toEqual(state.months[key]!.transfers.map((t) => ({ date: t.date, via: t.via, usd: t.amount, rate: t.rate })));
  });

  it('cifras escritas a mano', () => {
    expect(data.months.map((m) => [m.key, m.budget, m.incomeUSD, m.accounts.usd, f2(n(m.accounts.dop))])).toEqual([
      ['2026-08', 70000, 5800, 5894, '101,129.74'],
      ['2026-09', 70000, 5800, 9288, '175,423.08'],
      ['2026-10', 70000, 5800, 13482, '220,641.93'],
    ]);
    expect(f2(bookTotalDOP(exported(data, '2026-10'), 58.76))).toBe('1,012,844.25');
    const oct = exported(data, '2026-10');
    expect(oct.fixed[4]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: true });
    expect(oct.tx[6]).toEqual({ date: '2026-10-07', desc: 'Coffee', place: 'Starbucks Ágora', cat: 'Food', method: 'Debit card', amount: 385, cur: 'DOP', notes: '' });
    expect(data.goals[2]).toEqual({ name: 'Trip to Turkey', monthlyUSD: 3000, start: '2026-08', end: '2027-10' });
    expect(data.contribs).toHaveLength(8);
  });

  it('los fijos salen en su orden (sort), no en el del arreglo', () => {
    const s = seedState();
    s.months['2026-10']!.fixed.reverse();
    expect(buildExportData(s)).toEqual(data);
  });

  it('una tasa escrita a mano no viaja: el libro calcula la suya con los envíos del mes', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-01' }];
    const oct = exported(buildExportData(s), '2026-10');
    expect(rateFor(s, '2026-10', 'USD', 'DOP').rate).toBe(60);
    expect(bookRate(oct, s.defaultRate)).toBe(58.76);
    // Los saldos son los mismos; lo que cambia es a cuánto los convierte cada uno.
    expect(oct.accounts).toEqual(exported(data, '2026-10').accounts);
    expect(balances(s, '2026-10').totalMain - bookTotalDOP(oct, 58.76)).toBeCloseTo(13482 * (60 - 58.76), 6);
  });

  it('no modifica el estado', () => {
    const frozen = deepFreeze(seedState());
    expect(buildExportData(frozen)).toEqual(data);
    expect(frozen).toEqual(seedState());
  });
});

describe('buildExportData · lo que el libro no sabe representar (TRY, más cuentas, cuentas ocultas)', () => {
  const state = mixedState();
  const data = buildExportData(state);
  const toDOP = (key: string, amount: number, cur: Currency) => convert(state, key, amount, cur, 'DOP');
  const toUSD = (key: string, amount: number, cur: Currency) => convert(state, key, amount, cur, 'USD');

  it('premisa: moneda principal TRY, cuentas en las tres monedas, dos ocultas y tasas de todo tipo', () => {
    expect([state.mainCurrency, state.secondCurrency]).toEqual(['TRY', 'DOP']);
    expect(state.accounts.map((a) => `${a.id}:${a.currency}${a.hidden ? ':hidden' : ''}`)).toEqual([
      'us:USD', 'dr:DOP', 'tr:TRY', 'pp:USD', 'cash:DOP', 'old:USD:hidden', 'box:DOP:hidden',
    ]);
    const sources = (key: string) => [rateFor(state, key, 'USD', 'DOP').source, rateFor(state, key, 'USD', 'TRY').source, rateFor(state, key, 'TRY', 'DOP').source];
    expect(KEYS.map(sources)).toEqual([
      ['transfers', 'month', 'cross'],
      ['transfers', 'month', 'cross'],
      ['transfers', 'month', 'transfers'],
    ]);
  });

  it('en el libro solo hay DOP y USD', () => {
    const curs = new Set([...data.months.flatMap((m) => [...m.fixed, ...m.tx].map((r) => r.cur)), ...data.contribs.map((c) => c.cur)]);
    expect([...curs].sort()).toEqual(['DOP', 'USD']);
  });

  it('gastos fijos en TRY: el monto convertido a DOP con la tasa del mes; los demás, tal cual', () => {
    const oct = exported(data, '2026-10');
    expect(oct.fixed).toHaveLength(13);
    expect(oct.fixed.slice(0, 11)).toEqual(exported(buildExportData(seedState()), '2026-10').fixed);
    expect(oct.fixed.slice(11)).toEqual([
      { name: 'Turkcell', day: '12', amount: toDOP('2026-10', 350, 'TRY'), cur: 'DOP', paid: true },
      { name: 'Istanbul gym', day: '', amount: toDOP('2026-10', 900, 'TRY'), cur: 'DOP', paid: false },
    ]);
    expect(n(oct.fixed[11]!.amount)).toBeCloseTo(350 * 1.4495168277, 6);
  });

  it('transacciones en TRY: convertidas a DOP, con el monto original al final de las notas', () => {
    const oct = exported(data, '2026-10');
    expect(oct.tx.slice(7)).toEqual([
      { date: '2026-10-08', desc: 'Seat selection', place: '', cat: 'Travel', method: 'Debit card', amount: toDOP('2026-10', 2400.5, 'TRY'), cur: 'DOP', notes: 'Turkish Airlines · TRY 2,400.50' },
      // La paga la cuenta en DOP, pero el gasto es en TRY: también se convierte.
      { date: '2026-10-09', desc: 'Gift for Eda', place: '', cat: 'Home', method: 'Debit card', amount: toDOP('2026-10', 600, 'TRY'), cur: 'DOP', notes: 'TRY 600.00' },
      { date: '2026-10-09', desc: 'Domain', place: '', cat: 'Subscriptions', method: 'Debit card', amount: 12.5, cur: 'USD', notes: '' },
      { date: '2026-10-10', desc: 'Snacks', place: '', cat: 'Food', method: 'Debit card', amount: 200, cur: 'DOP', notes: '' },
    ]);
    // Cada mes con su tasa: la de septiembre no es la de octubre.
    const baklava = exported(data, '2026-09').tx[10]!;
    expect(baklava).toMatchObject({ desc: 'Baklava', cur: 'DOP', notes: 'TRY 1,250.00', amount: toDOP('2026-09', 1250, 'TRY') });
    expect(rateFor(state, '2026-09', 'TRY', 'DOP').rate).not.toBeCloseTo(rateFor(state, '2026-10', 'TRY', 'DOP').rate, 3);
  });

  it('envíos: solo los que van entre USD y DOP; el de vuelta, como los USD que entraron a la tasa inversa', () => {
    // Agosto: los dos de siempre. Septiembre: fuera USD → TRY, TRY → USD y USD → USD.
    expect(exported(data, '2026-08').transfers).toHaveLength(2);
    expect(state.months['2026-09']!.transfers).toHaveLength(5);
    expect(exported(data, '2026-09').transfers).toEqual([
      { date: '2026-09-02', via: 'Remitly', usd: 1500, rate: 58.55 },
      { date: '2026-09-17', via: 'Remitly', usd: 800, rate: 58.62 },
    ]);
    // Octubre: fuera TRY → DOP, DOP → TRY y DOP → DOP. El que sale de una cuenta oculta en USD sí va.
    expect(state.months['2026-10']!.transfers).toHaveLength(6);
    expect(exported(data, '2026-10').transfers).toEqual([
      { date: '2026-10-02', via: 'Remitly', usd: 1500, rate: 58.76 },
      { date: '2026-10-04', via: 'Bank', usd: expect.closeTo(200, 9), rate: expect.closeTo(58.5, 9) },
      { date: '2026-10-05', via: 'Remitly', usd: 50, rate: 58.9 },
    ]);
  });

  it.each(KEYS)('%s: con esos envíos el libro calcula la misma tasa del mes que la app', (key) => {
    const info = rateFor(state, key, 'USD', 'DOP');
    expect(info.source).toBe('transfers');
    expect(bookRate(exported(data, key), data.defaultRate)).toBeCloseTo(info.rate, 9);
  });

  it('saldos: las cuentas visibles en DOP por un lado y las demás, en USD, por el otro', () => {
    for (const key of KEYS) {
      const bal = (id: string) => balanceOf(state, id, key);
      const m = exported(data, key);
      expect(m.accounts.dop, key).toBeCloseTo(bal('dr') + bal('cash'), 6);
      expect(m.accounts.usd, key).toBeCloseTo(bal('us') + bal('pp') + toUSD(key, bal('tr'), 'TRY'), 6);
    }
    // Octubre, a mano: US 12,932 + PayPal 637.83 + TR 82,750.50 TRY; DR 206,567.22 + Cash 16,000.
    expect(f2(balanceOf(state, 'tr', '2026-10'))).toBe('82,750.50');
    expect(f2(n(exported(data, '2026-10').accounts.dop))).toBe('222,567.22');
    expect(n(exported(data, '2026-10').accounts.usd)).toBeCloseTo(12932 + 637.83 + 82750.5 * rateFor(state, '2026-10', 'TRY', 'USD').rate, 6);
  });

  it('las cuentas ocultas no entran en los saldos; al mostrarlas, sí', () => {
    const shown = mixedState();
    for (const a of shown.accounts) a.hidden = false;
    const all = exported(buildExportData(shown), '2026-10');
    const oct = exported(data, '2026-10');
    expect(n(all.accounts.usd) - n(oct.accounts.usd)).toBeCloseTo(balanceOf(state, 'old', '2026-10'), 6);
    expect(n(all.accounts.dop) - n(oct.accounts.dop)).toBeCloseTo(balanceOf(state, 'box', '2026-10'), 6);
    expect([balanceOf(state, 'old', '2026-10'), balanceOf(state, 'box', '2026-10')]).toEqual([989, 1034]);
    // Y al ocultar una visible, sale.
    const less = mixedState();
    less.accounts.find((a) => a.id === 'tr')!.hidden = true;
    expect(exported(buildExportData(less), '2026-10').accounts.usd).toBeCloseTo(12932 + 637.83, 6);
  });

  it.each(KEYS)('%s: el dinero total del libro es el de la app, expresado en DOP', (key) => {
    const m = exported(data, key);
    const b = balances(state, key);
    const rate = bookRate(m, data.defaultRate);
    expect(bookTotalDOP(m, rate)).toBeCloseTo(convert(state, key, b.totalMain, state.mainCurrency, 'DOP'), 5);
    // La segunda moneda de este usuario es DOP: es el "≈" de su pantalla.
    expect(bookTotalDOP(m, rate)).toBeCloseTo(b.totalSecond, 5);
    // Y en USD, como lo muestra la segunda línea del libro.
    expect(n(m.accounts.usd) + n(m.accounts.dop) / rate).toBeCloseTo(convert(state, key, b.totalMain, state.mainCurrency, 'USD'), 6);
  });

  it('presupuesto: la suma de las partes por cuenta, en DOP con las tasas del mes', () => {
    expect(exported(data, '2026-08').budget).toBe(70000);
    // La parte de una cuenta oculta cuenta, igual que en el presupuesto de la app.
    expect(exported(data, '2026-09').budget).toBeCloseTo(70000 + toDOP('2026-09', 25, 'USD'), 8);
    expect(exported(data, '2026-10').budget).toBeCloseTo(60000 + toDOP('2026-10', 100, 'USD') + toDOP('2026-10', 4000, 'TRY'), 8);
    for (const key of KEYS) {
      const c = monthCalc(state, key);
      expect(c.main).toBe('TRY');
      expect(exported(data, key).budget, key).toBeCloseTo(convert(state, key, c.budget, 'TRY', 'DOP'), 6);
      // El mismo usuario con DOP como moneda principal ve ese número tal cual.
      expect(exported(data, key).budget, key).toBe(monthCalc({ ...state, mainCurrency: 'DOP', secondCurrency: 'USD' }, key).budget);
    }
  });

  it('ingreso del mes: los ingresos con fecha en él, en USD', () => {
    expect(exported(data, '2026-08').incomeUSD).toBe(5800);
    expect(exported(data, '2026-09').incomeUSD).toBeCloseTo(5800 + toUSD('2026-09', 8000, 'DOP'), 8);
    // Cuenta también el que entró a una cuenta oculta; el de noviembre no tiene mes en el que salir.
    expect(exported(data, '2026-10').incomeUSD).toBeCloseTo(5800 + toUSD('2026-10', 20000, 'TRY') + 40, 8);
    for (const key of KEYS) {
      expect(exported(data, key).incomeUSD, key).toBeCloseTo(convert(state, key, monthCalc(state, key).income, 'TRY', 'USD'), 6);
    }
    expect(data.months.map((m) => m.key)).toEqual(KEYS);
  });

  it('aportes: DOP y USD tal cual; en TRY, convertidos a USD con la tasa del mes de su fecha', () => {
    expect(data.contribs).toHaveLength(13);
    expect(data.contribs.slice(0, 8)).toEqual(frozenExportData('en').contribs);
    expect(data.contribs.slice(8)).toEqual([
      { date: '2026-09-10', goalName: 'Istanbul flat', amount: toUSD('2026-09', 4000, 'TRY'), cur: 'USD' },
      { date: '2026-10-05', goalName: 'Istanbul flat', amount: 100, cur: 'USD' },
      { date: '2026-10-06', goalName: 'Istanbul flat', amount: 2938, cur: 'DOP' },
      { date: '2026-10-07', goalName: 'Emergency fund', amount: toUSD('2026-10', 420, 'TRY'), cur: 'USD' },
      { date: '2026-10-07', goalName: 'Gifts', amount: 1500, cur: 'DOP' },
    ]);
    // Lo ahorrado en cada meta, en USD, es lo mismo que suma la app (el libro divide los DOP entre su tasa del mes).
    for (const goal of state.goals) {
      const inBook = data.contribs
        .filter((c) => c.goalName === goal.name)
        .reduce((a, c) => a + (c.cur === 'USD' ? c.amount : c.amount / bookRate(exported(data, c.date.slice(0, 7)), data.defaultRate)), 0);
      const inApp = state.contribs.filter((c) => c.goalId === goal.id).reduce((a, c) => a + contribIn(state, c, 'USD'), 0);
      expect(inBook, goal.name).toBeCloseTo(inApp, 6);
    }
  });

  it('metas: las de USD tal cual; las de otra moneda, con el ahorro mensual en USD a la tasa del mes en curso', () => {
    expect(data.goals).toEqual([
      { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
      { name: 'Personal savings', monthlyUSD: null, start: null, end: null },
      { name: 'Trip to Turkey', monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
      { name: 'Istanbul flat', monthlyUSD: toUSD('2026-10', 10000, 'TRY'), start: '2026-09', end: '2027-08' },
      { name: 'Gifts', monthlyUSD: null, start: null, end: null },
      // Un plan a medias (sin mes final) no es un plan.
      { name: 'Half plan', monthlyUSD: null, start: null, end: null },
    ]);
    const flat = goalsProgress(state).find((g) => g.id === 'flat')!;
    expect(n(data.goals[3]!.monthlyUSD) * 12).toBeCloseTo(toUSD('2026-10', flat.target!.targetAmount, 'TRY'), 6);
  });

  it('no depende de la moneda principal ni de la segunda', () => {
    expect(buildExportData({ ...state, mainCurrency: 'DOP', secondCurrency: 'USD' })).toEqual(data);
    expect(buildExportData({ ...state, mainCurrency: 'USD', secondCurrency: 'TRY' })).toEqual(data);
  });

  it('no modifica el estado', () => {
    const frozen = deepFreeze(mixedState());
    expect(buildExportData(frozen)).toEqual(data);
    expect(frozen).toEqual(mixedState());
  });

  it.each(LANGS)('el generador lo acepta en "%s" y el lector devuelve los mismos datos', (lang) => {
    const bytes = buildFinanzasXlsx(deepFreeze(structuredClone(data)), { locale: EXCEL_LOCALES[lang] });
    for (const [path, xml] of unzipText(bytes)) expect(xmlProblem(xml), path).toBeNull();
    const payload = parseFinanzasXlsx(bytes);
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([['2026-08', true], ['2026-09', true], ['2026-10', false]]);
    payload.months.forEach((m, i) => {
      const sent = data.months[i]!;
      expect([m.budget, m.incomeUSD, m.accounts], m.key).toEqual([sent.budget, sent.incomeUSD, sent.accounts]);
      expect(m.fixed, m.key).toEqual(sent.fixed);
      expect(m.transfers, m.key).toEqual(sent.transfers);
      // El libro ordena el historial por fecha (el Baklava de septiembre estaba al final).
      expect(m.tx, m.key).toEqual(byDate(sent.tx));
    });
    expect(payload.goals).toEqual(data.goals);
    expect(payload.contribs).toEqual(byDate(data.contribs));
  });
});

describe('buildExportData · casos límite', () => {
  it('sin meses: no hay hojas de mes, y una meta en otra moneda se convierte con la tasa de respaldo', () => {
    const state: AppState = { ...newUserState(), months: {} };
    state.goals.push({ id: 'tr', name: 'Bosphorus', cur: 'TRY', monthly: 4200, start: '2027-01', end: '2027-12', approxCur: null, sort: 2 });
    state.contribs.push({ id: 'c1', goalId: 'tr', date: '2027-01-05', amount: 840, cur: 'TRY' }, { id: 'c2', goalId: 'gone', date: '2027-01-06', amount: 5, cur: 'DOP' });
    expect(rateFor(state, '2027-01', 'TRY', 'USD')).toEqual({ rate: 1 / 42, source: 'default', monthKey: null, date: null });
    expect(buildExportData(state)).toEqual({
      months: [],
      goals: [
        { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
        { name: 'Personal savings', monthlyUSD: null, start: null, end: null },
        { name: 'Bosphorus', monthlyUSD: expect.closeTo(100, 9), start: '2027-01', end: '2027-12' },
      ],
      contribs: [
        { date: '2027-01-05', goalName: 'Bosphorus', amount: expect.closeTo(20, 9), cur: 'USD' },
        // Un aporte a una meta que ya no existe sale con su id en el sitio del nombre.
        { date: '2027-01-06', goalName: 'gone', amount: 5, cur: 'DOP' },
      ],
      defaultRate: 58.76,
    });
    // El generador hace con eso la plantilla vacía.
    expect(parseFinanzasXlsx(buildFinanzasXlsx(buildExportData(state), { currentKey: '2026-10' })).months.map((m) => m.key)).toEqual(['2026-10']);
  });

  it('un mes vacío de un usuario nuevo: todo en cero', () => {
    expect(buildExportData(newUserState()).months).toEqual([
      { key: '2026-10', budget: 0, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] },
    ]);
    // Sin cuentas tampoco falla.
    expect(buildExportData({ ...newUserState(), accounts: [] }).months[0]!.accounts).toEqual({ usd: 0, dop: 0 });
  });

  it('si las tasas del mes no cuadran entre sí, el dinero total del libro y el de la app difieren justo en eso', () => {
    // Una cuenta en TRY sin ninguna tasa para TRY: en agosto USD→DOP sale de los envíos (58.18), pero TRY→USD y
    // TRY→DOP son las de respaldo (1/42 y 58.76/42), que no pasan por esa tasa.
    const state = seedState();
    state.accounts.push({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 42000, hidden: false, sort: 2 });
    const aug = exported(buildExportData(state), '2026-08');
    const rate = rateFor(state, '2026-08', 'USD', 'DOP').rate;
    expect([rateFor(state, '2026-08', 'TRY', 'USD').source, rateFor(state, '2026-08', 'TRY', 'DOP').source]).toEqual(['default', 'default']);
    // El libro recibe 42,000 TRY como 1,000 USD y los pasa a DOP con la tasa del mes; la app, con la de respaldo.
    expect(aug.accounts.usd).toBeCloseTo(5894 + 1000, 8);
    expect(bookRate(aug, state.defaultRate)).toBeCloseTo(rate, 10);
    expect(balances(state, '2026-08').totalMain - bookTotalDOP(aug, rate)).toBeCloseTo(1000 * (58.76 - rate), 6);
    // Con una tasa escrita para TRY ese mes, vuelve a cuadrar. (Un estado nuevo: calc memoriza las tasas por objeto.)
    const typed = seedState();
    typed.accounts.push({ ...state.accounts[2]! });
    typed.months['2026-08']!.rates = [{ from: 'USD', to: 'TRY', rate: 42, date: '2026-08-01' }];
    expect(rateFor(typed, '2026-08', 'TRY', 'DOP').source).toBe('cross');
    expect(bookTotalDOP(exported(buildExportData(typed), '2026-08'), rate)).toBeCloseTo(balances(typed, '2026-08').totalMain, 6);
  });

  it('un envío con una cuenta que ya no existe no sale; uno de vuelta con tasa 0 no deja un infinito', () => {
    const state = seedState();
    const [first] = state.months['2026-10']!.transfers;
    state.months['2026-10']!.transfers.push(
      { ...first!, id: 'ghost', fromAccountId: 'gone' },
      { ...first!, id: 'zero', fromAccountId: 'dr', toAccountId: 'us', amount: 500, rate: 0 },
    );
    expect(exported(buildExportData(state), '2026-10').transfers).toEqual([
      { date: '2026-10-02', via: 'Remitly', usd: 1500, rate: 58.76 },
      { date: '2026-10-02', via: 'Remitly', usd: 0, rate: 0 },
    ]);
  });
});

// ── Libro → estado ───────────────────────────────────────────────────────────

const V3 = parseFinanzasXlsx(new Uint8Array(readFileSync(new URL('../../design_handoff/referencia/Finanzas Personales v3.xlsx', import.meta.url))));

/** El estado sin los ids de las filas que una importación vuelve a crear (las de los meses y los aportes). */
function content(state: AppState) {
  const rows = <T extends { id: string }>(list: readonly T[]) => list.map(({ id: _id, ...row }) => row);
  return {
    ...state,
    contribs: rows(state.contribs),
    months: Object.fromEntries(
      Object.entries(state.months).map(([key, m]) => [key, { ...m, fixed: rows(m.fixed), transfers: rows(m.transfers), tx: rows(m.tx) }]),
    ),
  };
}

const importMonth = (key: string, over: Partial<ImportMonth> = {}): ImportMonth => ({
  key,
  closed: false,
  budget: 50000,
  incomeUSD: 0,
  accounts: { usd: 1000, dop: 20000 },
  fixed: [],
  transfers: [],
  tx: [],
  ...over,
});

const payloadOf = (months: ImportMonth[], over: Partial<ImportPayload> = {}): ImportPayload => ({ months, contribs: null, goals: null, ...over });

const imported = (state: AppState) => state.incomes.filter((i) => i.desc === IMPORTED_INCOME);

describe('applyImportToState · Finanzas Personales v3.xlsx en un usuario nuevo', () => {
  const base = newUserState();
  const state = applyImportToState(base, V3, ids());

  it('premisa: el libro trae tres meses, el último abierto, con los saldos escritos en cada uno', () => {
    expect(V3.months.map((m) => [m.key, m.closed, m.budget, m.incomeUSD, m.accounts.usd, m.accounts.dop])).toEqual([
      ['2026-08', true, 70000, 5800, 3900, 78200],
      ['2026-09', true, 70000, 5800, 4100, 81500],
      ['2026-10', false, 70000, 5800, 4320, 86400],
    ]);
  });

  it('los meses del libro, con todo el presupuesto en la cuenta en DOP y sin tasas escritas', () => {
    expect(sortedKeys(state)).toEqual(KEYS);
    expect(KEYS.map((k) => [state.months[k]!.closed, state.months[k]!.closedAt])).toEqual([[true, null], [true, null], [false, null]]);
    for (const key of KEYS) {
      const m = state.months[key]!;
      expect(m.key).toBe(key);
      expect(m.budgets, key).toEqual({ dr: 70000 });
      expect(m.rates, key).toEqual([]);
      expect(monthCalc(state, key).budget, key).toBe(70000);
    }
  });

  it('fijos y transacciones: desde la cuenta en USD los que son en USD y desde la de DOP el resto', () => {
    V3.months.forEach((file) => {
      const m = state.months[file.key]!;
      expect(m.fixed.map(({ id: _id, monthKey: _key, accountId: _account, sort: _sort, ...f }) => f), file.key).toEqual(file.fixed);
      expect(m.fixed.map((f) => f.sort)).toEqual(file.fixed.map((_f, i) => i));
      expect(m.fixed.map((f) => f.accountId)).toEqual(file.fixed.map((f) => (f.cur === 'USD' ? 'us' : 'dr')));
      expect(m.fixed.filter((f) => f.accountId === 'us').map((f) => f.name)).toEqual(['Claude']);
      expect(m.tx.map(({ id: _id, monthKey: _key, accountId: _account, source: _source, createdAt: _at, ...t }) => t), file.key).toEqual(file.tx);
      expect(m.tx.every((t) => t.source === 'import' && t.createdAt === null && t.accountId === 'dr' && t.monthKey === file.key)).toBe(true);
    });
    // Cada fila creada tiene su propio id.
    const all = KEYS.flatMap((k) => [...state.months[k]!.fixed, ...state.months[k]!.tx, ...state.months[k]!.transfers].map((r) => r.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(33 + 27 + 5);
  });

  it('cada envío del libro va de la cuenta en USD a la de DOP', () => {
    expect(state.months['2026-08']!.transfers.map(({ id: _id, ...t }) => t)).toEqual([
      { monthKey: '2026-08', date: '2026-08-03', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1500, rate: 58.4, budget: false },
      { monthKey: '2026-08', date: '2026-08-18', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 300, rate: 57.1, budget: false },
    ]);
    // Sin tasa escrita, la del mes sale de esos envíos, como en el libro.
    expect(rateFor(state, '2026-08', 'USD', 'DOP')).toEqual({ rate: (1500 * 58.4 + 300 * 57.1) / 1800, source: 'transfers', monthKey: '2026-08', date: null });
    expect(rateFor(state, '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
  });

  it('el ingreso de cada mes pasa a ser un ingreso en USD el día 1, a la cuenta en USD', () => {
    expect(state.incomes.map(({ id: _id, ...i }) => i)).toEqual(
      KEYS.map((key) => ({ date: `${key}-01`, desc: 'Income (imported)', accountId: 'us', amount: 5800, cur: 'USD', budget: false })),
    );
    expect(IMPORTED_INCOME).toBe('Income (imported)');
    for (const key of KEYS) expect(incomeInMonth(state, key, 'USD'), key).toBe(5800);
  });

  it('los saldos al final del último mes son los del libro', () => {
    expect(balanceOf(state, 'us', '2026-10')).toBeCloseTo(4320, 8);
    expect(balanceOf(state, 'dr', '2026-10')).toBeCloseTo(86400, 8);
    // El dinero total, el del diseño original: 4,320 × 58.76 + 86,400.
    expect(f2(balances(state, '2026-10').totalMain)).toBe('340,243.20');
    // Para eso se mueve el saldo inicial: lo que dice el libro menos todo lo que entró y salió.
    expect(state.accounts.map((a) => [a.id, a.name, a.currency, a.hidden, a.sort])).toEqual([
      ['us', 'US account', 'USD', false, 0],
      ['dr', 'DR account', 'DOP', false, 1],
    ]);
    expect(state.accounts[0]!.opening).toBeCloseTo(4320 - (3 * 5800 - 5600 - 3 * 106), 8);
    expect(state.accounts[1]!.opening).toBeCloseTo(86400 - (327591 - 63250 - 103699.07), 6);
    // Los saldos que el libro traía escritos para los meses anteriores no se usan: salen de los movimientos.
    expect(balanceOf(state, 'us', '2026-08')).toBeCloseTo(-7162 + 5800 - 1800 - 106, 8);
  });

  it('el mes queda con las cifras del diseño', () => {
    const c = monthCalc(state, '2026-10');
    expect([c.paidCount, c.fixedCount, c.txCount]).toEqual([6, 11, 7]);
    expect([f2(c.fixedAll), f2(c.used), f2(c.avail), f2(c.pending), f2(c.after)]).toEqual(['42,025.57', '49,149.71', '20,850.29', '3,720.86', '17,129.43']);
    expect(c.income).toBeCloseTo(5800 * 58.76, 8);
  });

  it('metas y aportes: las tres del libro (dos ya las tenía) y sus ocho aportes', () => {
    expect(state.goals).toEqual([
      { id: 'emergency', name: 'Emergency fund', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 0 },
      { id: 'personal', name: 'Personal savings', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 1 },
      { id: expect.stringMatching(/^new-\d+$/), name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10', approxCur: null, sort: 2 },
    ]);
    expect(state.contribs).toHaveLength(8);
    expect(goalsProgress(state).map((g) => [g.name, g.saved, g.contribCount])).toEqual([
      ['Emergency fund', 1200, 3],
      ['Personal savings', 450, 2],
      ['Trip to Turkey', 9000, 3],
    ]);
  });

  it('los ajustes no cambian y el usuario de partida queda intacto', () => {
    const { months: _m, accounts: _a, incomes: _i, goals: _g, contribs: _c, ...settings } = state;
    const { months: _bm, accounts: _ba, incomes: _bi, goals: _bg, contribs: _bc, ...before } = base;
    expect(settings).toEqual(before);
    expect(base).toEqual(newUserState());
  });

  it('volver a importar el mismo libro no cambia nada', () => {
    const again = applyImportToState(state, V3, ids('again'));
    expect(content(again)).toEqual(content(state));
    // Cuentas (con su saldo inicial), ingresos y metas, idénticos también en sus ids.
    expect(again.accounts).toEqual(state.accounts);
    expect(again.incomes).toEqual(state.incomes);
    expect(again.goals).toEqual(state.goals);
    expect(applyImportToState(again, V3, ids('third')).accounts).toEqual(state.accounts);
  });
});

describe('applyImportToState · Finanzas Personales v3.xlsx en el usuario de ejemplo', () => {
  const base = seedState();
  const state = applyImportToState(base, V3, ids());

  it('los tres meses se sustituyen por los del libro', () => {
    expect(sortedKeys(state)).toEqual(KEYS);
    for (const file of V3.months) {
      const m = state.months[file.key]!;
      expect(m.tx.map((t) => [t.date, t.desc, t.amount, t.source]), file.key).toEqual(file.tx.map((t) => [t.date, t.desc, t.amount, 'import']));
      expect(m.fixed.map((f) => f.name), file.key).toEqual(file.fixed.map((f) => f.name));
      expect(m.rates).toEqual([]);
    }
    // Los textos del libro (en español) sustituyen a los de ejemplo, y las tasas escritas de octubre desaparecen.
    expect(state.months['2026-10']!.fixed[0]!.name).toBe('Luz');
    expect(base.months['2026-10']!.rates).toHaveLength(2);
  });

  it('los saldos al final del último mes son los del libro, no los que tenía', () => {
    expect([balanceOf(base, 'us', '2026-10'), f2(balanceOf(base, 'dr', '2026-10'))]).toEqual([13482, '220,641.93']);
    expect(balanceOf(state, 'us', '2026-10')).toBeCloseTo(4320, 8);
    expect(balanceOf(state, 'dr', '2026-10')).toBeCloseTo(86400, 8);
    expect(f2(balances(state, '2026-10').totalMain)).toBe('340,243.20');
  });

  it('los ingresos que el usuario ya tenía se conservan y no se cuentan dos veces: el libro trae el total del mes', () => {
    // Los 5,800 USD del libro ya están registrados como "Salary": no falta nada, así que no se crea ningún ingreso.
    expect(state.incomes).toEqual(base.incomes);
    expect(imported(state)).toEqual([]);
    for (const k of KEYS) expect(incomeInMonth(state, k, 'USD')).toBe(5800);
  });

  it('las metas se reconocen por su nombre de hoy (no se duplican) y los aportes son los del libro', () => {
    expect(state.goals).toEqual(base.goals);
    expect(content(state).contribs).toEqual(content(base).contribs);
  });

  it('volver a importar el mismo libro no cambia nada', () => {
    const again = applyImportToState(state, V3, ids('again'));
    expect(content(again)).toEqual(content(state));
    expect(again.accounts).toEqual(state.accounts);
    expect(again.incomes).toEqual(state.incomes);
    expect(again.goals).toEqual(state.goals);
  });

  it('no modifica el estado de partida', () => {
    const frozen = deepFreeze(seedState());
    expect(content(applyImportToState(frozen, V3, ids()))).toEqual(content(state));
    expect(frozen).toEqual(seedState());
    expect(base).toEqual(seedState());
  });
});

describe('applyImportToState · meses', () => {
  it('los meses que no vienen en el archivo no se tocan, y los saldos del último importado salen igual', () => {
    const base = seedState();
    const july: Month = {
      key: '2026-07',
      closed: true,
      closedAt: '2026-08-01T04:00:00.000Z',
      budgetLog: [
        { id: 'july-dr', date: '2026-07-01', accountId: 'dr', amount: 50000, kind: 'initial', note: '' },
        { id: 'july-us', date: '2026-07-01', accountId: 'us', amount: 20, kind: 'initial', note: '' },
      ],
      budgets: { dr: 50000, us: 20 },
      rates: [{ from: 'USD', to: 'DOP', rate: 59.1, date: '2026-07-01' }],
      fixed: [],
      transfers: [],
      tx: [{ ...base.months['2026-08']!.tx[0]!, id: 'july-1', monthKey: '2026-07', date: '2026-07-15', amount: 9999 }],
    };
    const november: Month = { ...july, key: '2026-11', closed: false, closedAt: null, tx: [{ ...july.tx[0]!, id: 'nov-1', monthKey: '2026-11', date: '2026-11-02', amount: 4321 }] };
    base.months['2026-07'] = july;
    base.months['2026-11'] = november;
    deepFreeze(base);

    const state = applyImportToState(base, V3, ids());
    expect(sortedKeys(state)).toEqual(['2026-07', ...KEYS, '2026-11']);
    // Son los mismos objetos: ni una copia.
    expect(state.months['2026-07']).toBe(july);
    expect(state.months['2026-11']).toBe(november);
    // El gasto de julio sigue contando; el saldo inicial lo absorbe para que octubre termine como dice el libro.
    expect(balanceOf(state, 'us', '2026-10')).toBeCloseTo(4320, 8);
    expect(balanceOf(state, 'dr', '2026-10')).toBeCloseTo(86400, 8);
    expect(balanceOf(state, 'dr', '2026-11')).toBeCloseTo(86400 - 4321, 8);

    // Importar un solo mes deja los otros dos de ejemplo como estaban.
    const one = applyImportToState(base, payloadOf([V3.months[1]!]), ids());
    expect(one.months['2026-08']).toBe(base.months['2026-08']);
    expect(one.months['2026-10']).toBe(base.months['2026-10']);
    expect(one.months['2026-09']).not.toBe(base.months['2026-09']);
    expect(balanceOf(one, 'us', '2026-09')).toBeCloseTo(4100, 8);
    expect(balanceOf(one, 'dr', '2026-09')).toBeCloseTo(81500, 8);
  });

  it('un mes sustituido pierde lo que tenía: filas, tasas y reparto del presupuesto', () => {
    const base = mixedState();
    const state = applyImportToState(base, payloadOf([importMonth('2026-10', { budget: 65000, fixed: [{ name: 'Luz', day: '', amount: 1500, cur: 'DOP', paid: true }] })]), ids());
    expect(state.months['2026-10']).toEqual({
      key: '2026-10',
      closed: false,
      closedAt: null,
      // Un solo movimiento inicial en la cuenta en DOP, con un id fijo por mes (no sale de newId).
      budgetLog: [{ id: 'imported-budget-2026-10', date: '2026-10-01', accountId: 'dr', amount: 65000, kind: 'initial', note: '' }],
      budgets: { dr: 65000 },
      rates: [],
      fixed: [{ id: 'new-1', monthKey: '2026-10', name: 'Luz', day: '', amount: 1500, cur: 'DOP', paid: true, accountId: 'dr', sort: 0 }],
      transfers: [],
      tx: [],
    });
    expect(state.months['2026-09']).toBe(base.months['2026-09']);
  });

  it('cerrado o abierto como diga el archivo; un mes que ya estaba cerrado conserva su fecha de cierre', () => {
    const base = seedState();
    base.months['2026-08']!.closedAt = '2026-09-01T04:00:00.000Z';
    base.months['2026-09']!.closedAt = '2026-10-01T04:00:00.000Z';
    const state = applyImportToState(
      base,
      payloadOf([importMonth('2026-08', { closed: true }), importMonth('2026-09', { closed: false }), importMonth('2026-10', { closed: true }), importMonth('2026-12', { closed: true })]),
      ids(),
    );
    expect(['2026-08', '2026-09', '2026-10', '2026-12'].map((k) => [state.months[k]!.closed, state.months[k]!.closedAt])).toEqual([
      [true, '2026-09-01T04:00:00.000Z'],
      // Se reabre.
      [false, null],
      // Recién cerrados: la fecha la pone quien guarde.
      [true, null],
      [true, null],
    ]);
  });

  it('presupuesto 0: el mes queda sin partes', () => {
    const state = applyImportToState(newUserState(), payloadOf([importMonth('2026-10', { budget: 0 })]), ids());
    expect(state.months['2026-10']!.budgets).toEqual({});
    expect(monthCalc(state, '2026-10').budget).toBe(0);
  });

  it('meses desordenados o repetidos: vale el último de cada clave y los saldos son los del mes más reciente', () => {
    const state = applyImportToState(
      newUserState(),
      payloadOf([
        importMonth('2026-12', { accounts: { usd: 700, dop: 800 }, incomeUSD: 10 }),
        importMonth('2026-11', { accounts: { usd: 1, dop: 2 }, incomeUSD: 20 }),
        importMonth('2026-11', { accounts: { usd: 3, dop: 4 }, incomeUSD: 30, budget: 123 }),
      ]),
      ids(),
    );
    expect(sortedKeys(state)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(state.months['2026-11']!.budgets).toEqual({ dr: 123 });
    expect(state.incomes.map((i) => [i.date, i.amount])).toEqual([['2026-11-01', 30], ['2026-12-01', 10]]);
    expect([balanceOf(state, 'us', '2026-12'), balanceOf(state, 'dr', '2026-12')]).toEqual([700, 800]);
  });

  it('un monto en una moneda que el libro no escribe se paga desde la cuenta en DOP y conserva su moneda', () => {
    const state = applyImportToState(
      newUserState(),
      payloadOf([
        importMonth('2026-10', {
          tx: [{ date: '2026-10-03', desc: 'Simit', place: '', cat: 'Food', method: 'Debit card', amount: 84, cur: 'TRY', notes: '' }],
          accounts: { usd: 0, dop: 1000 },
        }),
      ]),
      ids(),
    );
    expect(state.months['2026-10']!.tx[0]).toMatchObject({ cur: 'TRY', amount: 84, accountId: 'dr' });
    expect(balanceOf(state, 'dr', '2026-10')).toBeCloseTo(1000, 8);
  });
});

describe('applyImportToState · cuentas', () => {
  const account = (id: string, currency: Currency, over: Partial<Account> = {}): Account => ({ id, name: id, currency, opening: 0, hidden: false, sort: 0, ...over });
  const withAccounts = (accounts: Account[]): AppState => ({ ...newUserState(), accounts });
  const file = payloadOf([
    importMonth('2026-10', {
      incomeUSD: 500,
      fixed: [{ name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: true }],
      transfers: [{ date: '2026-10-02', via: 'Remitly', usd: 100, rate: 60 }],
      tx: [{ date: '2026-10-03', desc: 'Café', place: '', cat: 'Food', method: 'Debit card', amount: 250, cur: 'DOP', notes: '' }],
    }),
  ]);

  it('sin cuenta en USD ni en DOP: se crean las dos, al final, y todo lo del libro va a ellas', () => {
    const base = withAccounts([account('tr', 'TRY', { opening: 900, sort: 4 })]);
    const state = applyImportToState(base, file, ids());
    expect(BOOK_ACCOUNT_NAMES).toEqual({ USD: 'US account', DOP: 'DR account' });
    expect(state.accounts).toEqual([
      base.accounts[0],
      // La celda en USD del libro suma todo lo visible que no es DOP: los 900 TRY de la otra cuenta ya cuentan en ella.
      { id: 'new-1', name: 'US account', currency: 'USD', opening: expect.closeTo(1000 - 900 / 42 - (500 - 106 - 100), 8), hidden: false, sort: 5 },
      { id: 'new-2', name: 'DR account', currency: 'DOP', opening: expect.closeTo(20000 - (6000 - 250), 8), hidden: false, sort: 6 },
    ]);
    const oct = state.months['2026-10']!;
    expect([oct.fixed[0]!.accountId, oct.tx[0]!.accountId, oct.transfers[0]!.fromAccountId, oct.transfers[0]!.toAccountId]).toEqual(['new-1', 'new-2', 'new-1', 'new-2']);
    expect(oct.budgets).toEqual({ 'new-2': 50000 });
    expect(state.incomes[0]).toMatchObject({ accountId: 'new-1', amount: 500, cur: 'USD' });
    expect([balanceOf(state, 'new-1', '2026-10'), balanceOf(state, 'new-2', '2026-10'), balanceOf(state, 'tr', '2026-10')]).toEqual([
      expect.closeTo(1000 - 900 / 42, 8),
      20000,
      900,
    ]);
    // Reimportar las encuentra: no crea otras.
    expect(applyImportToState(state, file, ids('again')).accounts).toEqual(state.accounts);
  });

  it('sin ninguna cuenta: se crean las dos', () => {
    const state = applyImportToState(withAccounts([]), file, ids());
    expect(state.accounts.map((a) => [a.id, a.name, a.currency, a.sort])).toEqual([['new-1', 'US account', 'USD', 0], ['new-2', 'DR account', 'DOP', 1]]);
  });

  it('solo falta una: se crea esa y la otra se usa', () => {
    const onlyDOP = applyImportToState(withAccounts([account('pesos', 'DOP', { sort: 2 })]), file, ids());
    expect(onlyDOP.accounts.map((a) => [a.id, a.name, a.currency, a.sort])).toEqual([['pesos', 'pesos', 'DOP', 2], ['new-1', 'US account', 'USD', 3]]);
    expect(onlyDOP.months['2026-10']!.tx[0]!.accountId).toBe('pesos');

    const onlyUSD = applyImportToState(withAccounts([account('dollars', 'USD')]), file, ids());
    expect(onlyUSD.accounts.map((a) => [a.id, a.name, a.currency, a.sort])).toEqual([['dollars', 'dollars', 'USD', 0], ['new-1', 'DR account', 'DOP', 1]]);
    expect(onlyUSD.incomes[0]!.accountId).toBe('dollars');
  });

  it('una cuenta oculta no vale: se crea una visible y la oculta se queda como está', () => {
    const hidden = account('old', 'USD', { hidden: true, opening: 77 });
    const state = applyImportToState(withAccounts([hidden, account('dr', 'DOP', { sort: 1 })]), file, ids());
    expect(state.accounts.map((a) => [a.id, a.hidden, a.sort])).toEqual([['old', true, 0], ['dr', false, 1], ['new-1', false, 2]]);
    expect(state.accounts[0]).toBe(hidden);
    expect(state.months['2026-10']!.fixed[0]!.accountId).toBe('new-1');
  });

  it('con varias en la misma moneda se usa la primera visible en su orden (sort), y solo a esas dos se les mueve el saldo inicial', () => {
    const base = withAccounts([
      account('paypal', 'USD', { sort: 3, opening: 10 }),
      account('cash', 'DOP', { sort: 2, opening: 20 }),
      account('bank', 'USD', { sort: 1, opening: 30 }),
      account('hidden', 'DOP', { sort: 0, hidden: true, opening: 40 }),
      account('popular', 'DOP', { sort: 5, opening: 50 }),
    ]);
    const state = applyImportToState(base, file, ids());
    const oct = state.months['2026-10']!;
    expect([oct.fixed[0]!.accountId, oct.tx[0]!.accountId]).toEqual(['bank', 'cash']);
    // Las otras visibles (paypal 10 USD, popular 50 DOP) ya cuentan en las celdas del libro (1,000 USD y 20,000 DOP).
    expect([balanceOf(state, 'bank', '2026-10'), balanceOf(state, 'cash', '2026-10')]).toEqual([990, 19950]);
    for (const id of ['paypal', 'hidden', 'popular']) expect(state.accounts.find((a) => a.id === id)).toBe(base.accounts.find((a) => a.id === id));
    expect(state.accounts.map((a) => a.id)).toEqual(base.accounts.map((a) => a.id));
  });

  it('con más de dos cuentas visibles las celdas del libro son la suma de todas: las demás conservan su saldo inicial y el total no se infla', () => {
    // El libro que exporta la app suma en esas dos celdas todas las cuentas visibles; al volver a cargarlo, a las
    // dos cuentas del libro les toca lo que queda después de las demás.
    const base = mixedState();
    const data = buildExportData(base);
    const state = applyImportToState(base, parseFinanzasXlsx(buildFinanzasXlsx(data)), ids());
    const oct = exported(data, '2026-10');
    const again = exported(buildExportData(state), '2026-10');
    expect(n(again.accounts.usd)).toBeCloseTo(n(oct.accounts.usd), 6);
    expect(n(again.accounts.dop)).toBeCloseTo(n(oct.accounts.dop), 6);
    expect(balanceOf(state, 'dr', '2026-10') + balanceOf(state, 'cash', '2026-10')).toBeCloseTo(n(oct.accounts.dop), 6);
    expect(balanceOf(state, 'us', '2026-10')).toBeLessThan(n(oct.accounts.usd));
    for (const id of ['tr', 'pp', 'cash', 'old', 'box']) expect(state.accounts.find((a) => a.id === id)).toBe(base.accounts.find((a) => a.id === id));
    // Lo que no cabía en el libro ya venía resumido: todo lo importado es de esas dos cuentas.
    const used = new Set(KEYS.flatMap((k) => [...state.months[k]!.fixed, ...state.months[k]!.tx].map((r) => r.accountId)));
    expect([...used].sort()).toEqual(['dr', 'us']);
    expect(KEYS.flatMap((k) => state.months[k]!.transfers.map((t) => `${t.fromAccountId}>${t.toAccountId}`)).every((t) => t === 'us>dr')).toBe(true);
  });

  it('el saldo inicial que queda no depende del que hubiera: sale del libro y de los movimientos, bit a bit', () => {
    // Por eso reimportar es exacto y no va acumulando el ruido de la coma flotante.
    const fresh = applyImportToState(newUserState(), V3, ids());
    for (const [us, dr] of [[1234.56, 98765.43], [0.1, 0.2], [-7162.07, 1e9 + 0.01]] as const) {
      const base = newUserState();
      base.accounts[0]!.opening = us;
      base.accounts[1]!.opening = dr;
      const state = applyImportToState(base, V3, ids());
      expect(state.accounts.map((a) => a.opening)).toStrictEqual(fresh.accounts.map((a) => a.opening));
      expect(base.accounts.map((a) => a.opening)).toEqual([us, dr]);
    }
    let state = fresh;
    for (let i = 0; i < 5; i++) state = applyImportToState(state, V3, ids(`again-${i}`));
    expect(state.accounts).toStrictEqual(fresh.accounts);
  });

  it('un archivo sin meses no crea cuentas ni toca saldos', () => {
    const base = deepFreeze(withAccounts([account('tr', 'TRY', { opening: 5 })]));
    const state = applyImportToState(base, { months: [], goals: [{ name: 'Car', monthlyUSD: null, start: null, end: null }], contribs: [] }, ids());
    expect(state.accounts).toBe(base.accounts);
    expect(state.months).toBe(base.months);
    expect(state.incomes).toBe(base.incomes);
    expect(state.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Car']);
    // Y sin nada que importar, devuelve el mismo estado.
    expect(applyImportToState(base, { months: [], goals: null, contribs: null }, ids())).toBe(base);
  });
});

describe('applyImportToState · ingreso del mes', () => {
  const file = (incomeUSD: number, key = '2026-10') => payloadOf([importMonth(key, { incomeUSD })]);

  it('reimportar con otro ingreso sustituye al anterior y conserva su id', () => {
    const first = applyImportToState(newUserState(), file(5800), ids('a'));
    expect(first.incomes).toEqual([{ id: 'a-1', date: '2026-10-01', desc: 'Income (imported)', accountId: 'us', amount: 5800, cur: 'USD', budget: false }]);
    const second = applyImportToState(first, file(6100), ids('b'));
    expect(second.incomes).toEqual([{ ...first.incomes[0]!, amount: 6100 }]);
    // El saldo sigue siendo el del libro: el inicial compensa la diferencia.
    expect([balanceOf(first, 'us', '2026-10'), balanceOf(second, 'us', '2026-10')]).toEqual([1000, 1000]);
  });

  it('ingreso 0 (o sin número): no crea ninguno y quita el que hubiera dejado una importación anterior', () => {
    const first = applyImportToState(newUserState(), file(5800), ids());
    expect(applyImportToState(first, file(0), ids()).incomes).toEqual([]);
    expect(applyImportToState(first, file(-5), ids()).incomes).toEqual([]);
    expect(applyImportToState(first, file(Number.NaN), ids()).incomes).toEqual([]);
    expect(applyImportToState(newUserState(), file(0), ids()).incomes).toEqual([]);
  });

  it('solo toca el ingreso importado de los meses que vienen en el archivo', () => {
    const base = newUserState();
    base.incomes.push(
      { id: 'sep', date: '2026-09-01', desc: IMPORTED_INCOME, accountId: 'us', amount: 111, cur: 'USD', budget: false },
      { id: 'salary', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD', budget: false },
      { id: 'oct', date: '2026-10-01', desc: IMPORTED_INCOME, accountId: 'dr', amount: 222, cur: 'DOP', budget: false },
      { id: 'oct-2', date: '2026-10-20', desc: IMPORTED_INCOME, accountId: 'us', amount: 333, cur: 'USD', budget: false },
      { id: 'gift', date: '2026-10-09', desc: 'Gift', accountId: 'dr', amount: 1000, cur: 'DOP', budget: false },
    );
    // El libro dice 6,400 USD en octubre; el usuario ya tiene 5,800 USD y 1,000 DOP (a la tasa de respaldo, 58.76).
    const state = applyImportToState(deepFreeze(base), file(6400), ids());
    expect(state.incomes).toEqual([
      // Septiembre no viene en el archivo: su ingreso importado de otra vez se queda.
      base.incomes[0],
      base.incomes[1],
      base.incomes[4],
      // Los dos importados de octubre se van y queda uno, con el id del primero y solo lo que le falta al total.
      { id: 'oct', date: '2026-10-01', desc: IMPORTED_INCOME, accountId: 'us', amount: expect.closeTo(600 - 1000 / 58.76, 8), cur: 'USD', budget: false },
    ]);
    expect(incomeInMonth(state, '2026-10', 'USD')).toBeCloseTo(6400, 8);
  });

  it('si el libro trae menos de lo que el usuario ya tiene registrado, no crea ninguno ni reduce los suyos', () => {
    const base = newUserState();
    base.incomes.push(
      { id: 'salary', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD', budget: false },
      { id: 'oct', date: '2026-10-01', desc: IMPORTED_INCOME, accountId: 'us', amount: 222, cur: 'USD', budget: false },
    );
    for (const amount of [400, 5800, 5800.004]) {
      expect(applyImportToState(deepFreeze(base), file(amount), ids()).incomes, String(amount)).toEqual([base.incomes[0]]);
    }
  });
});

describe('applyImportToState · metas y aportes', () => {
  const goal = (id: string, name: string, over: Partial<Goal> = {}): Goal => ({ id, name, cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 0, ...over });
  const base = (): AppState => {
    const s = seedState();
    s.goals.push(
      goal('car', 'Car', { monthly: 200, start: '2026-01', end: '2026-12', approxCur: null, sort: 3 }),
      goal('flat', 'Istanbul flat', { cur: 'TRY', monthly: 10000, start: '2026-09', end: '2027-08', approxCur: null, sort: 4 }),
      goal('lira', 'Lira cushion', { cur: 'TRY', monthly: 900, start: '2026-09', end: '2027-08', approxCur: null, sort: 5 }),
    );
    return s;
  };

  it('metas: crea las que faltan, pone el plan del archivo a las que existen y conserva las que no vienen', () => {
    const before = deepFreeze(base());
    const state = applyImportToState(
      before,
      {
        months: [],
        contribs: null,
        goals: [
          // Existe sin plan → gana uno.
          { name: 'Emergency fund', monthlyUSD: 150, start: '2026-10', end: '2027-09' },
          // Existe con plan → se cambia por el del archivo.
          { name: 'Trip to Turkey', monthlyUSD: 3500, start: '2026-08', end: '2027-12' },
          // Existe con plan y el archivo dice que es de aportes variables → lo pierde.
          { name: 'Car', monthlyUSD: null, start: null, end: null },
          // En TRY y recibe un plan del libro, que es en USD → pasa a USD.
          { name: 'Istanbul flat', monthlyUSD: 250, start: '2026-09', end: '2027-08' },
          // En TRY y el archivo la trae sin plan → lo pierde, pero sigue en TRY.
          { name: 'Lira cushion', monthlyUSD: null, start: null, end: null },
          // No existen → se crean en USD, al final y en el orden del archivo.
          { name: 'House', monthlyUSD: 500, start: '2027-01', end: '2030-12' },
          { name: 'Laptop', monthlyUSD: null, start: null, end: null },
        ],
      },
      ids(),
    );
    expect(state.goals.map((g) => [g.id, g.name, g.cur, g.monthly, g.start, g.end, g.sort])).toEqual([
      ['emergency', 'Emergency fund', 'USD', 150, '2026-10', '2027-09', 0],
      // No viene en el archivo: se queda como estaba.
      ['personal', 'Personal savings', 'USD', null, null, null, 1],
      ['turkey', 'Trip to Turkey', 'USD', 3500, '2026-08', '2027-12', 2],
      ['car', 'Car', 'USD', null, null, null, 3],
      ['flat', 'Istanbul flat', 'USD', 250, '2026-09', '2027-08', 4],
      ['lira', 'Lira cushion', 'TRY', null, null, null, 5],
      ['new-1', 'House', 'USD', 500, '2027-01', '2030-12', 6],
      ['new-2', 'Laptop', 'USD', null, null, null, 7],
    ]);
    expect(state.goals[1]).toBe(before.goals[1]);
    // Sin aportes en el archivo (null), los que había siguen ahí.
    expect(state.contribs).toBe(before.contribs);
    expect(state.months).toBe(before.months);
  });

  it('un plan a medias en el archivo cuenta como sin plan', () => {
    const state = applyImportToState(base(), { months: [], contribs: null, goals: [{ name: 'Car', monthlyUSD: 300, start: '2026-01', end: null }] }, ids());
    expect(state.goals.find((g) => g.id === 'car')).toMatchObject({ monthly: null, start: null, end: null });
  });

  it('aportes: sustituyen a todos los que había; a una meta que no existe, la crean sin plan', () => {
    const before = base();
    const state = applyImportToState(
      before,
      {
        months: [],
        goals: null,
        contribs: [
          { date: '2026-10-01', goalName: 'Trip to Turkey', amount: 100, cur: 'USD' },
          { date: '2026-10-02', goalName: 'Bike', amount: 2500, cur: 'DOP' },
          { date: '2026-10-03', goalName: 'Bike', amount: 10, cur: 'USD' },
        ],
      },
      ids(),
    );
    expect(state.goals.slice(0, 6)).toEqual(before.goals);
    expect(state.goals[6]).toEqual({ id: 'new-2', name: 'Bike', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 6 });
    expect(state.contribs).toEqual([
      { id: 'new-1', goalId: 'turkey', date: '2026-10-01', amount: 100, cur: 'USD' },
      { id: 'new-3', goalId: 'new-2', date: '2026-10-02', amount: 2500, cur: 'DOP' },
      { id: 'new-4', goalId: 'new-2', date: '2026-10-03', amount: 10, cur: 'USD' },
    ]);
    // Una lista vacía es "el libro no tiene aportes": se quitan todos. Con null no se tocan.
    expect(applyImportToState(before, { months: [], goals: null, contribs: [] }, ids()).contribs).toEqual([]);
    expect(applyImportToState(before, { months: [], goals: [], contribs: null }, ids()).contribs).toBe(before.contribs);
  });

  it('las metas se buscan por nombre exacto y, si no, sin distinguir mayúsculas; con nombres repetidos gana la primera', () => {
    const before = base();
    before.goals.push(goal('car-2', 'CAR', { sort: 6 }), goal('car-3', 'Car', { sort: 7 }));
    const state = applyImportToState(
      before,
      {
        months: [],
        goals: null,
        contribs: [
          { date: '2026-10-01', goalName: 'emergency FUND', amount: 1, cur: 'USD' },
          { date: '2026-10-02', goalName: 'CAR', amount: 2, cur: 'USD' },
          { date: '2026-10-03', goalName: 'Car', amount: 3, cur: 'USD' },
          { date: '2026-10-04', goalName: 'car', amount: 4, cur: 'USD' },
        ],
      },
      ids(),
    );
    expect(state.contribs.map((c) => c.goalId)).toEqual(['emergency', 'car-2', 'car', 'car']);
    expect(state.goals).toHaveLength(before.goals.length);
  });

  it('quien conserva una meta con el nombre de la versión 1 la sigue usando', () => {
    // Su propio libro en español llega con las tres metas ya renombradas a las de hoy.
    const before = newUserState();
    before.goals = [goal('fe', 'Fondo de emergencia'), goal('ap', 'Ahorro personal', { sort: 1 }), goal('vt', 'Viaje a Turquía', { sort: 2 })];
    const state = applyImportToState(before, V3, ids());
    expect(state.goals.map((g) => [g.id, g.name, g.monthly])).toEqual([['fe', 'Fondo de emergencia', null], ['ap', 'Ahorro personal', null], ['vt', 'Viaje a Turquía', 3000]]);
    expect(goalsProgress(state).map((g) => [g.id, g.saved])).toEqual([['fe', 1200], ['ap', 450], ['vt', 9000]]);
    // Si además tiene la de hoy, gana la de hoy.
    before.goals.push(goal('ef', 'Emergency fund', { sort: 3 }));
    expect(goalsProgress(applyImportToState(before, V3, ids())).map((g) => [g.id, g.saved])).toEqual([['fe', 0], ['ap', 450], ['vt', 9000], ['ef', 1200]]);
  });
});

describe('ida y vuelta: exportar, importar y volver a exportar', () => {
  const first = buildExportData(seedState());

  it.each(LANGS)('en un usuario nuevo, con el libro en "%s": el segundo libro es igual al primero', (lang) => {
    const payload = parseFinanzasXlsx(buildFinanzasXlsx(first, { locale: EXCEL_LOCALES[lang] }));
    const state = applyImportToState(newUserState(), payload, ids());
    expect(buildExportData(state)).toEqual(approx(first));
    // Con los mismos movimientos, el saldo inicial vuelve a ser el de los datos de ejemplo.
    expect(state.accounts.map((a) => [a.id, a.opening])).toEqual([['us', expect.closeTo(2000, 6)], ['dr', expect.closeTo(60000, 6)]]);
    // Y una segunda vuelta tampoco lo mueve.
    const again = applyImportToState(newUserState(), parseFinanzasXlsx(buildFinanzasXlsx(buildExportData(state), { locale: EXCEL_LOCALES[lang] })), ids());
    expect(buildExportData(again)).toEqual(approx(first));
  });

  it('en el mismo usuario, que ya tiene sus ingresos registrados: nada se cuenta dos veces, las veces que sea', () => {
    // El libro lleva sumados los "Salary" de los datos de ejemplo: al volver a cargarlo no falta ningún ingreso.
    let state = seedState();
    for (let i = 0; i < 3; i++) {
      state = applyImportToState(state, parseFinanzasXlsx(buildFinanzasXlsx(buildExportData(state))), ids(`r${i}`));
      expect(buildExportData(state), `vuelta ${i + 1}`).toEqual(approx(first));
      expect(state.incomes).toEqual(seedState().incomes);
    }
  });

  it('un envío que sube el presupuesto: al recargar su libro conserva la marca y el registro no lo cuenta dos veces', () => {
    const base = seedState();
    // 1,500 USD a 58.76 = 88,140 DOP encima de los 70,000 del registro.
    base.months['2026-10']!.transfers[0]!.budget = true;
    const book = buildExportData(base);
    expect(exported(book, '2026-10').budget).toBe(158140);

    let state = base;
    for (let i = 0; i < 2; i++) {
      state = applyImportToState(state, parseFinanzasXlsx(buildFinanzasXlsx(buildExportData(state))), ids(`r${i}`));
      const october = state.months['2026-10']!;
      expect(october.transfers.map((t) => [t.date, t.amount, t.rate, t.budget]), `vuelta ${i + 1}`).toEqual([['2026-10-02', 1500, 58.76, true]]);
      // El presupuesto del libro (158,140) menos lo que ya pone el envío: el registro vuelve a sus 70,000.
      expect(october.budgetLog.map((e) => [e.id, e.accountId, e.kind]), `vuelta ${i + 1}`).toEqual([['imported-budget-2026-10', 'dr', 'initial']]);
      expect(october.budgetLog[0]!.amount, `vuelta ${i + 1}`).toBeCloseTo(70000, 6);
      expect(monthCalc(state, '2026-10').budget, `vuelta ${i + 1}`).toBeCloseTo(158140, 6);
      // Los envíos de los otros meses no estaban marcados y siguen sin estarlo.
      expect(state.months['2026-09']!.transfers.map((t) => t.budget)).toEqual([false, false]);
    }

    // En otro usuario no hay envío del que heredar la marca (el libro no la guarda): todo el presupuesto va al registro.
    const fresh = applyImportToState(newUserState(), parseFinanzasXlsx(buildFinanzasXlsx(book)), ids());
    expect(fresh.months['2026-10']!.transfers.map((t) => t.budget)).toEqual([false]);
    expect(fresh.months['2026-10']!.budgets).toEqual({ dr: expect.closeTo(158140, 6) });
    expect(monthCalc(fresh, '2026-10').budget).toBeCloseTo(158140, 6);
  });

  it('en el mismo usuario con TRY y más cuentas: el dinero total y el ingreso de cada mes no cambian al recargar su libro', () => {
    const base = mixedState();
    const before = buildExportData(base);
    let state = base;
    for (let i = 0; i < 2; i++) {
      state = applyImportToState(state, parseFinanzasXlsx(buildFinanzasXlsx(buildExportData(state))), ids(`r${i}`));
      const after = buildExportData(state);
      expect(after.months[2]!.accounts, `vuelta ${i + 1}`).toEqual(approx(before.months[2]!.accounts));
      expect(after.months.map((m) => m.incomeUSD)).toEqual(before.months.map((m) => expect.closeTo(n(m.incomeUSD), 6)));
    }
  });

  it('con TRY y más cuentas la vuelta conserva el libro, no el detalle de la app', () => {
    const mixed = buildExportData(mixedState());
    const state = applyImportToState(newUserState(), parseFinanzasXlsx(buildFinanzasXlsx(mixed)), ids());
    const back = buildExportData(state);
    // Los saldos de los meses anteriores no vuelven: salían de cuentas y envíos que el libro no trae. El libro
    // ordena por fecha el historial y los aportes.
    const lastOnly = (d: ExportData) => ({
      ...d,
      contribs: byDate(d.contribs),
      months: d.months.map((m, i) => ({ ...m, tx: byDate(m.tx), accounts: i === d.months.length - 1 ? m.accounts : null })),
    });
    expect(lastOnly(back)).toEqual(approx(lastOnly(mixed)));
    // En la app ya no queda nada en TRY: llegó convertido.
    expect(state.accounts.map((a) => a.currency)).toEqual(['USD', 'DOP']);
    expect(state.goals.map((g) => g.cur)).toEqual(['USD', 'USD', 'USD', 'USD', 'USD', 'USD']);
    expect(new Set(KEYS.flatMap((k) => [...state.months[k]!.fixed, ...state.months[k]!.tx].map((r) => r.cur)))).toEqual(new Set(['DOP', 'USD']));
  });
});
