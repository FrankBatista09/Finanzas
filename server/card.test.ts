// Tarjeta de crédito como pago diferido por el repositorio y la API: migración 0009, gasto fijo «en tarjeta»,
// otros cargos, pagar (total o en parte) y deshacer, validación, mes cerrado, cuenta en uso, copia al cerrar el mes
// e importación.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { balances, cardCalc, monthCalc } from '../shared/calc';
import { buildExportData } from '../shared/excel/data';
import { seedState } from '../shared/seed';
import type { CloseResponse } from '../shared/api';
import type { FixedExpense, Month } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { applyImport, loadState, replaceAll } from './db';
import { client, EDA, FRANK, makeEnv } from './test-util';

const F = FRANK.id;
const OCT = '2026-10';
const GOLD_REJECTED =
  '"Gold" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.';

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, EDA.id, seedState());
  return { ...t, api: client(t.env) };
}

const balanceOf = (state: Awaited<ReturnType<typeof loadState>>, id: string) => balances(state, OCT).accounts.find((a) => a.account.id === id)!.balance;
const fixedBody = { monthKey: OCT, name: 'Gym', amount: 1000, cur: 'DOP' as const, onCard: true };

describe('migración 0009', () => {
  it('es la última, solo añade columnas y nada de lo que había cambia', () => {
    const files = migrationFiles();
    expect(files.at(-1)).toBe('0009_credit_card.sql');
    const db = createTestDb(files.slice(0, -1));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES ('frank', '2026-10', 0, NULL);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR account', 'DOP', 100, 0, 0);
      INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort)
        VALUES ('frank', 'f1', '2026-10', 'Tarjeta de credito', '', 100, 'DOP', 0, 'dr', 0);
    `);
    applyMigrations(db, ['0009_credit_card.sql']);
    expect(db.sqlite.prepare('SELECT * FROM months').all().map((r) => ({ ...r }))).toEqual([
      { user_id: 'frank', key: '2026-10', closed: 0, closed_at: null, card_other: 0, card_paid: null, card_account_id: null },
    ]);
    expect(db.sqlite.prepare('SELECT name, paid, on_card FROM fixed_expenses').all().map((r) => ({ ...r }))).toEqual([
      { name: 'Tarjeta de credito', paid: 0, on_card: 0 },
    ]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('gasto fijo en tarjeta', () => {
  it('se crea y se edita con onCard; uno normal no lo trae; marcarlo no le resta a ninguna cuenta', async () => {
    const { api, db } = await seeded();
    const before = balanceOf(await loadState(db, F), 'dr');
    const created = await api.post<FixedExpense>('/api/fixed', fixedBody);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Gym', onCard: true, paid: false });
    const plain = await api.post<FixedExpense>('/api/fixed', { ...fixedBody, name: 'Plain', onCard: undefined });
    expect('onCard' in plain.body).toBe(false);

    const ticked = await api.patch<FixedExpense>(`/api/fixed/${created.body.id}`, { paid: true });
    expect(ticked.body).toMatchObject({ paid: true, onCard: true });
    const state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBe(before);
    expect(cardCalc(state, OCT)).toMatchObject({ charged: 1000, total: 1000 });

    // Quitarle la tarjeta: vuelve a restar de su cuenta.
    expect((await api.patch<FixedExpense>(`/api/fixed/${created.body.id}`, { onCard: false })).body.onCard).toBeUndefined();
    expect(balanceOf(await loadState(db, F), 'dr')).toBe(before - 1000);
    expect((await api.post('/api/fixed', { ...fixedBody, onCard: 'yes' })).status).toBe(400);
  });

  it('al cerrar el mes, el siguiente conserva «en tarjeta» sin marcar y el saldo sin pagar se arrastra solo', async () => {
    const { api, db } = await seeded();
    await api.post('/api/fixed', { ...fixedBody, paid: true });
    await api.post('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'Taxi', cat: 'Transport', method: 'Credit card', amount: 200, cur: 'DOP' });
    await api.patch(`/api/months/${OCT}/card`, { other: 300 });
    await api.post(`/api/months/${OCT}/card/pay`, { amount: 500, accountId: 'dr' });
    const closed = (await api.post<CloseResponse>(`/api/months/${OCT}/close`)).body;
    expect(closed.next.fixed.filter((f) => f.onCard)).toMatchObject([{ name: 'Gym', paid: false }]);
    // Nada se guarda en el mes nuevo: lo que quedó (1,500 − 500) sale del anterior.
    expect(closed.next.card).toBeUndefined();
    expect(cardCalc(await loadState(db, F), '2026-11')).toMatchObject({ previous: 1000, total: 1000 });
  });
});

describe('otros cargos y pago de la tarjeta', () => {
  it('guarda otros cargos y los suma al total; un mes sin tarjeta conserva su forma', async () => {
    const { api } = await seeded();
    const r = await api.patch<Month>(`/api/months/${OCT}/card`, { other: 250.5 });
    expect(r.body.card).toEqual({ other: 250.5, paid: null, accountId: null });
    expect(cardCalc((await api.get<StateResponse>('/api/state')).body.state, OCT).total).toBe(250.5);
    const cleared = await api.patch<Month>(`/api/months/${OCT}/card`, { other: 0 });
    expect('card' in cleared.body).toBe(false);
    expect((await api.patch(`/api/months/${OCT}/card`, { other: -1 })).status).toBe(400);
  });

  it('paga en parte y solo entonces resta de la cuenta; volver a pagar sustituye; deshacer lo devuelve todo', async () => {
    const { api, db } = await seeded();
    const base = await loadState(db, F);
    await api.patch(`/api/months/${OCT}/card`, { other: 1000 });
    await api.post('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'Taxi', cat: 'Transport', method: 'Credit card', amount: 500, cur: 'DOP' });
    let state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBe(balanceOf(base, 'dr'));
    expect(monthCalc(state, OCT).used).toBeCloseTo(monthCalc(base, OCT).used, 9);

    const paid = await api.post<Month>(`/api/months/${OCT}/card/pay`, { amount: 400 });
    expect(paid.body.card).toEqual({ other: 1000, paid: 400, accountId: 'dr' });
    state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 400, 9);
    expect(monthCalc(state, OCT).used).toBeCloseTo(monthCalc(base, OCT).used + 400, 9);
    expect(cardCalc(state, OCT).remainder).toBe(1100);

    // Otro pago sustituye al anterior (no se suma) y puede salir de otra cuenta, en la moneda de esa cuenta.
    await api.post(`/api/months/${OCT}/card/pay`, { amount: 1500, accountId: 'us' });
    state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBe(balanceOf(base, 'dr'));
    expect(balanceOf(state, 'us')).toBeCloseTo(balanceOf(base, 'us') - 1500 / 58.76, 9);

    const undone = await api.del<Month>(`/api/months/${OCT}/card/pay`);
    expect(undone.body.card).toEqual({ other: 1000, paid: null, accountId: null });
    expect(balanceOf(await loadState(db, F), 'us')).toBe(balanceOf(base, 'us'));
  });

  it('valida: el importe no pasa del total, > 0, cuenta desconocida u oro, mes cerrado o inexistente', async () => {
    const { api, db } = await seeded();
    await api.post('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100 });
    await api.patch(`/api/months/${OCT}/card`, { other: 1000 });
    const snapshot = JSON.stringify(await loadState(db, F));
    const pay = (body: unknown, key = OCT) => api.post(`/api/months/${key}/card/pay`, body);
    const bad: [unknown, number, unknown][] = [
      [{ amount: 1000.01 }, 400, 'amount: the card total for 2026-10 is 1000.00; it cannot be paid for more than that.'],
      [{ amount: 0 }, 400, 'Invalid data: amount: must be greater than 0'],
      [{ amount: -5 }, 400, 'Invalid data: amount: must be greater than 0'],
      [{ amount: 10, accountId: 'nope' }, 400, 'Unknown account "nope".'],
      [{ amount: 10, accountId: 'gold' }, 400, GOLD_REJECTED],
      [{ amount: 10, extra: 1 }, 400, expect.stringContaining('Invalid data')],
    ];
    for (const [body, status, message] of bad) {
      const r = await pay(body);
      expect([r.status, r.error?.message], JSON.stringify(body)).toEqual([status, message]);
    }
    expect((await pay({ amount: 1 }, '2026-09')).error?.code).toBe('month_closed');
    expect((await pay({ amount: 1 }, '2030-01')).status).toBe(404);
    expect((await api.patch('/api/months/2026-09/card', { other: 1 })).error?.code).toBe('month_closed');
    expect((await api.del('/api/months/2026-09/card/pay')).error?.code).toBe('month_closed');
    expect(JSON.stringify(await loadState(db, F))).toBe(snapshot);
    // El total exacto sí se puede pagar.
    expect((await pay({ amount: 1000 })).status).toBe(200);
  });

  it('sin nada que pagar no se puede pagar; la cuenta del pago impide eliminar la cuenta', async () => {
    const { api } = await seeded();
    expect((await api.post(`/api/months/${OCT}/card/pay`, { amount: 1 })).error?.message).toBe('There is nothing to pay on the credit card in 2026-10.');
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'DOP' });
    await api.patch(`/api/months/${OCT}/card`, { other: 50 });
    await api.post(`/api/months/${OCT}/card/pay`, { amount: 50, accountId: 'extra' });
    expect((await api.del('/api/accounts/extra')).status).toBe(409);
    await api.del(`/api/months/${OCT}/card/pay`);
    expect((await api.del('/api/accounts/extra')).status).toBe(200);
  });
});

describe('Excel', () => {
  it('importar conserva la tarjeta del mes, y los saldos del libro siguen a la app', async () => {
    const { api, db } = await seeded();
    await api.patch(`/api/months/${OCT}/card`, { other: 700 });
    await api.post(`/api/months/${OCT}/card/pay`, { amount: 300, accountId: 'dr' });
    const state = await loadState(db, F);
    const book = buildExportData(state);
    const oct = book.months.find((m) => m.key === OCT)!;
    // El pago de 300 ya está restado del saldo del libro; las filas del libro no cambian.
    expect(oct.accounts.dop).toBeCloseTo(buildExportData(seedState()).months.find((m) => m.key === OCT)!.accounts.dop! - 300, 6);

    const payload = {
      months: book.months.map((m) => ({ key: m.key, closed: state.months[m.key]!.closed, budget: m.budget ?? 0, incomeUSD: m.incomeUSD ?? 0, accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 }, fixed: m.fixed, transfers: m.transfers, tx: m.tx })),
      contribs: null,
      goals: null,
    } as Parameters<typeof applyImport>[2];
    await applyImport(db, F, payload);
    const after = await loadState(db, F);
    expect(after.months[OCT]!.card).toEqual({ other: 700, paid: 300, accountId: 'dr' });
    expect(balanceOf(after, 'dr')).toBeCloseTo(balanceOf(state, 'dr'), 4);
  });
});
