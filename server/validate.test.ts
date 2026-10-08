import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { en, es } from 'zod/locales';
import { ApiError, toApiError, zodMessage } from './errors';
import {
  accountCreateSchema,
  accountPatchSchema,
  budgetEntryCreateSchema,
  closeRequestSchema,
  contributionCreateSchema,
  fixedCreateSchema,
  fixedPatchSchema,
  goalCreateSchema,
  goalPatchSchema,
  goalPlanIssue,
  ID_RE,
  importSchema,
  incomeCreateSchema,
  incomePatchSchema,
  ingestSchema,
  MAX_BUDGET_PARTS,
  monthPatchSchema,
  monthRateSchema,
  parse,
  ratePairSchema,
  settingsUpdateSchema,
  transferCreateSchema,
  transferPatchSchema,
  txCreateSchema,
  txPatchSchema,
} from './validate';

const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Debit card', amount: 850, cur: 'DOP' };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation' });
    return (err as ApiError).message;
  }
  throw new Error('se esperaba un error de validación');
}

describe('parse', () => {
  it('devuelve el valor normalizado: textos recortados y nada más que lo declarado', () => {
    expect(parse(txCreateSchema, { ...tx, desc: '  Uber  ', place: ' Centro ', notes: '  ' })).toEqual({
      ...tx,
      place: 'Centro',
      notes: '',
    });
  });

  it('los mensajes son legibles y en inglés', () => {
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: 0 }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, desc: ' ' }))).toBe('Invalid data: desc: cannot be empty');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, desc: 'x'.repeat(201) }))).toBe('Invalid data: desc: allows up to 200 characters');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, date: '2026-02-30' }))).toBe(
      'Invalid data: date: is not a valid date (YYYY-MM-DD)',
    );
    expect(messageOf(() => parse(txCreateSchema, { ...tx, monthKey: '2026-13' }))).toBe('Invalid data: monthKey: is not a valid month (YYYY-MM)');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, cur: 'EUR' }))).toBe('Invalid data: cur: must be DOP, USD or TRY');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: '850' }))).toBe('Invalid data: amount: must be a number');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: -1 }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(txPatchSchema, { amount: -1 }))).toBe('Invalid data: amount: cannot be negative');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: 1e13 }))).toBe('Invalid data: amount: is too large');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, id: 'a b' }))).toBe(
      'Invalid data: id: only letters, numbers, "-" and "_" are allowed (up to 64)',
    );
    expect(messageOf(() => parse(fixedCreateSchema, { monthKey: '2026-10', name: 'x', amount: 1, cur: 'DOP', paid: 1 }))).toBe(
      'Invalid data: paid: must be true or false',
    );
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: undefined, desc: undefined }))).toBe(
      'Invalid data: desc: is required; amount: is required',
    );
  });

  it('también los mensajes que no se escribieron a mano, aunque zod esté configurado en otro idioma', () => {
    const unknownKey = 'Invalid data: Unrecognized key: "otra"';
    expect(messageOf(() => parse(txCreateSchema, { ...tx, otra: 1 }))).toBe(unknownKey);
    expect(messageOf(() => parse(txCreateSchema, null))).toBe('Invalid data: Invalid input: expected object, received null');
    // La API responde siempre en inglés: no depende de la configuración global de zod.
    z.config(es());
    try {
      expect(messageOf(() => parse(txCreateSchema, { ...tx, otra: 1 }))).toBe(unknownKey);
    } finally {
      z.config(en());
    }
  });

  it('resume cuando hay muchos problemas', () => {
    const message = messageOf(() => parse(txCreateSchema, {}));
    expect(message).toContain('monthKey: is required; date: is required; desc: is required');
    expect(message).toMatch(/\(and 2 more\)$/);
  });

  it('montos: finitos; > 0 al crear, ≥ 0 al editar', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1e13, '1', null]) {
      expect(() => parse(txCreateSchema, { ...tx, amount }), String(amount)).toThrow(ApiError);
    }
    expect(parse(txCreateSchema, { ...tx, amount: 0.01 }).amount).toBe(0.01);
    expect(parse(txPatchSchema, { amount: 0 })).toEqual({ amount: 0 });
    expect(() => parse(txPatchSchema, { amount: -0.01 })).toThrow(ApiError);
    expect(() => parse(txPatchSchema, { amount: Number.POSITIVE_INFINITY })).toThrow(ApiError);
  });

  it('envíos: monto y tasa mayores que 0, dos cuentas distintas; la tasa puede faltar y la vía es texto libre', () => {
    const transfer = { monthKey: '2026-10', date: '2026-10-02', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1500, rate: 58.76 };
    expect(parse(transferCreateSchema, transfer)).toEqual(transfer);
    // Sin tasa: la pone el servidor con la del mes para las monedas de las dos cuentas.
    const { rate: _rate, ...noRate } = transfer;
    expect(parse(transferCreateSchema, noRate)).toEqual(noRate);
    expect(() => parse(transferCreateSchema, { ...transfer, amount: 0 })).toThrow(ApiError);
    expect(() => parse(transferCreateSchema, { ...transfer, rate: 0 })).toThrow(ApiError);
    expect(() => parse(transferCreateSchema, { ...transfer, rate: null })).toThrow(ApiError);
    // El formato anterior (solo dólares, sin cuentas) ya no existe.
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, usd: 1500 }))).toContain('Unrecognized key: "usd"');
    expect(messageOf(() => parse(transferCreateSchema, { ...noRate, toAccountId: undefined }))).toBe('Invalid data: toAccountId: is required');
    const same = 'Invalid data: toAccountId: must be different from fromAccountId';
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, toAccountId: 'us' }))).toBe(same);
    expect(messageOf(() => parse(transferPatchSchema, { fromAccountId: 'dr', toAccountId: 'dr' }))).toBe(same);
    // Una sola cuenta en un patch pasa: si choca con la otra lo dice el repositorio, que es quien la conoce.
    expect(parse(transferPatchSchema, { toAccountId: 'us' })).toEqual({ toAccountId: 'us' });
    expect(parse(transferPatchSchema, { fromAccountId: 'dr', toAccountId: 'us', amount: 5, rate: 0.017 })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      amount: 5,
      rate: 0.017,
    });
    expect(() => parse(transferPatchSchema, { amount: 0 })).toThrow(ApiError);
    expect(() => parse(transferPatchSchema, { fromAccountId: 'con espacios' })).toThrow(ApiError);
    // Remitly y PayPal son sugerencias: vale cualquier nombre, recortado, que no esté vacío ni pase de 60.
    expect(parse(transferCreateSchema, { ...transfer, via: '  Banco BHD (ventanilla) ' }).via).toBe('Banco BHD (ventanilla)');
    expect(parse(transferPatchSchema, { via: 'Efectivo de mamá' })).toEqual({ via: 'Efectivo de mamá' });
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, via: '   ' }))).toBe('Invalid data: via: cannot be empty');
    expect(messageOf(() => parse(transferPatchSchema, { via: 'x'.repeat(61) }))).toBe('Invalid data: via: allows up to 60 characters');
  });

  it('ids: letras, números, "-" y "_", de 1 a 64', () => {
    const fixed = { monthKey: '2026-10', name: 'Luz', amount: 1, cur: 'DOP' };
    for (const id of ['a', 'seed-fx-2026-10-1', 'A_b-9', 'x'.repeat(64), '3f2b8c1e-0d4a-4f6b-9c7d-1e2f3a4b5c6d']) {
      expect(ID_RE.test(id)).toBe(true);
      expect(parse(fixedCreateSchema, { ...fixed, id }).id).toBe(id);
    }
    for (const id of ['', ' ', 'a b', 'a/b', 'ñ', 'x'.repeat(65), "a'; DROP TABLE months;--", 7]) {
      expect(() => parse(fixedCreateSchema, { ...fixed, id }), String(id)).toThrow(ApiError);
    }
  });

  it('meses y fechas se validan con shared/month', () => {
    for (const monthKey of ['2026-00', '2026-13', '2026-1', '26-10', '2026-10-01', '']) {
      expect(() => parse(txCreateSchema, { ...tx, monthKey }), monthKey).toThrow(ApiError);
    }
    for (const date of ['2026-10-32', '2026-02-29', '2026-10-7', '2026-10', '']) {
      expect(() => parse(txCreateSchema, { ...tx, date }), date).toThrow(ApiError);
    }
    expect(parse(txCreateSchema, { ...tx, date: '2028-02-29' }).date).toBe('2028-02-29');
  });

  it('categoría y método son texto libre y no se traducen: la web manda el valor canónico', () => {
    expect(parse(txCreateSchema, { ...tx, cat: 'Mascotas', method: 'Efectivo' })).toMatchObject({ cat: 'Mascotas', method: 'Efectivo' });
    // "Market" es Groceries en turco, pero aquí puede ser una categoría propia de quien escribe en inglés.
    expect(parse(txPatchSchema, { cat: 'Market' })).toEqual({ cat: 'Market' });
  });

  it('monedas: DOP, USD y TRY, en todo lo que lleva moneda', () => {
    for (const cur of ['EUR', 'usd', 'try', '', null, 1]) expect(() => parse(txCreateSchema, { ...tx, cur }), String(cur)).toThrow(ApiError);
    for (const cur of ['DOP', 'USD', 'TRY']) {
      expect(parse(txCreateSchema, { ...tx, cur }).cur).toBe(cur);
      expect(parse(txPatchSchema, { cur })).toEqual({ cur });
      expect(parse(fixedCreateSchema, { monthKey: '2026-10', name: 'Luz', amount: 1, cur }).cur).toBe(cur);
      expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur }).cur).toBe(cur);
      expect(parse(contributionCreateSchema, { goalId: 'g', date: '2026-10-01', amount: 1, cur }).cur).toBe(cur);
      expect(parse(accountCreateSchema, { name: 'x', currency: cur }).currency).toBe(cur);
      expect(parse(goalCreateSchema, { name: 'x', cur }).cur).toBe(cur);
    }
  });

  it('la cuenta de un gasto es un id: opcional al crear (sin ella, la de por defecto) y editable', () => {
    expect(parse(txCreateSchema, { ...tx, accountId: 'dr' }).accountId).toBe('dr');
    expect(parse(txCreateSchema, tx)).not.toHaveProperty('accountId');
    expect(parse(txPatchSchema, { accountId: 'us' })).toEqual({ accountId: 'us' });
    expect(parse(fixedPatchSchema, { accountId: 'us', paid: true })).toEqual({ accountId: 'us', paid: true });
    for (const accountId of ['', 'con espacios', null, 7]) {
      expect(() => parse(txCreateSchema, { ...tx, accountId }), String(accountId)).toThrow(ApiError);
      expect(() => parse(fixedPatchSchema, { accountId }), String(accountId)).toThrow(ApiError);
    }
  });
});

describe('meses: presupuesto por cuenta y tasas', () => {
  it('presupuesto: cuenta → monto no negativo (0 quita la parte); el formato anterior ya no existe', () => {
    expect(parse(monthPatchSchema, { budgets: { dr: 70000, us: 0, 'a-b_9': 12.5 } })).toEqual({ budgets: { dr: 70000, us: 0, 'a-b_9': 12.5 } });
    expect(parse(monthPatchSchema, { budgets: {} })).toEqual({ budgets: {} });
    expect(parse(monthPatchSchema, {})).toEqual({});
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: -1 } }))).toBe('Invalid data: budgets.dr: cannot be negative');
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: '70000' } }))).toBe('Invalid data: budgets.dr: must be a number');
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: 1e13 } }))).toBe('Invalid data: budgets.dr: is too large');
    for (const budgets of [70000, 'x', null, [1], { 'con espacios': 1 }, { '': 1 }, { dr: null }]) {
      expect(() => parse(monthPatchSchema, { budgets }), JSON.stringify(budgets)).toThrow(ApiError);
    }
    for (const body of [{ budget: 1 }, { incomeUSD: 1 }, { accUSD: 1 }, { accDOP: 1 }, { rates: [] }, { closed: true }]) {
      expect(messageOf(() => parse(monthPatchSchema, body)), JSON.stringify(body)).toContain('Unrecognized key');
    }
    const many = Object.fromEntries(Array.from({ length: MAX_BUDGET_PARTS + 1 }, (_, i) => [`a${i}`, 1]));
    expect(messageOf(() => parse(monthPatchSchema, { budgets: many }))).toBe('Invalid data: budgets: allows up to 100 accounts');
  });

  it('tasa: dos monedas distintas, tasa mayor que 0 y la fecha desde la que vale', () => {
    expect(parse(monthRateSchema, { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-08' })).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-08' });
    expect(parse(monthRateSchema, { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' })).toEqual({ from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' });
    const ok = { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-08' };
    expect(messageOf(() => parse(monthRateSchema, { ...ok, to: 'USD' }))).toBe('Invalid data: to: must be different from `from`');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, rate: 0 }))).toBe('Invalid data: rate: must be greater than 0');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, to: 'EUR' }))).toBe('Invalid data: to: must be DOP, USD or TRY');
    expect(messageOf(() => parse(monthRateSchema, { from: 'USD', to: 'DOP', rate: 58 }))).toBe('Invalid data: date: is required');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, date: '2026-02-30' }))).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    for (const body of [{ from: 'USD', to: 'DOP', date: ok.date }, { from: 'USD', rate: 1, date: ok.date }, { ...ok, rate: -1 }, { ...ok, rate: '58' }, { ...ok, monthKey: '2026-10' }, { ...ok, date: '2026-10' }, { ...ok, date: 20261008 }]) {
      expect(() => parse(monthRateSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
    // El par y la fecha de la ruta de borrado.
    expect(parse(ratePairSchema, { from: 'DOP', to: 'TRY', date: '2026-10-08' })).toEqual({ from: 'DOP', to: 'TRY', date: '2026-10-08' });
    expect(messageOf(() => parse(ratePairSchema, { from: 'DOP', to: 'TRY' }))).toBe('Invalid data: date: is required');
    for (const pair of [{ from: 'DOP', to: 'DOP' }, { from: 'dop', to: 'USD' }, { from: 'DOP' }, { from: 'DOP', to: 'EUR' }]) {
      expect(() => parse(ratePairSchema, { ...pair, date: '2026-10-08' }), JSON.stringify(pair)).toThrow(ApiError);
    }
    expect(() => parse(ratePairSchema, { from: 'DOP', to: 'TRY', date: 'hoy' })).toThrow(ApiError);
  });

  it('movimiento del presupuesto: cuenta y monto con signo (no 0); tipo inicial o ajuste; el sobrante no se escribe a mano', () => {
    expect(parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 5000 })).toEqual({ accountId: 'dr', amount: 5000 });
    expect(parse(budgetEntryCreateSchema, { id: 'b-1', date: '2026-10-05', accountId: 'dr', amount: -1200.5, kind: 'initial', note: '  Car repair ' })).toEqual({
      id: 'b-1', date: '2026-10-05', accountId: 'dr', amount: -1200.5, kind: 'initial', note: 'Car repair',
    });
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 0 }))).toBe('Invalid data: amount: cannot be 0');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 1, kind: 'leftover' }))).toBe('Invalid data: kind: must be initial or adjust');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { amount: 1 }))).toBe('Invalid data: accountId: is required');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 1, date: '2026-13-01' }))).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    for (const body of [{ accountId: 'dr' }, { accountId: 'dr', amount: '5' }, { accountId: 'dr', amount: 1e13 }, { accountId: 'dr', amount: -1e13 }, { accountId: 'con espacios', amount: 1 }, { accountId: 'dr', amount: 1, monthKey: '2026-10' }, { accountId: 'dr', amount: 1, note: 5 }]) {
      expect(() => parse(budgetEntryCreateSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
  });

  it('cierre de mes: cuerpo opcional con las partes iniciales del mes siguiente y si se suma el sobrante', () => {
    expect(parse(closeRequestSchema, {})).toEqual({});
    expect(parse(closeRequestSchema, { budgets: { dr: 80000, us: 0 }, addLeftover: true })).toEqual({ budgets: { dr: 80000, us: 0 }, addLeftover: true });
    expect(messageOf(() => parse(closeRequestSchema, { budgets: { dr: -1 } }))).toBe('Invalid data: budgets.dr: cannot be negative');
    expect(messageOf(() => parse(closeRequestSchema, { addLeftover: 'yes' }))).toBe('Invalid data: addLeftover: must be true or false');
    expect(messageOf(() => parse(closeRequestSchema, { leftover: true }))).toContain('Unrecognized key');
    for (const body of [null, [], 'x', { budgets: [1] }]) expect(() => parse(closeRequestSchema, body), JSON.stringify(body)).toThrow(ApiError);
  });
});

describe('cuentas e ingresos', () => {
  it('cuenta: nombre recortado y no vacío, moneda y saldo inicial (que puede ser negativo)', () => {
    expect(parse(accountCreateSchema, { name: '  PayPal ', currency: 'USD' })).toEqual({ name: 'PayPal', currency: 'USD' });
    expect(parse(accountCreateSchema, { id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.5 })).toEqual({
      id: 'tr',
      name: 'TR account',
      currency: 'TRY',
      opening: -250.5,
    });
    expect(parse(accountCreateSchema, { name: 'x'.repeat(120), currency: 'DOP' }).name).toHaveLength(120);
    expect(messageOf(() => parse(accountCreateSchema, { name: '  ', currency: 'USD' }))).toBe('Invalid data: name: cannot be empty');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x'.repeat(121), currency: 'USD' }))).toBe('Invalid data: name: allows up to 120 characters');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x' }))).toBe('Invalid data: currency: must be DOP, USD, TRY or XAU (gold, in grams)');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x', currency: 'USD', opening: 1e13 }))).toBe('Invalid data: opening: is too large');
    // Oculta y orden no se eligen al crear, y el saldo no viaja: se calcula.
    for (const extra of [{ hidden: true }, { sort: 3 }, { balance: 100 }]) {
      expect(() => parse(accountCreateSchema, { name: 'x', currency: 'USD', ...extra }), JSON.stringify(extra)).toThrow(ApiError);
    }

    expect(parse(accountPatchSchema, { name: ' Chase ', currency: 'TRY', opening: -1, hidden: true, sort: 4 })).toEqual({
      name: 'Chase',
      currency: 'TRY',
      opening: -1,
      hidden: true,
      sort: 4,
    });
    expect(parse(accountPatchSchema, {})).toEqual({});
    for (const body of [{ name: '' }, { hidden: 1 }, { sort: -1 }, { sort: 1.5 }, { currency: 'EUR' }, { opening: '5' }, { id: 'otra' }, { balance: 1 }]) {
      expect(() => parse(accountPatchSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
  });

  it('ingreso: fecha, monto y moneda; la descripción y la cuenta pueden faltar', () => {
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 5800, cur: 'USD' })).toEqual({ date: '2026-10-01', amount: 5800, cur: 'USD' });
    expect(parse(incomeCreateSchema, { id: 'in-1', date: '2026-10-01', desc: '  Salary ', accountId: 'us', amount: 5800, cur: 'USD' })).toEqual({
      id: 'in-1',
      date: '2026-10-01',
      desc: 'Salary',
      accountId: 'us',
      amount: 5800,
      cur: 'USD',
    });
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 0, cur: 'USD' }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-02-30', amount: 1, cur: 'USD' }))).toBe(
      'Invalid data: date: is not a valid date (YYYY-MM-DD)',
    );
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', desc: 'x'.repeat(201) }))).toBe(
      'Invalid data: desc: allows up to 200 characters',
    );
    // No pertenece a un mes: no lleva monthKey.
    expect(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', monthKey: '2026-10' })).toThrow(ApiError);
    // Al editar el monto puede quedar en 0 y la descripción, vacía.
    expect(parse(incomePatchSchema, { amount: 0, desc: ' ', accountId: 'dr', date: '2030-01-01', cur: 'TRY' })).toEqual({
      amount: 0,
      desc: '',
      accountId: 'dr',
      date: '2030-01-01',
      cur: 'TRY',
    });
    expect(() => parse(incomePatchSchema, { amount: -1 })).toThrow(ApiError);
    expect(() => parse(incomePatchSchema, { id: 'otro' })).toThrow(ApiError);
  });

  it('ingreso que sube el presupuesto: `budget` es opcional y solo true o false', () => {
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget: true }).budget).toBe(true);
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget: false }).budget).toBe(false);
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD' }).budget).toBeUndefined();
    expect(parse(incomePatchSchema, { budget: true })).toEqual({ budget: true });
    for (const budget of [1, 'true', null]) {
      expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget })), String(budget)).toBe('Invalid data: budget: must be true or false');
      expect(() => parse(incomePatchSchema, { budget }), String(budget)).toThrow(ApiError);
    }
  });

  it('meta: la moneda "≈" es una de las tres o null, también la de la propia meta', () => {
    for (const approxCur of ['DOP', 'USD', 'TRY', null]) {
      expect(parse(goalCreateSchema, { name: 'x', cur: 'USD', approxCur }).approxCur).toBe(approxCur);
      expect(parse(goalPatchSchema, { approxCur })).toEqual({ approxCur });
    }
    expect(parse(goalCreateSchema, { name: 'x' }).approxCur).toBeUndefined();
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', approxCur: 'EUR' }))).toBe('Invalid data: approxCur: must be DOP, USD or TRY');
    expect(messageOf(() => parse(goalPatchSchema, { approxCur: 'usd' }))).toBe('Invalid data: approxCur: must be DOP, USD or TRY');
  });
});

describe('ajustes (PATCH /api/settings)', () => {
  it('idioma: uno de los de la app', () => {
    for (const language of ['en', 'es', 'tr']) expect(parse(settingsUpdateSchema, { language })).toEqual({ language });
    for (const language of ['fr', 'EN', 'español', '', null, 1]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { language })), String(language)).toBe(
        'Invalid data: language: must be one of: en, es, tr',
      );
    }
  });

  it('colores: null o los tres, que salen normalizados y sin nada más', () => {
    expect(parse(settingsUpdateSchema, { theme: null })).toEqual({ theme: null });
    expect(parse(settingsUpdateSchema, { theme: { accent: '#ABC', header: ' #000000', background: '#FFFFFF', extra: 1 } })).toEqual({
      theme: { accent: '#aabbcc', header: '#000000', background: '#ffffff' },
    });
    const message = 'Invalid data: theme: must be null or the three colors accent, header and background as "#rrggbb"';
    for (const theme of ['#fff', {}, { accent: '#112233' }, { accent: '#112233', header: '#000000', background: 'white' }, 0, false, []]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { theme })), JSON.stringify(theme)).toBe(message);
    }
  });

  it('monedas: cada una es DOP, USD o TRY; si vienen las dos, distintas', () => {
    expect(parse(settingsUpdateSchema, { mainCurrency: 'TRY' })).toEqual({ mainCurrency: 'TRY' });
    expect(parse(settingsUpdateSchema, { secondCurrency: 'DOP' })).toEqual({ secondCurrency: 'DOP' });
    // Intercambiarlas es mandar las dos.
    expect(parse(settingsUpdateSchema, { mainCurrency: 'USD', secondCurrency: 'DOP' })).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    expect(messageOf(() => parse(settingsUpdateSchema, { mainCurrency: 'USD', secondCurrency: 'USD' }))).toBe(
      'Invalid data: secondCurrency: must be different from mainCurrency',
    );
    for (const currency of ['EUR', 'usd', '', null, 1]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { mainCurrency: currency })), String(currency)).toBe(
        'Invalid data: mainCurrency: must be DOP, USD or TRY',
      );
      expect(() => parse(settingsUpdateSchema, { secondCurrency: currency }), String(currency)).toThrow(ApiError);
    }
  });

  it('cuenta por defecto: un id o null (la automática)', () => {
    expect(parse(settingsUpdateSchema, { defaultAccountId: 'dr' })).toEqual({ defaultAccountId: 'dr' });
    expect(parse(settingsUpdateSchema, { defaultAccountId: null })).toEqual({ defaultAccountId: null });
    for (const defaultAccountId of ['', 'con espacios', 7, {}]) {
      expect(() => parse(settingsUpdateSchema, { defaultAccountId }), JSON.stringify(defaultAccountId)).toThrow(ApiError);
    }
  });

  it('solo cambia lo que viene: tiene que venir algo, y nada desconocido', () => {
    expect(parse(settingsUpdateSchema, { language: 'tr', theme: null })).toEqual({ language: 'tr', theme: null });
    expect(messageOf(() => parse(settingsUpdateSchema, {}))).toBe(
      'Invalid data: nothing to change: send theme, language, mainCurrency, secondCurrency, defaultAccountId or goldPrice',
    );
    expect(messageOf(() => parse(settingsUpdateSchema, { defaultRate: 60 }))).toContain('Unrecognized key: "defaultRate"');
    expect(messageOf(() => parse(settingsUpdateSchema, { language: 'es', initialized: false }))).toContain('Unrecognized key: "initialized"');
  });
});

describe('metas', () => {
  it('goalPlanIssue: los tres juntos (mensual > 0, inicio <= fin) o los tres null', () => {
    // El mensual se llama `monthly` en la API y `monthlyUSD` en el libro de Excel: el mensaje usa el que toque.
    expect(goalPlanIssue({ monthly: 3000, start: null, end: null }, 'monthlyUSD')).toEqual({
      kind: 'partial',
      path: 'monthlyUSD',
      message: 'monthlyUSD, start and end go together: set all three, or leave all three null',
    });
    expect(goalPlanIssue({ monthly: 0, start: '2026-08', end: '2027-10' }, 'monthlyUSD')).toMatchObject({ kind: 'amount', path: 'monthlyUSD' });
    expect(goalPlanIssue({ monthly: null, start: null, end: null })).toBeNull();
    expect(goalPlanIssue({ monthly: 3000, start: '2026-08', end: '2027-10' })).toBeNull();
    expect(goalPlanIssue({ monthly: 0.01, start: '2026-08', end: '2026-08' })).toBeNull();
    for (const plan of [
      { monthly: 3000, start: null, end: null },
      { monthly: null, start: '2026-08', end: '2027-10' },
      { monthly: 3000, start: '2026-08', end: null },
      { monthly: 3000, start: null, end: '2027-10' },
      { monthly: null, start: null, end: '2027-10' },
    ]) {
      expect(goalPlanIssue(plan), JSON.stringify(plan)).toMatchObject({ kind: 'partial', path: 'monthly' });
    }
    expect(goalPlanIssue({ monthly: 0, start: '2026-08', end: '2027-10' })).toMatchObject({ kind: 'amount', path: 'monthly' });
    expect(goalPlanIssue({ monthly: -5, start: '2026-08', end: '2027-10' })).toMatchObject({ kind: 'amount' });
    expect(goalPlanIssue({ monthly: 3000, start: '2027-11', end: '2027-10' })).toMatchObject({ kind: 'order', path: 'end' });
    // El año cuenta: diciembre de 2026 va antes que enero de 2027.
    expect(goalPlanIssue({ monthly: 3000, start: '2026-12', end: '2027-01' })).toBeNull();
  });

  it('crear: el plan se exige completo; sin plan, los tres null o ausentes', () => {
    expect(parse(goalCreateSchema, { name: ' Car ' })).toEqual({ name: 'Car' });
    // La moneda es opcional: sin ella, la principal del usuario.
    expect(parse(goalCreateSchema, { name: 'Car', cur: 'TRY' })).toEqual({ name: 'Car', cur: 'TRY' });
    expect(messageOf(() => parse(goalCreateSchema, { name: 'Car', monthlyUSD: 100 }))).toContain('Unrecognized key: "monthlyUSD"');
    expect(parse(goalCreateSchema, { name: 'Car', monthly: null, start: null, end: null })).toEqual({
      name: 'Car',
      monthly: null,
      start: null,
      end: null,
    });
    const planned = { id: 'trip', name: 'Trip', monthly: 3000, start: '2026-08', end: '2027-10' };
    expect(parse(goalCreateSchema, planned)).toEqual(planned);

    const partial = 'Invalid data: monthly: monthly, start and end go together: set all three, or leave all three null';
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', monthly: 100 }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', end: '2027-01' }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: null }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: '2027-11' }))).toBe(
      'Invalid data: end: the start month cannot be after the end month',
    );
    // Un campo mal escrito se señala una vez, sin sumarle la regla del plan.
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, monthly: 0 }))).toBe('Invalid data: monthly: must be greater than 0');
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: 'zz' }))).toBe('Invalid data: start: is not a valid month (YYYY-MM)');
    // El monto objetivo no viaja (es mensual × meses) y el orden lo pone el servidor.
    expect(() => parse(goalCreateSchema, { ...planned, target: 45000 })).toThrow(ApiError);
    expect(() => parse(goalCreateSchema, { ...planned, sort: 0 })).toThrow(ApiError);
  });

  it('nombre: recortado, no vacío y de hasta 120 caracteres', () => {
    expect(parse(goalCreateSchema, { name: 'x'.repeat(120) }).name).toHaveLength(120);
    expect(messageOf(() => parse(goalCreateSchema, { name: '  ' }))).toBe('Invalid data: name: cannot be empty');
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x'.repeat(121) }))).toBe('Invalid data: name: allows up to 120 characters');
    expect(messageOf(() => parse(goalPatchSchema, { name: '' }))).toBe('Invalid data: name: cannot be empty');
    expect(parse(goalPatchSchema, { name: ' Viaje a Turquía ' })).toEqual({ name: 'Viaje a Turquía' });
  });

  it('editar: cada campo por separado; la regla completa la aplica el repositorio sobre la meta resultante', () => {
    expect(parse(goalPatchSchema, { monthly: null, start: null, end: null })).toEqual({ monthly: null, start: null, end: null });
    // Una sola parte del plan pasa la validación del cuerpo: si vale o no depende de la meta que haya.
    expect(parse(goalPatchSchema, { end: '2027-12' })).toEqual({ end: '2027-12' });
    expect(parse(goalPatchSchema, { monthly: 100 })).toEqual({ monthly: 100 });
    expect(parse(goalPatchSchema, {})).toEqual({});
    expect(parse(goalPatchSchema, { cur: 'DOP' })).toEqual({ cur: 'DOP' });
    expect(() => parse(goalPatchSchema, { cur: null })).toThrow(ApiError);
    // Lo que ya se contradice solo, no.
    expect(messageOf(() => parse(goalPatchSchema, { start: '2027-02', end: '2027-01' }))).toBe(
      'Invalid data: end: the start month cannot be after the end month',
    );
    expect(() => parse(goalPatchSchema, { monthly: 0 })).toThrow(ApiError);
    expect(() => parse(goalPatchSchema, { id: 'otra' })).toThrow(ApiError);
  });
});

describe('registro desde Claude e importación', () => {
  it('ingest: null y vacío se toman como ausentes; lo demás, estricto', () => {
    expect(parse(ingestSchema, { description: ' Pan ', amount: 90, date: null, category: '', notes: ' algo ', user: null })).toEqual({
      description: 'Pan',
      amount: 90,
      notes: 'algo',
    });
    expect(() => parse(ingestSchema, { description: 'Pan', amount: 90, date: '31/10/2026' })).toThrow(ApiError);
    expect(() => parse(ingestSchema, { description: null, amount: 90 })).toThrow(ApiError);
  });

  it('ingest: `user` es texto; quién es lo decide server/ingest.ts con los usuarios configurados', () => {
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, user: ' Eda ' })).toEqual({ description: 'Pan', amount: 90, user: 'Eda' });
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, user: 7 }))).toBe('Invalid data: user: must be text');
    expect(() => parse(ingestSchema, { description: 'Pan', amount: 90, user: ['eda'] })).toThrow(ApiError);
  });

  it('ingest: `account` es texto (un id o un nombre; cuál es lo decide server/ingest.ts) y la moneda puede ser TRY', () => {
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: ' DR account ', currency: 'TRY' })).toEqual({
      description: 'Pan',
      amount: 90,
      account: 'DR account',
      currency: 'TRY',
    });
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: '  ' })).toEqual({ description: 'Pan', amount: 90 });
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: null })).toEqual({ description: 'Pan', amount: 90 });
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, account: 7 }))).toBe('Invalid data: account: must be text');
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, account: 'x'.repeat(121) }))).toBe(
      'Invalid data: account: allows up to 120 characters',
    );
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, accountId: 'dr' }))).toContain('Unrecognized key: "accountId"');
  });

  it('importación: meses repetidos y límites de tamaño', () => {
    const month = { key: '2026-10', closed: false, budget: 0, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] };
    const base = { months: [month], contribs: null, goals: null };
    expect(parse(importSchema, base)).toEqual(base);
    expect(messageOf(() => parse(importSchema, { ...base, months: [month, month] }))).toBe('Invalid data: months: there are repeated months');
    const fixed = Array.from({ length: 501 }, () => ({ name: 'x', day: '', amount: 1, cur: 'DOP', paid: false }));
    expect(messageOf(() => parse(importSchema, { ...base, months: [{ ...month, fixed }] }))).toBe(
      'Invalid data: months.0.fixed: allows up to 500 items',
    );
    const goals = Array.from({ length: 201 }, (_, i) => ({ name: `Meta ${i}`, monthlyUSD: null, start: null, end: null }));
    expect(messageOf(() => parse(importSchema, { ...base, goals }))).toBe('Invalid data: goals: allows up to 200 items');
  });

  it('importación: el libro conserva el formato original, que solo conoce DOP y USD', () => {
    const month = { key: '2026-10', closed: false, budget: 0, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] };
    const fixed = [{ name: 'x', day: '', amount: 1, cur: 'TRY', paid: false }];
    expect(messageOf(() => parse(importSchema, { months: [{ ...month, fixed }], contribs: null, goals: null }))).toBe(
      'Invalid data: months.0.fixed.0.cur: must be DOP or USD',
    );
    const contribs = [{ date: '2026-10-01', goalName: 'x', amount: 1, cur: 'TRY' }];
    expect(messageOf(() => parse(importSchema, { months: [], contribs, goals: null }))).toBe('Invalid data: contribs.0.cur: must be DOP or USD');
    // Y sigue trayendo el presupuesto, el ingreso y los dos saldos del mes: no las partes por cuenta.
    expect(() => parse(importSchema, { months: [{ ...month, budgets: {} }], contribs: null, goals: null })).toThrow(ApiError);
  });

  it('importación: `goals` es obligatorio (null si el libro no trae hoja de ahorros) y cada meta trae su plan completo o ninguno', () => {
    const base = { months: [], contribs: null };
    expect(() => parse(importSchema, base)).toThrow(ApiError);
    // El formato de la versión anterior, con los parámetros de una sola meta, ya no se acepta.
    expect(messageOf(() => parse(importSchema, { ...base, goals: null, turkey: null }))).toContain('Unrecognized key: "turkey"');

    const goals = [
      { name: ' Trip to Turkey ', monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
      { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
    ];
    expect(parse(importSchema, { ...base, goals }).goals).toEqual([{ ...goals[0], name: 'Trip to Turkey' }, goals[1]]);
    expect(parse(importSchema, { ...base, goals: [] }).goals).toEqual([]);

    const partial = 'monthlyUSD, start and end go together: set all three, or leave all three null';
    expect(messageOf(() => parse(importSchema, { ...base, goals: [goals[1], { ...goals[0], start: null }] }))).toBe(
      `Invalid data: goals.1.monthlyUSD: ${partial}`,
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ ...goals[0], monthlyUSD: 0 }] }))).toBe(
      'Invalid data: goals.0.monthlyUSD: must be greater than 0',
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ ...goals[0], end: '2026-07' }] }))).toBe(
      'Invalid data: goals.0.end: the start month cannot be after the end month',
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ name: 'x' }] }))).toContain('goals.0.monthlyUSD: is required');
    expect(() => parse(importSchema, { ...base, goals: [{ ...goals[0], id: 'turkey' }] })).toThrow(ApiError);
  });
});

describe('toApiError', () => {
  it('deja pasar los ApiError, traduce los de zod y oculta todo lo demás', () => {
    const api = new ApiError(409, 'month_closed', 'closed');
    expect(toApiError(api)).toBe(api);

    const zod = txCreateSchema.safeParse({ ...tx, amount: 0 });
    expect(zod.success).toBe(false);
    if (!zod.success) {
      expect(toApiError(zod.error)).toMatchObject({ status: 400, code: 'validation', message: zodMessage(zod.error) });
    }

    for (const err of [new Error('D1_ERROR: no such table: x'), 'texto', null, undefined, { status: 404 }]) {
      expect(toApiError(err)).toMatchObject({ status: 500, code: 'internal', message: 'Internal server error.' });
    }
  });
});
