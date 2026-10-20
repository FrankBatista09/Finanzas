// Credit card as a deferred payment through the repository and the API: migrations 0009 and 0010, "on card" fixed expense,
// other charges, paying (in full or in part, several times) and undoing, validation, closed month, account in use,
// copy on closing the month and import.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { balances, cardCalc, monthCalc } from '../shared/calc';
import { buildExportData } from '../shared/excel/data';
import { seedState } from '../shared/seed';
import type { CloseResponse } from '../shared/api';
import type { CreditCard, FixedExpense, Month, Transaction } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { applyImport, loadState, replaceAll } from './db';
import { client, EDA, FRANK, makeEnv } from './test-util';

const F = FRANK.id;
const OCT = '2026-10';
const GOLD_REJECTED =
  '"Gold" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.';

/** The usual single credit card (the one migration 0011 creates for whoever was already using the credit card). */
const CARD: CreditCard = { id: 'card', name: 'Credit card', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const C = `/api/months/${OCT}/cards/card`;

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, { ...seedState(), cards: [CARD] });
  await replaceAll(t.db, EDA.id, { ...seedState(), cards: [CARD] });
  return { ...t, api: client(t.env) };
}

const balanceOf = (state: Awaited<ReturnType<typeof loadState>>, id: string) => balances(state, OCT).accounts.find((a) => a.account.id === id)!.balance;
const fixedBody = { monthKey: OCT, name: 'Gym', amount: 1000, cur: 'DOP' as const, onCard: true };

describe('migration 0009', () => {
  it('only adds columns and nothing that was there changes', () => {
    const files = migrationFiles();
    const at = files.indexOf('0009_credit_card.sql');
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
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

describe('migration 0010', () => {
  const FILE = '0010_card_payments.sql';
  const files = migrationFiles();

  /** A database with 0001–0009 and three users with the credit card paid in different ways. */
  function before() {
    const at = files.indexOf(FILE);
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at, card_other, card_paid, card_account_id) VALUES
        ('frank', '2026-09', 1, '2026-10-01T04:00:00.000Z', 100, 100, 'us'),
        ('frank', '2026-10', 0, NULL, 500, 300, 'dr'),
        ('frank', '2026-11', 0, NULL, 50, NULL, NULL),
        ('eda', '2026-10', 0, NULL, 0, 40, NULL),
        ('ana', '2026-10', 0, NULL, 0, 40, 'gone');
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES
        ('frank', 'dr', 'DR', 'DOP', 0, 0, 1), ('frank', 'us', 'US', 'USD', 0, 0, 0),
        ('eda', 'e1', 'E1', 'DOP', 0, 0, 0), ('eda', 'e2', 'E2', 'DOP', 0, 0, 1);
      INSERT INTO settings (user_id, key, value) VALUES ('eda', 'default_account', 'e2');
    `);
    return db;
  }
  const payments = (db: ReturnType<typeof before>) =>
    db.sqlite.prepare('SELECT user_id, id, month_key, date, account_id, amount, sort FROM card_payments ORDER BY user_id, month_key').all().map((r) => ({ ...r }));

  it('each month with card_paid becomes a payment: last day, its account or the default one; nothing else changes', () => {
    const db = before();
    const months = db.sqlite.prepare('SELECT * FROM months ORDER BY user_id, key').all().map((r) => ({ ...r }));
    applyMigrations(db, [FILE]);
    expect(payments(db).map(({ id, ...p }) => ({ ...p, idOk: /^[0-9a-f]{32}$/.test(String(id)) }))).toEqual([
      // Eda: no stored account → her default account (e2). Ana: has no accounts → there is nothing to charge it to.
      { user_id: 'eda', month_key: '2026-10', date: '2026-10-31', account_id: 'e2', amount: 40, sort: 0, idOk: true },
      { user_id: 'frank', month_key: '2026-09', date: '2026-09-30', account_id: 'us', amount: 100, sort: 0, idOk: true },
      { user_id: 'frank', month_key: '2026-10', date: '2026-10-31', account_id: 'dr', amount: 300, sort: 0, idOk: true },
    ]);
    // The old columns stay as they were and nothing else changes.
    expect(db.sqlite.prepare('SELECT * FROM months ORDER BY user_id, key').all().map((r) => ({ ...r }))).toEqual(months);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the table requires a month and an account of the same user, and goes away with its month', () => {
    const db = before();
    applyMigrations(db, [FILE]);
    const insert = (user: string, id: string, month: string, account: string) =>
      db.sqlite.exec(`INSERT INTO card_payments (user_id, id, month_key, date, account_id, amount) VALUES ('${user}', '${id}', '${month}', '2026-10-01', '${account}', 1)`);
    expect(() => insert('frank', 'x', '2026-10', 'e1')).toThrow(); // the account is Eda's
    expect(() => insert('frank', 'x', '2030-01', 'dr')).toThrow(); // the month does not exist
    insert('frank', 'x', '2026-10', 'dr');
    insert('frank', 'y', '2026-10', 'us'); // several payments in the same month
    expect(() => insert('frank', 'y', '2026-10', 'us')).toThrow(); // key (user_id, id)
    db.sqlite.exec("DELETE FROM months WHERE user_id = 'frank' AND key = '2026-10'");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM card_payments WHERE id IN ('x', 'y')").get()).toEqual({ n: 0 });
  });

  it('the server reads what was copied as payments and the balances match the earlier ones', async () => {
    const db = before();
    // With 0011 after it (today's server needs it): the single credit card 'card'.
    applyMigrations(db, [FILE, ...files.slice(files.indexOf(FILE) + 1)]);
    const state = await loadState(db as unknown as Parameters<typeof loadState>[0], 'frank');
    expect(state.months['2026-10']!.cards).toEqual([{ cardId: 'card', other: 500, payments: [{ id: expect.any(String), date: '2026-10-31', accountId: 'dr', amount: 300 }] }]);
    expect(state.months['2026-11']!.cards).toEqual([{ cardId: 'card', other: 50, payments: [] }]);
    expect(cardCalc(state, '2026-10', 'card')).toMatchObject({ paid: 300, remainder: 200 });
  });
});

describe('fixed expense on card', () => {
  it('is created and edited with onCard; a regular one does not carry it; checking it subtracts from no account', async () => {
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
    expect(cardCalc(state, OCT, 'card')).toMatchObject({ charged: 1000, total: 1000 });

    // Taking it off the card: it subtracts from its account again.
    expect((await api.patch<FixedExpense>(`/api/fixed/${created.body.id}`, { onCard: false })).body.onCard).toBeUndefined();
    expect(balanceOf(await loadState(db, F), 'dr')).toBe(before - 1000);
    expect((await api.post('/api/fixed', { ...fixedBody, onCard: 'yes' })).status).toBe(400);
  });

  it('on closing the month, the next one keeps "on card", unchecked, and the unpaid balance carries over on its own', async () => {
    const { api, db } = await seeded();
    await api.post('/api/fixed', { ...fixedBody, paid: true });
    const taxi = await api.post<Transaction>('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'Taxi', cat: 'Transport', method: 'Credit card', amount: 200, cur: 'DOP' });
    await api.post(`${C}/include-purchases`, { transactionIds: [taxi.body.id], destination: 'history' });
    await api.patch(`${C}/other`, { other: 300 });
    await api.post(`${C}/pay`, { amount: 500, accountId: 'dr' });
    const closed = (await api.post<CloseResponse>(`/api/months/${OCT}/close`)).body;
    expect(closed.next.fixed.filter((f) => f.onCard)).toMatchObject([{ name: 'Gym', paid: false }]);
    // Nothing is stored in the new month: what remained (1,500 − 500) comes from the previous one.
    expect(closed.next.cards).toBeUndefined();
    expect(cardCalc(await loadState(db, F), '2026-11', 'card')).toMatchObject({ previous: 1000, total: 1000 });
  });
});

describe('other charges and credit card payment', () => {
  it('stores other charges and adds them to the total; a month without a credit card keeps its shape', async () => {
    const { api } = await seeded();
    const r = await api.patch<Month>(`${C}/other`, { other: 250.5 });
    expect(r.body.cards).toEqual([{ cardId: 'card', other: 250.5, payments: [] }]);
    expect(cardCalc((await api.get<StateResponse>('/api/state')).body.state, OCT, 'card').total).toBe(250.5);
    const cleared = await api.patch<Month>(`${C}/other`, { other: 0 });
    expect('cards' in cleared.body).toBe(false);
    expect((await api.patch(`${C}/other`, { other: -1 })).status).toBe(400);
  });

  it('pays in part and only then subtracts from the account; several payments add up; removing one or all gives it back', async () => {
    const { api, db } = await seeded();
    const base = await loadState(db, F);
    await api.patch(`${C}/other`, { other: 1000 });
    const taxi = await api.post<Transaction>('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'Taxi', cat: 'Transport', method: 'Credit card', amount: 500, cur: 'DOP' });
    await api.post(`${C}/include-purchases`, { transactionIds: [taxi.body.id], destination: 'history' });
    let state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBe(balanceOf(base, 'dr'));
    expect(monthCalc(state, OCT).used).toBeCloseTo(monthCalc(base, OCT).used, 9);

    const first = await api.post<Month>(`${C}/pay`, { id: 'pay1', amount: 400, date: '2026-10-10' });
    expect(first.body.cards).toEqual([{ cardId: 'card', other: 1000, payments: [{ id: 'pay1', date: '2026-10-10', accountId: 'dr', amount: 400 }] }]);
    state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 400, 9);
    expect(monthCalc(state, OCT).used).toBeCloseTo(monthCalc(base, OCT).used + 400, 9);
    expect(cardCalc(state, OCT, 'card')).toMatchObject({ paid: 400, remainder: 1100 });

    // Another payment does NOT replace the previous one: it is added to it, can come from another account (in its currency) and by default repeats the last one's account.
    const second = await api.post<Month>(`${C}/pay`, { amount: 587.6, accountId: 'us' });
    expect(second.body.cards![0]!.payments.map((p) => [p.accountId, p.amount])).toEqual([['dr', 400], ['us', 587.6]]);
    const third = await api.post<Month>(`${C}/pay`, { amount: 100 });
    expect(third.body.cards![0]!.payments[2]).toMatchObject({ accountId: 'us', amount: 100 });
    state = await loadState(db, F);
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 400, 9);
    expect(balanceOf(state, 'us')).toBeCloseTo(balanceOf(base, 'us') - 687.6 / 58.76, 9);
    expect(cardCalc(state, OCT, 'card')).toMatchObject({ paid: 1087.6 });
    // What is left stays pending this month.
    expect(monthCalc(state, OCT).pending).toBeCloseTo(monthCalc(base, OCT).pending + 412.4, 9);

    // Removing a single one; one that does not exist is a 404.
    const one = await api.del<Month>(`${C}/pay/pay1`);
    expect(one.body.cards![0]!.payments.map((p) => p.amount)).toEqual([587.6, 100]);
    expect((await api.del(`${C}/pay/pay1`)).status).toBe(404);
    expect((await api.del(`${C}/pay/${third.body.cards![0]!.payments[2]!.id}x`)).status).toBe(404);

    const undone = await api.del<Month>(`${C}/pay`);
    expect(undone.body.cards).toEqual([{ cardId: 'card', other: 1000, payments: [] }]);
    expect(balanceOf(await loadState(db, F), 'us')).toBe(balanceOf(base, 'us'));
  });

  it('validates: the amount does not exceed the total, > 0, unknown or gold account, closed or nonexistent month', async () => {
    const { api, db } = await seeded();
    await api.post('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100 });
    await api.patch(`${C}/other`, { other: 1000 });
    const snapshot = JSON.stringify(await loadState(db, F));
    const pay = (body: unknown, key = OCT) => api.post(`/api/months/${key}/cards/card/pay`, body);
    const bad: [unknown, number, unknown][] = [
      [{ amount: 1000.01 }, 400, 'amount: Credit card has 1000.00 left to pay in 2026-10; it cannot be paid for more than that.'],
      [{ amount: 10, date: '2026-09-30' }, 400, 'Invalid data: date: must be a date in 2026-10'],
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
    expect((await api.patch('/api/months/2026-09/cards/card/other', { other: 1 })).error?.code).toBe('month_closed');
    expect((await api.del('/api/months/2026-09/cards/card/pay')).error?.code).toBe('month_closed');
    expect(JSON.stringify(await loadState(db, F))).toBe(snapshot);
    // Exactly what is left can be paid; after that there is nothing left.
    expect((await pay({ amount: 400 })).status).toBe(200);
    expect((await pay({ amount: 600.01 })).error?.message).toBe('amount: Credit card has 600.00 left to pay in 2026-10; it cannot be paid for more than that.');
    expect((await pay({ amount: 600 })).status).toBe(200);
    expect((await pay({ amount: 1 })).status).toBe(400);
  });

  it('with nothing to pay it cannot be paid; the account of the payment prevents deleting the account', async () => {
    const { api } = await seeded();
    expect((await api.post(`${C}/pay`, { amount: 1 })).error?.message).toBe('There is nothing left to pay on Credit card in 2026-10.');
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'DOP' });
    await api.patch(`${C}/other`, { other: 50 });
    await api.post(`${C}/pay`, { amount: 50, accountId: 'extra' });
    expect((await api.del('/api/accounts/extra')).status).toBe(409);
    await api.del(`${C}/pay`);
    expect((await api.del('/api/accounts/extra')).status).toBe(200);
  });
});

describe('Excel', () => {
  it('importing keeps the credit card of the month, and the workbook balances follow the app', async () => {
    const { api, db } = await seeded();
    await api.patch(`${C}/other`, { other: 700 });
    await api.post(`${C}/pay`, { amount: 300, accountId: 'dr' });
    const state = await loadState(db, F);
    const book = buildExportData(state);
    const oct = book.months.find((m) => m.key === OCT)!;
    // The 300 payment is already subtracted from the workbook balance; the workbook rows do not change.
    expect(oct.accounts.dop).toBeCloseTo(buildExportData(seedState()).months.find((m) => m.key === OCT)!.accounts.dop! - 300, 6);

    const payload = {
      months: book.months.map((m) => ({ key: m.key, closed: state.months[m.key]!.closed, budget: m.budget ?? 0, incomeUSD: m.incomeUSD ?? 0, accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 }, fixed: m.fixed, transfers: m.transfers, tx: m.tx })),
      contribs: null,
      goals: null,
    } as Parameters<typeof applyImport>[2];
    await applyImport(db, F, payload);
    const after = await loadState(db, F);
    expect(after.months[OCT]!.cards).toEqual([{ cardId: 'card', other: 700, payments: [expect.objectContaining({ accountId: 'dr', amount: 300 })] }]);
    expect(balanceOf(after, 'dr')).toBeCloseTo(balanceOf(state, 'dr'), 4);
  });
});
