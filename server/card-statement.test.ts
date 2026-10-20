// Adding Credit-card purchases to a month: migration 0016, the include-purchases endpoint, and what happens to the link
// between a purchase and the fixed expense standing for it when either one changes.

import { describe, expect, it } from 'vitest';
import { cardCalc, cardOwed, cardPurchases, monthCalc } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { CreditCard, FixedExpense, Month, Transaction } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { loadState, replaceAll } from './db';
import { client, FRANK, makeEnv } from './test-util';

const OCT = '2026-10';
const C = `/api/months/${OCT}/cards/visa`;
const card = (id: string, sort: number, extra: Partial<CreditCard> = {}): CreditCard => ({ id, name: id, bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort, ...extra });
const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});

describe('migration 0016', () => {
  const FILE = '0016_card_statement_inclusion.sql';
  it('keeps every row and puts each Credit-card purchase in the month it lives in, settled or not', () => {
    const files = migrationFiles();
    const at = files.indexOf(FILE);
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES ('frank', '2026-09', 1, NULL), ('frank', '2026-10', 0, NULL);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR', 'DOP', 1000, 0, 0);
      INSERT INTO credit_cards (user_id, id, name, currency, active, sort) VALUES ('frank', 'visa', 'Visa', 'DOP', 1, 0);
      INSERT INTO card_payments (user_id, id, month_key, card_id, date, account_id, amount, sort) VALUES ('frank', 'p1', '2026-10', 'visa', '2026-10-09', 'dr', 200, 0);
      INSERT INTO transactions (user_id, id, month_key, date, description, category, method, amount, currency, account_id, card_id, card_payment_id) VALUES
        ('frank', 'sep', '2026-09', '2026-09-03', 'Old', 'Food', 'Credit card', 100, 'DOP', 'dr', 'visa', NULL),
        ('frank', 'paid', '2026-10', '2026-10-03', 'Paid', 'Food', 'Credit card', 200, 'DOP', 'dr', 'visa', 'p1'),
        ('frank', 'open', '2026-10', '2026-10-04', 'Open', 'Food', 'Credit card', 50, 'DOP', 'dr', NULL, NULL),
        ('frank', 'debit', '2026-10', '2026-10-05', 'Debit', 'Food', 'Debit card', 9, 'DOP', 'dr', NULL, NULL);
    `);
    applyMigrations(db, [FILE]);
    expect(db.sqlite.prepare('SELECT id, amount, card_payment_id, card_month, card_fixed_id FROM transactions ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 'debit', amount: 9, card_payment_id: null, card_month: null, card_fixed_id: null },
      { id: 'open', amount: 50, card_payment_id: null, card_month: '2026-10', card_fixed_id: null },
      { id: 'paid', amount: 200, card_payment_id: 'p1', card_month: '2026-10', card_fixed_id: null },
      { id: 'sep', amount: 100, card_payment_id: null, card_month: '2026-09', card_fixed_id: null },
    ]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

/** Sep (closed) has one purchase; Oct (open) has three on Visa (one in USD) and one on Amex. All start unpaid. */
async function seeded(extra: Partial<Transaction>[] = []) {
  const t = makeEnv();
  const seed = seedState();
  const byMonth: Record<string, Transaction[]> = {
    '2026-09': [tx('sep', '2026-09', '2026-09-05', 100, { cardId: 'visa' })],
    [OCT]: [
      tx('a', OCT, '2026-10-03', 200, { cardId: 'visa' }),
      tx('b', OCT, '2026-10-04', 10, { cardId: 'visa', cur: 'USD' }),
      tx('c', OCT, '2026-10-05', 5),
      tx('amex1', OCT, '2026-10-06', 50, { cardId: 'amex' }),
      tx('debit', OCT, '2026-10-07', 40, { method: 'Debit card' }),
      ...extra.map((e, i) => tx(`x${i}`, OCT, '2026-10-08', 1, e)),
    ],
  };
  const months = Object.fromEntries(Object.entries(seed.months).map(([k, m]) => [k, { ...m, tx: byMonth[k] ?? [], fixed: [] }]));
  await replaceAll(t.db, FRANK.id, { ...seed, months, cards: [card('visa', 0), card('amex', 1)] });
  return { ...t, api: client(t.env) };
}

const state = (db: D1Database) => loadState(db, FRANK.id);
const find = async (db: D1Database, id: string) => Object.values((await state(db)).months).flatMap((m) => m.tx).find((t) => t.id === id)!;

describe('POST include-purchases', () => {
  it('history: marks the purchases with the month and creates nothing else', async () => {
    const { api, db } = await seeded();
    const before = await state(db);
    const r = await api.post<Month>(`${C}/include-purchases`, { transactionIds: ['sep', 'a'], destination: 'history' });
    expect(r.status).toBe(200);
    expect((await find(db, 'sep')).cardMonth).toBe(OCT);
    expect((await find(db, 'a')).cardMonth).toBe(OCT);
    expect((await find(db, 'b')).cardMonth).toBeUndefined();
    const after = await state(db);
    expect(after.months[OCT]!.fixed).toEqual(before.months[OCT]!.fixed);
    expect(cardCalc(after, OCT, 'visa').charged).toBe(300);
    expect(cardCalc(after, '2026-09', 'visa').charged).toBe(0);
    // Owed: what the month holds plus the purchases still unpaid (b = 10 USD, c = 5).
    expect(cardOwed(after, OCT, 'visa')).toBeCloseTo(300 + 587.6 + 5, 2);
  });

  it('fixed: creates a ticked fixed expense on the card per purchase and links them, in one batch', async () => {
    const { api, db } = await seeded();
    const r = await api.post<Month>(`${C}/include-purchases`, { transactionIds: ['a', 'b'], destination: 'fixed', fixedIds: ['fa', 'fb'] });
    expect(r.status).toBe(200);
    const s = await state(db);
    const fixed = s.months[OCT]!.fixed;
    expect(fixed).toMatchObject([
      { id: 'fa', name: 'a', amount: 200, cur: 'DOP', paid: true, onCard: true, cardId: 'visa', day: '' },
      { id: 'fb', name: 'b', amount: 10, cur: 'USD', paid: true, onCard: true, cardId: 'visa' },
    ]);
    expect(fixed[1]!.sort).toBeGreaterThan(fixed[0]!.sort);
    expect(await find(db, 'a')).toMatchObject({ cardMonth: OCT, cardFixedId: 'fa' });
    expect(await find(db, 'b')).toMatchObject({ cardMonth: OCT, cardFixedId: 'fb' });
    // Counted once in the card total (through the fixed rows) and once in the categories.
    expect(cardCalc(s, OCT, 'visa').charged).toBeCloseTo(200 + 587.6, 2);
    const food = monthCalc(s, OCT).categories.find((c) => c.name === 'Food')!.value;
    const bare = monthCalc({ ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, fixed: [] } } }, OCT).categories.find((c) => c.name === 'Food')!.value;
    expect(food).toBeCloseTo(bare, 6);
  });

  it('generates the fixed ids when none are sent', async () => {
    const { api, db } = await seeded();
    expect((await api.post(`${C}/include-purchases`, { transactionIds: ['a'], destination: 'fixed' })).status).toBe(200);
    expect((await find(db, 'a')).cardFixedId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await state(db)).months[OCT]!.fixed).toHaveLength(1);
  });

  it('refuses other cards, other methods, unknown ids, repeats, a later month and an already added purchase, writing nothing', async () => {
    const { api, db } = await seeded();
    const post = (body: object) => api.post(`${C}/include-purchases`, body);
    const other = await post({ transactionIds: ['amex1'], destination: 'history' });
    expect([other.status, other.error?.message]).toEqual([400, expect.stringContaining('another card')]);
    const debit = await post({ transactionIds: ['debit'], destination: 'history' });
    expect([debit.status, debit.error?.message]).toEqual([400, expect.stringContaining('not a Credit card purchase')]);
    const unknown = await post({ transactionIds: ['a', 'nope'], destination: 'history' });
    expect([unknown.status, unknown.error?.message]).toEqual([400, expect.stringContaining('does not exist')]);
    expect((await post({ transactionIds: ['a', 'a'], destination: 'history' })).status).toBe(400);
    expect((await post({ transactionIds: [], destination: 'history' })).status).toBe(400);
    expect((await post({ transactionIds: ['a'], destination: 'nowhere' })).status).toBe(400);
    expect((await post({ transactionIds: ['a'], destination: 'fixed', fixedIds: ['x', 'y'] })).status).toBe(400);
    expect((await post({ transactionIds: ['a'] })).status).toBe(400);
    const later = await api.post(`/api/months/2026-09/cards/visa/include-purchases`, { transactionIds: ['a'], destination: 'history' });
    expect(later.status).toBe(409);
    expect((await post({ transactionIds: ['a'], destination: 'history' })).status).toBe(200);
    const again = await post({ transactionIds: ['a', 'c'], destination: 'history' });
    expect([again.status, again.error?.message]).toEqual([400, expect.stringContaining('already added')]);
    expect((await find(db, 'c')).cardMonth).toBeUndefined();
  });

  it('a purchase of a later sheet than the viewed month is refused', async () => {
    const { api } = await seeded();
    // 'a' lives in October, so it cannot be added to September (which is closed anyway: use an open earlier month).
    await api.post('/api/months/2026-08/reopen');
    const r = await api.post(`/api/months/2026-08/cards/visa/include-purchases`, { transactionIds: ['a'], destination: 'history' });
    expect([r.status, r.error?.message]).toEqual([400, expect.stringContaining('dated after')]);
  });

  it('an unknown card answers 404', async () => {
    const { api } = await seeded();
    expect((await api.post(`/api/months/${OCT}/cards/nope/include-purchases`, { transactionIds: ['a'], destination: 'history' })).status).toBe(404);
  });

  it('a card that is off cannot take fixed expenses, but can still mark purchases', async () => {
    const { api, db } = await seeded();
    expect((await api.patch('/api/credit-cards/visa', { active: false })).status).toBe(200);
    const r = await api.post(`${C}/include-purchases`, { transactionIds: ['a'], destination: 'fixed' });
    expect(r.status).toBe(400);
    expect((await state(db)).months[OCT]!.fixed).toEqual([]);
    expect((await find(db, 'a')).cardMonth).toBeUndefined();
    expect((await api.post(`${C}/include-purchases`, { transactionIds: ['a'], destination: 'history' })).status).toBe(200);
  });
});

describe('paying and removing the payment', () => {
  it('completing the month makes the purchases paid, and removing the payment returns them', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/include-purchases`, { transactionIds: ['a'], destination: 'history' });
    expect((await api.post(`${C}/pay`, { id: 'p1', amount: 200, accountId: 'dr', date: '2026-10-12' })).status).toBe(200);
    let purchase = cardPurchases(await state(db), OCT, 'visa').find((p) => p.tx.id === 'a')!;
    expect([purchase.status, purchase.payment?.date]).toEqual(['paid', '2026-10-12']);
    expect((await api.del(`${C}/pay/p1`)).status).toBe(200);
    purchase = cardPurchases(await state(db), OCT, 'visa').find((p) => p.tx.id === 'a')!;
    expect(purchase.status).toBe('month');
  });
});

describe('the link with the fixed expense standing for a purchase', () => {
  const included = async () => {
    const t = await seeded();
    await t.api.post(`${C}/include-purchases`, { transactionIds: ['a'], destination: 'fixed', fixedIds: ['fa'] });
    return t;
  };

  it('deleting the fixed row returns the purchase to unpaid', async () => {
    const { api, db } = await included();
    expect((await api.del('/api/fixed/fa')).status).toBeLessThan(300);
    const a = await find(db, 'a');
    expect(a.cardMonth).toBeUndefined();
    expect(a.cardFixedId).toBeUndefined();
    expect(cardPurchases(await state(db), OCT, 'visa').find((p) => p.tx.id === 'a')!.status).toBe('unpaid');
  });

  it('deleting the purchase deletes its fixed row', async () => {
    const { api, db } = await included();
    expect((await api.del('/api/transactions/a')).status).toBeLessThan(300);
    expect((await state(db)).months[OCT]!.fixed).toEqual([]);
  });

  it('moving the purchase outside the budget deletes its fixed row', async () => {
    const { api, db } = await included();
    expect((await api.post('/api/transactions/a/move-outside', {})).status).toBeLessThan(300);
    expect((await state(db)).months[OCT]!.fixed).toEqual([]);
  });

  it('editing the purchase edits its fixed row', async () => {
    const { api, db } = await included();
    await api.patch('/api/transactions/a', { amount: 250, desc: 'Renamed', cur: 'USD' });
    const f = (await state(db)).months[OCT]!.fixed[0] as FixedExpense;
    expect([f.name, f.amount, f.cur]).toEqual(['Renamed', 250, 'USD']);
    await api.patch('/api/transactions/a', { cardId: 'amex' });
    expect(((await state(db)).months[OCT]!.fixed[0] as FixedExpense).cardId).toBe('amex');
  });

  it('a purchase that stops being a Credit-card one loses the fixed row and the month', async () => {
    const { api, db } = await included();
    await api.patch('/api/transactions/a', { method: 'Debit card' });
    expect((await state(db)).months[OCT]!.fixed).toEqual([]);
    const a = await find(db, 'a');
    expect([a.cardMonth, a.cardFixedId]).toEqual([undefined, undefined]);
  });

  it('a purchase marked in the history that becomes a debit purchase loses its month', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/include-purchases`, { transactionIds: ['c'], destination: 'history' });
    await api.patch('/api/transactions/c', { method: 'Debit card' });
    expect((await find(db, 'c')).cardMonth).toBeUndefined();
  });

  it('the next month does not copy the fixed row of a purchase', async () => {
    const { api, db } = await included();
    await api.post('/api/fixed', { monthKey: OCT, name: 'Gym', amount: 10, cur: 'DOP' });
    const closed = await api.post<{ next: Month }>(`/api/months/${OCT}/close`);
    expect(closed.body.next.fixed.map((f) => f.name)).toEqual(['Gym']);
    expect((await state(db)).months[OCT]!.fixed.map((f) => f.id)).toContain('fa');
  });

  it('deleting the month returns the purchases added to it to unpaid', async () => {
    const t = await seeded();
    await t.api.post('/api/months/2026-09/reopen');
    await t.api.post(`${C}/include-purchases`, { transactionIds: ['sep'], destination: 'history' });
    expect((await find(t.db, 'sep')).cardMonth).toBe(OCT);
    expect((await t.api.del(`/api/months/${OCT}`)).status).toBeLessThan(300);
    expect((await find(t.db, 'sep')).cardMonth).toBeUndefined();
  });

  it('replaceAll keeps the columns when the month and the fixed row come along, and drops them otherwise', async () => {
    const { db } = await included();
    const s = await state(db);
    await replaceAll(db, FRANK.id, s);
    expect(await find(db, 'a')).toMatchObject({ cardMonth: OCT, cardFixedId: 'fa' });
    const noFixed = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, fixed: [] } } };
    await replaceAll(db, FRANK.id, noFixed);
    const a = await find(db, 'a');
    expect([a.cardMonth, a.cardFixedId]).toEqual([undefined, undefined]);
  });
});

describe('a purchase created after the deploy', () => {
  it('starts unpaid and out of the card total', async () => {
    const { api, db } = await seeded();
    const made = await api.post<Transaction>('/api/transactions', { monthKey: OCT, date: '2026-10-08', desc: 'New', cat: 'Food', method: 'Credit card', amount: 70, cur: 'DOP', cardId: 'visa' });
    expect(made.body.cardMonth).toBeUndefined();
    const s = await state(db);
    expect(cardCalc(s, OCT, 'visa').total).toBe(0);
    expect(cardOwed(s, OCT, 'visa')).toBeGreaterThan(70);
  });
});
