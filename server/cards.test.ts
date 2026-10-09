// Varias tarjetas de crédito: migración 0011 (una tarjeta por usuario que ya usaba la implícita, sin cambiar ninguna cifra),
// API de tarjetas (validación, apagar y borrar), pagos y otros cargos por tarjeta, gastos y transacciones con su tarjeta,
// copia al cerrar el mes e importación.

import { describe, expect, it } from 'vitest';
import type { CloseResponse, StateResponse } from '../shared/api';
import { balances, cardCalc, monthCalc } from '../shared/calc';
import { buildExportData } from '../shared/excel/data';
import { seedState } from '../shared/seed';
import type { CreditCard, FixedExpense, Month, Transaction } from '../shared/types';
import { applyMigrations, asD1, createTestDb, migrationFiles } from './d1-node';
import { applyImport, loadState, replaceAll } from './db';
import { client, EDA, FRANK, makeEnv } from './test-util';

const F = FRANK.id;
const OCT = '2026-10';
const FILE = '0011_credit_cards.sql';

describe('migración 0011', () => {
  const files = migrationFiles();
  const at = files.indexOf(FILE);

  /** La base de producción hoy (0001–0010) con datos de tarjeta de cuatro usuarios y de uno que no la usa. */
  function before() {
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at, card_other) VALUES
        ('frank', '2026-09', 1, '2026-10-01T04:00:00.000Z', 1000), ('frank', '2026-10', 0, NULL, 300),
        ('eda', '2026-10', 0, NULL, 0), ('ana', '2026-10', 0, NULL, 0), ('bob', '2026-10', 0, NULL, 0), ('cy', '2026-10', 0, NULL, 0);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES
        ('frank', 'dr', 'DR', 'DOP', 100000, 0, 0), ('frank', 'us', 'US', 'USD', 500, 0, 1),
        ('eda', 'e', 'E', 'TRY', 5000, 0, 0), ('ana', 'a', 'A', 'DOP', 100, 0, 0),
        ('bob', 'b', 'B', 'DOP', 100, 0, 0), ('cy', 'c', 'C', 'DOP', 100, 0, 0);
      INSERT INTO settings (user_id, key, value) VALUES ('eda', 'main_currency', 'TRY'), ('eda', 'second_currency', 'USD');
      INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort, on_card) VALUES
        ('frank', 'f1', '2026-10', 'Gym', '', 500, 'DOP', 1, 'dr', 0, 1),
        ('frank', 'f2', '2026-10', 'Rent', '', 2000, 'DOP', 1, 'dr', 1, 0),
        ('bob', 'bf', '2026-10', 'Net', '', 10, 'DOP', 0, 'b', 0, 1);
      INSERT INTO transactions (user_id, id, month_key, date, description, category, method, amount, currency, account_id) VALUES
        ('frank', 't1', '2026-10', '2026-10-03', 'Taxi', 'Transport', 'Credit card', 200, 'DOP', 'dr'),
        ('frank', 't2', '2026-10', '2026-10-04', 'Lunch', 'Food', 'Debit card', 50, 'DOP', 'dr'),
        ('eda', 'et', '2026-10', '2026-10-03', 'Bus', 'Transport', 'Credit card', 30, 'TRY', 'e'),
        ('ana', 'at', '2026-10', '2026-10-03', 'Lunch', 'Food', 'Debit card', 5, 'DOP', 'a');
      INSERT INTO card_payments (user_id, id, month_key, date, account_id, amount, sort) VALUES
        ('frank', 'p1', '2026-09', '2026-09-30', 'dr', 400, 0), ('frank', 'p2', '2026-10', '2026-10-20', 'us', 5, 0),
        ('cy', 'cp', '2026-10', '2026-10-05', 'c', 7, 0);
    `);
    return db;
  }

  const rows = (db: ReturnType<typeof before>, sql: string) => db.sqlite.prepare(sql).all().map((r) => ({ ...r }));

  it('crea la tarjeta «Credit card» solo a quien tenía datos de tarjeta, en su moneda principal, y la apunta todo', () => {
    const db = before();
    applyMigrations(db, [FILE]);
    expect(rows(db, 'SELECT * FROM credit_cards ORDER BY user_id')).toEqual(
      // Bob solo tenía un gasto fijo en tarjeta sin pagar, Cy solo un pago; Ana no usaba la tarjeta.
      ['bob', 'cy', 'eda', 'frank'].map((user_id) => ({
        user_id,
        id: 'card',
        name: 'Credit card',
        bank: null,
        last4: null,
        currency: user_id === 'eda' ? 'TRY' : 'DOP',
        credit_limit: null,
        cutoff_day: null,
        due_day: null,
        active: 1,
        sort: 0,
      })),
    );
    expect(rows(db, 'SELECT user_id, month_key, card_id, other FROM month_cards')).toEqual([
      { user_id: 'frank', month_key: '2026-09', card_id: 'card', other: 1000 },
      { user_id: 'frank', month_key: '2026-10', card_id: 'card', other: 300 },
    ]);
    expect(rows(db, 'SELECT user_id, id, card_id FROM fixed_expenses ORDER BY id')).toEqual([
      { user_id: 'bob', id: 'bf', card_id: 'card' },
      { user_id: 'frank', id: 'f1', card_id: 'card' },
      { user_id: 'frank', id: 'f2', card_id: null },
    ]);
    expect(rows(db, 'SELECT id, card_id FROM transactions ORDER BY id')).toEqual([
      { id: 'at', card_id: null },
      { id: 'et', card_id: 'card' },
      { id: 't1', card_id: 'card' },
      { id: 't2', card_id: null },
    ]);
    expect(rows(db, 'SELECT user_id, id, month_key, card_id, date, account_id, amount, sort FROM card_payments ORDER BY id')).toEqual([
      { user_id: 'cy', id: 'cp', month_key: '2026-10', card_id: 'card', date: '2026-10-05', account_id: 'c', amount: 7, sort: 0 },
      { user_id: 'frank', id: 'p1', month_key: '2026-09', card_id: 'card', date: '2026-09-30', account_id: 'dr', amount: 400, sort: 0 },
      { user_id: 'frank', id: 'p2', month_key: '2026-10', card_id: 'card', date: '2026-10-20', account_id: 'us', amount: 5, sort: 0 },
    ]);
    // Las columnas viejas de months se quedan como estaban, y la base sigue coherente.
    expect(rows(db, "SELECT card_other FROM months WHERE user_id = 'frank' ORDER BY key")).toEqual([{ card_other: 1000 }, { card_other: 300 }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('el total, lo pagado, lo que falta, lo usado, lo pendiente y los saldos salen idénticos a los de antes', async () => {
    const db = before();
    applyMigrations(db, [FILE]);
    const state = await loadState(asD1(db), 'frank');
    expect(state.cards).toEqual([expect.objectContaining({ id: 'card', name: 'Credit card', cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true })]);

    // Lo de siempre, a mano: septiembre 1,000 − 400 pagados; octubre arrastra 600, suma 300 de otros cargos y lo cargado
    // (500 de Gym y 200 de Taxi) = 1,600, pagados 5 USD (294 DOP a 58.76… en la moneda de la tarjeta, 5 → no: el pago es de 5).
    expect(cardCalc(state, '2026-09', 'card')).toMatchObject({ previous: 0, other: 1000, charged: 0, total: 1000, paid: 400, remainder: 600 });
    expect(cardCalc(state, OCT, 'card')).toMatchObject({ previous: 600, other: 300, charged: 700, total: 1600, paid: 5, remainder: 1595 });

    // Sin tarjeta (como antes de pagarla ni cargarle nada) el mes de octubre de Frank sería este:
    const bare = { ...state, cards: [], months: { ...state.months, '2026-09': { ...state.months['2026-09']!, cards: undefined }, [OCT]: { ...state.months[OCT]!, cards: undefined } } };
    const withCard = monthCalc(state, OCT);
    const without = monthCalc(bare, OCT);
    // Lo pagado entra a lo usado; lo que falta de la tarjeta (1,595) es un pendiente más.
    expect(withCard.used).toBeCloseTo(without.used + 5, 9);
    expect(withCard.pending).toBeCloseTo(without.pending + 1595, 9);
    expect(withCard.cards).toHaveLength(1);

    // Saldos: solo los pagos restan (400 DOP de la cuenta DR en septiembre; 5 de la moneda de la tarjeta, DOP, de la US).
    const bal = (s: typeof state, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;
    expect(bal(state, 'dr')).toBeCloseTo(bal(bare, 'dr') - 400, 9);
    expect(bal(state, 'us')).toBeCloseTo(bal(bare, 'us') - 5 / 58.76, 6);
  });

  it('quien no usaba la tarjeta no recibe ninguna; la de Eda es en liras', async () => {
    const db = before();
    applyMigrations(db, [FILE]);
    expect((await loadState(asD1(db), 'ana')).cards).toEqual([]);
    expect((await loadState(asD1(db), 'eda')).cards).toEqual([expect.objectContaining({ cur: 'TRY' })]);
  });

  it('la clave exige la tarjeta del mismo usuario', () => {
    const db = before();
    applyMigrations(db, [FILE]);
    const insert = (user: string, card: string) =>
      db.sqlite.exec(`INSERT INTO card_payments (user_id, id, month_key, card_id, date, account_id, amount) VALUES ('${user}', 'z', '2026-10', '${card}', '2026-10-01', '${user === 'frank' ? 'dr' : 'c'}', 1)`);
    expect(() => insert('frank', 'nope')).toThrow();
    expect(() => insert('ana', 'card')).toThrow(); // Ana no tiene tarjeta
    insert('frank', 'card');
  });
});

// ── La API ───────────────────────────────────────────────────────────────────

async function fresh() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, EDA.id, { ...seedState(), mainCurrency: 'TRY', secondCurrency: 'USD' });
  return { ...t, api: client(t.env), eda: client(t.env, EDA.id) };
}

type Api = Awaited<ReturnType<typeof fresh>>['api'];
const add = async (api: Api, body: Record<string, unknown>) => (await api.post<CreditCard>('/api/credit-cards', body)).body;

describe('CRUD de tarjetas', () => {
  it('crea con lo mínimo (moneda: la principal del usuario), lista y llega en el estado', async () => {
    const { api, eda } = await fresh();
    expect((await api.get<CreditCard[]>('/api/credit-cards')).body).toEqual([]);
    const made = await api.post<CreditCard>('/api/credit-cards', { name: 'Visa' });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ id: expect.any(String), name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 });
    expect((await eda.post<CreditCard>('/api/credit-cards', { name: 'Visa' })).body.cur).toBe('TRY');
    const full = await add(api, { id: 'mc', name: ' Master ', bank: 'Banreservas', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null });
    expect(full).toMatchObject({ id: 'mc', name: 'Master', bank: 'Banreservas', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null, sort: 1 });
    expect((await api.get<StateResponse>('/api/state')).body.state.cards.map((c) => c.name)).toEqual(['Visa', 'Master']);
    // Cada usuario tiene las suyas.
    expect((await eda.get<CreditCard[]>('/api/credit-cards')).body.map((c) => c.name)).toEqual(['Visa']);
  });

  it('valida el cuerpo: nombre, límite > 0, corte y pago entre 1 y 31, 4 dígitos, moneda, claves desconocidas', async () => {
    const { api } = await fresh();
    const bad: [Record<string, unknown>, string][] = [
      [{}, 'name: is required'],
      [{ name: '' }, 'name: cannot be empty'],
      [{ name: 'x'.repeat(121) }, 'name: allows up to 120 characters'],
      [{ name: 'A', limit: 0 }, 'limit: must be greater than 0'],
      [{ name: 'A', limit: -5 }, 'limit: must be greater than 0'],
      [{ name: 'A', cutoffDay: 0 }, 'cutoffDay: must be between 1 and 31'],
      [{ name: 'A', cutoffDay: 32 }, 'cutoffDay: must be between 1 and 31'],
      [{ name: 'A', cutoffDay: 1.5 }, 'cutoffDay: must be a whole number'],
      [{ name: 'A', dueDay: 32 }, 'dueDay: must be between 1 and 31'],
      [{ name: 'A', last4: '12a4' }, 'last4: must be 4 digits'],
      [{ name: 'A', last4: '123' }, 'last4: must be 4 digits'],
      [{ name: 'A', cur: 'XAU' }, 'cur: must be DOP, USD or TRY'],
      [{ name: 'A', extra: 1 }, 'Unrecognized key'],
    ];
    for (const [body, message] of bad) {
      const r = await api.post('/api/credit-cards', body);
      expect([r.status, r.error?.code], JSON.stringify(body)).toEqual([400, 'validation']);
      expect(r.error?.message, JSON.stringify(body)).toContain(message);
    }
    expect((await api.get<CreditCard[]>('/api/credit-cards')).body).toEqual([]);
    for (const day of [1, 31]) expect((await api.post('/api/credit-cards', { name: `D${day}`, cutoffDay: day, dueDay: day })).status).toBe(201);
  });

  it('el nombre es único sin distinguir mayúsculas; editar y 404', async () => {
    const { api } = await fresh();
    const visa = await add(api, { name: 'Visa' });
    expect((await api.post('/api/credit-cards', { name: 'visa' })).status).toBe(409);
    const other = await add(api, { name: 'Master' });
    expect((await api.patch(`/api/credit-cards/${other.id}`, { name: 'VISA' })).status).toBe(409);
    const edited = await api.patch<CreditCard>(`/api/credit-cards/${visa.id}`, { bank: 'Popular', limit: 60000, cutoffDay: 13, dueDay: 5 });
    expect(edited.body).toMatchObject({ name: 'Visa', bank: 'Popular', limit: 60000, cutoffDay: 13, dueDay: 5 });
    // null borra el dato opcional.
    expect((await api.patch<CreditCard>(`/api/credit-cards/${visa.id}`, { dueDay: null, limit: null })).body).toMatchObject({ dueDay: null, limit: null });
    expect((await api.patch(`/api/credit-cards/${visa.id}`, { cutoffDay: 99 })).status).toBe(400);
    expect((await api.patch('/api/credit-cards/nope', { name: 'x' })).status).toBe(404);
    expect((await api.del('/api/credit-cards/nope')).status).toBe(404);
  });
});

describe('apagar y borrar', () => {
  it('apagar: solo si el último mes no debe nada ni tiene cargos', async () => {
    const { api } = await fresh();
    const visa = await add(api, { name: 'Visa' });
    const off = (id = visa.id) => api.patch<CreditCard>(`/api/credit-cards/${id}`, { active: false });
    await api.patch(`/api/months/${OCT}/cards/${visa.id}/other`, { other: 100 });
    const refused = await off();
    expect([refused.status, refused.error?.code, refused.error?.message]).toEqual([409, 'conflict', 'Pay off Visa before turning it off.']);
    await api.post(`/api/months/${OCT}/cards/${visa.id}/pay`, { amount: 100 });
    const ok = await off();
    expect(ok.body.active).toBe(false);
    // Volver a encenderla siempre se puede.
    expect((await api.patch<CreditCard>(`/api/credit-cards/${visa.id}`, { active: true })).body.active).toBe(true);
    // Con algo cargado en el mes (aunque lo pagado lo deje en cero) tampoco.
    await api.post('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'Taxi', cat: 'Transport', method: 'Credit card', amount: 50, cur: 'DOP', cardId: visa.id });
    expect((await off()).status).toBe(409);
  });

  it('borrar: solo si nada la usa (pagos, otros cargos, gastos, transacciones, o lo que va a la primera activa sin nombrarla)', async () => {
    const { api } = await fresh();
    const a = await add(api, { name: 'A' });
    const b = await add(api, { name: 'B' });
    const c = await add(api, { name: 'C' });
    // Nada la usa: se borra.
    expect((await api.del(`/api/credit-cards/${c.id}`)).status).toBe(200);
    // Otros cargos ≠ 0, un pago, un gasto fijo, una transacción.
    await api.patch(`/api/months/${OCT}/cards/${a.id}/other`, { other: 40 });
    expect((await api.del(`/api/credit-cards/${a.id}`)).status).toBe(409);
    await api.patch(`/api/months/${OCT}/cards/${a.id}/other`, { other: 0 }); // en 0 ya no cuenta
    expect((await api.del<Record<string, never>>(`/api/credit-cards/${b.id}`)).status).toBe(200);
    const d = await add(api, { name: 'D' });
    await api.post('/api/fixed', { monthKey: OCT, name: 'Gym', amount: 5, cur: 'DOP', onCard: true, cardId: d.id });
    const inUse = await api.del(`/api/credit-cards/${d.id}`);
    expect([inUse.status, inUse.error?.code]).toEqual([409, 'conflict']);
    const e = await add(api, { name: 'E' });
    await api.post('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'x', cat: 'Food', method: 'Credit card', amount: 5, cur: 'DOP', cardId: e.id });
    expect((await api.del(`/api/credit-cards/${e.id}`)).status).toBe(409);
    const g = await add(api, { name: 'G' });
    await api.patch(`/api/months/${OCT}/cards/${g.id}/other`, { other: 10 });
    await api.post(`/api/months/${OCT}/cards/${g.id}/pay`, { amount: 10 });
    expect((await api.del(`/api/credit-cards/${g.id}`)).status).toBe(409);
  });

  it('una transacción sin tarjeta nombrada (importada) cuenta como uso de la primera activa', async () => {
    const { api, db } = await fresh();
    const a = await add(api, { name: 'A' });
    const b = await add(api, { name: 'B' });
    await db
      .prepare("INSERT INTO transactions (user_id, id, month_key, date, description, category, method, amount, currency, account_id) VALUES ('frank', 'imp', ?, '2026-10-01', 'x', 'Food', 'Credit card', 5, 'DOP', 'dr')")
      .bind(OCT)
      .run();
    expect((await api.del(`/api/credit-cards/${b.id}`)).status).toBe(200);
    expect((await api.del(`/api/credit-cards/${a.id}`)).status).toBe(409);
  });

  it('cambiar la moneda de una tarjeta con movimientos se rechaza', async () => {
    const { api } = await fresh();
    const a = await add(api, { name: 'A' });
    expect((await api.patch(`/api/credit-cards/${a.id}`, { cur: 'USD' })).body).toMatchObject({ cur: 'USD' });
    await api.patch(`/api/months/${OCT}/cards/${a.id}/other`, { other: 40 });
    expect((await api.patch(`/api/credit-cards/${a.id}`, { cur: 'TRY' })).status).toBe(409);
    expect((await api.patch(`/api/credit-cards/${a.id}`, { cur: 'USD' })).status).toBe(200);
  });
});

describe('con varias tarjetas', () => {
  it('otros cargos y pagos van por tarjeta, en la moneda de cada una', async () => {
    const { api, db } = await fresh();
    const visa = await add(api, { name: 'Visa' });
    const usd = await add(api, { name: 'Dollars', cur: 'USD' });
    await api.patch(`/api/months/${OCT}/cards/${visa.id}/other`, { other: 1000 });
    const m = await api.patch<Month>(`/api/months/${OCT}/cards/${usd.id}/other`, { other: 20 });
    expect(m.body.cards).toEqual(expect.arrayContaining([{ cardId: visa.id, other: 1000, payments: [] }, { cardId: usd.id, other: 20, payments: [] }]));
    // 21 USD son más de lo que debe esa tarjeta (20).
    const over = await api.post(`/api/months/${OCT}/cards/${usd.id}/pay`, { amount: 21 });
    expect(over.error?.message).toBe('amount: Dollars has 20.00 left to pay in 2026-10; it cannot be paid for more than that.');
    const paid = await api.post<Month>(`/api/months/${OCT}/cards/${usd.id}/pay`, { amount: 5, accountId: 'us' });
    expect(paid.body.cards!.find((c) => c.cardId === usd.id)!.payments).toMatchObject([{ accountId: 'us', amount: 5 }]);
    expect(paid.body.cards!.find((c) => c.cardId === visa.id)!.payments).toEqual([]);
    const state = await loadState(db, F);
    const before = balances(await loadState(db, EDA.id), OCT).accounts.find((a) => a.account.id === 'us')!.balance;
    // 5 USD desde la cuenta en USD: 5 de su saldo.
    expect(balances(state, OCT).accounts.find((a) => a.account.id === 'us')!.balance).toBeCloseTo(before - 5, 9);
    expect(cardCalc(state, OCT, usd.id).remainder).toBe(15);
    expect(cardCalc(state, OCT, visa.id).remainder).toBe(1000);
    // Quitar el pago de una tarjeta no toca el de la otra; un pago de otra tarjeta no se encuentra.
    const pid = paid.body.cards!.find((c) => c.cardId === usd.id)!.payments[0]!.id;
    expect((await api.del(`/api/months/${OCT}/cards/${visa.id}/pay/${pid}`)).status).toBe(404);
    expect((await api.del(`/api/months/${OCT}/cards/${usd.id}/pay/${pid}`)).status).toBe(200);
    // Tarjeta desconocida: 404, también en un mes cerrado.
    for (const r of [
      await api.patch(`/api/months/${OCT}/cards/nope/other`, { other: 1 }),
      await api.post(`/api/months/${OCT}/cards/nope/pay`, { amount: 1 }),
      await api.del(`/api/months/${OCT}/cards/nope/pay`),
      await api.del(`/api/months/${OCT}/cards/nope/pay/x`),
    ]) {
      expect([r.status, r.error?.code]).toEqual([404, 'not_found']);
    }
    expect((await api.patch(`/api/months/2026-09/cards/${visa.id}/other`, { other: 1 })).error?.code).toBe('month_closed');
    expect((await api.post(`/api/months/${OCT}/cards/${visa.id}/pay`, { amount: 1000 })).status).toBe(200);
  });

  it('un gasto fijo o una transacción llevan su tarjeta; sin decir, la primera activa; con otro método, ninguna', async () => {
    const { api, db } = await fresh();
    const none = await api.post(`/api/transactions`, { monthKey: OCT, date: '2026-10-08', desc: 'x', cat: 'Food', method: 'Credit card', amount: 5, cur: 'DOP' });
    expect([none.status, none.error?.message]).toEqual([400, 'There is no active credit card: add one first.']);
    expect((await api.post('/api/fixed', { monthKey: OCT, name: 'Gym', amount: 5, cur: 'DOP', onCard: true })).status).toBe(400);
    const a = await add(api, { name: 'A' });
    const b = await add(api, { name: 'B' });
    const tx = (extra: Record<string, unknown>) => api.post<Transaction>('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'x', cat: 'Food', method: 'Credit card', amount: 5, cur: 'DOP', ...extra });
    expect((await tx({})).body.cardId).toBe(a.id);
    expect((await tx({ cardId: b.id })).body.cardId).toBe(b.id);
    const unknown = await tx({ cardId: 'nope' });
    expect([unknown.status, unknown.error?.message]).toEqual([400, 'Unknown credit card "nope".']);
    // Con otro método la tarjeta no cuenta.
    const debit = await tx({ method: 'Debit card', cardId: b.id });
    expect('cardId' in debit.body).toBe(false);
    // Cambiar el método a crédito le pone la primera activa; quitarlo, la quita.
    const moved = await api.patch<Transaction>(`/api/transactions/${debit.body.id}`, { method: 'Credit card' });
    expect(moved.body.cardId).toBe(a.id);
    expect((await api.patch<Transaction>(`/api/transactions/${debit.body.id}`, { cardId: b.id })).body.cardId).toBe(b.id);
    expect('cardId' in (await api.patch<Transaction>(`/api/transactions/${debit.body.id}`, { method: 'Cash' })).body).toBe(false);

    const fx = await api.post<FixedExpense>('/api/fixed', { monthKey: OCT, name: 'Gym', amount: 5, cur: 'DOP', onCard: true, cardId: b.id });
    expect(fx.body).toMatchObject({ onCard: true, cardId: b.id });
    expect((await api.patch<FixedExpense>(`/api/fixed/${fx.body.id}`, { cardId: a.id })).body.cardId).toBe(a.id);
    const off = await api.patch<FixedExpense>(`/api/fixed/${fx.body.id}`, { onCard: false });
    expect('onCard' in off.body || 'cardId' in off.body).toBe(false);
    const on = await api.patch<FixedExpense>(`/api/fixed/${fx.body.id}`, { onCard: true });
    expect(on.body.cardId).toBe(a.id);
    // Una tarjeta apagada no recibe nada nuevo.
    const c = await add(api, { name: 'C' });
    expect((await api.patch(`/api/credit-cards/${c.id}`, { active: false })).status).toBe(200);
    const toOff = await tx({ cardId: c.id });
    expect([toOff.status, toOff.error?.message]).toEqual([400, 'C is turned off: turn it on first.']);
    const stored = await db.prepare("SELECT card_id FROM transactions WHERE user_id = 'frank' AND method = 'Credit card' ORDER BY rowid").all<{ card_id: string }>();
    expect(stored.results.map((r) => r.card_id)).toEqual([a.id, b.id]);
  });

  it('al cerrar el mes, el siguiente copia los gastos fijos en tarjeta con su tarjeta, sin marcar', async () => {
    const { api } = await fresh();
    const a = await add(api, { name: 'A' });
    const b = await add(api, { name: 'B' });
    await api.post('/api/fixed', { monthKey: OCT, name: 'Gym', amount: 5, cur: 'DOP', onCard: true, cardId: b.id, paid: true });
    await api.post('/api/fixed', { monthKey: OCT, name: 'Spotify', amount: 5, cur: 'DOP', onCard: true });
    const closed = (await api.post<CloseResponse>(`/api/months/${OCT}/close`)).body;
    expect(closed.next.fixed.filter((f) => f.onCard).map((f) => [f.name, f.cardId, f.paid])).toEqual([['Gym', b.id, false], ['Spotify', a.id, false]]);
  });
});

describe('Excel', () => {
  it('importar no borra las tarjetas ni sus otros cargos y pagos', async () => {
    const { api, db } = await fresh();
    const visa = await add(api, { name: 'Visa', limit: 60000, cutoffDay: 13 });
    const usd = await add(api, { name: 'Dollars', cur: 'USD' });
    await api.patch(`/api/months/${OCT}/cards/${visa.id}/other`, { other: 700 });
    await api.patch(`/api/months/${OCT}/cards/${usd.id}/other`, { other: 20 });
    await api.post(`/api/months/${OCT}/cards/${visa.id}/pay`, { amount: 300, accountId: 'dr' });
    const state = await loadState(db, F);
    const book = buildExportData(state);
    const payload = {
      months: book.months.map((m) => ({ key: m.key, closed: state.months[m.key]!.closed, budget: m.budget ?? 0, incomeUSD: m.incomeUSD ?? 0, accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 }, fixed: m.fixed, transfers: m.transfers, tx: m.tx })),
      contribs: null,
      goals: null,
    } as Parameters<typeof applyImport>[2];
    await applyImport(db, F, payload);
    const after = await loadState(db, F);
    expect(after.cards).toEqual(state.cards);
    expect(after.months[OCT]!.cards).toEqual(state.months[OCT]!.cards);
  });
});
