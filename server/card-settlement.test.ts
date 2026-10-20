// Per-purchase settlement of credit-card purchases: migration 0015, the pay-purchases endpoint, removing the payment,
// and what happens to the link when the purchase or the payment goes away.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, unsettledCardPurchases } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { CreditCard, Month, Transaction } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { loadState, replaceAll } from './db';
import { client, FRANK, makeEnv } from './test-util';

const OCT = '2026-10';
const C = `/api/months/${OCT}/cards/visa`;
const card = (id: string, sort: number): CreditCard => ({ id, name: id, bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort });
const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});

describe('migration 0015', () => {
  const FILE = '0015_card_purchase_settlement.sql';
  it('keeps every transaction and adds the link column empty', () => {
    const files = migrationFiles();
    const at = files.indexOf(FILE);
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES ('frank', '2026-10', 0, NULL);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR', 'DOP', 1000, 0, 0);
      INSERT INTO credit_cards (user_id, id, name, currency, active, sort) VALUES ('frank', 'visa', 'Visa', 'DOP', 1, 0);
      INSERT INTO transactions (user_id, id, month_key, date, description, category, method, amount, currency, account_id, card_id) VALUES
        ('frank', 't1', '2026-10', '2026-10-03', 'Taxi', 'Transport', 'Credit card', 200, 'DOP', 'dr', 'visa');
    `);
    applyMigrations(db, [FILE]);
    expect(db.sqlite.prepare('SELECT id, amount, card_id, card_payment_id FROM transactions').all().map((r) => ({ ...r }))).toEqual([
      { id: 't1', amount: 200, card_id: 'visa', card_payment_id: null },
    ]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

/** Sep (closed) has one purchase; Oct (open) has three on Visa (one in USD) and one on Amex. Visa owes 887.6 in Oct. */
async function seeded() {
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
    ],
  };
  const months = Object.fromEntries(Object.entries(seed.months).map(([k, m]) => [k, { ...m, tx: byMonth[k] ?? [] }]));
  await replaceAll(t.db, FRANK.id, { ...seed, months, cards: [card('visa', 0), card('amex', 1)] });
  return { ...t, api: client(t.env) };
}

const state = (db: D1Database) => loadState(db, FRANK.id);
const linked = async (db: D1Database) =>
  Object.fromEntries(Object.values((await state(db)).months).flatMap((m) => m.tx).filter((t) => t.cardPaymentId).map((t) => [t.id, t.cardPaymentId]));

describe('POST pay-purchases', () => {
  it('writes one payment worth the sum and links every purchase, including an earlier month', async () => {
    const { api, db } = await seeded();
    const before = await state(db);
    const dr = (st: Awaited<ReturnType<typeof state>>) => balances(st, OCT).accounts.find((a) => a.account.id === 'dr')!.balance;
    const r = await api.post<Month>(`${C}/pay-purchases`, { transactionIds: ['sep', 'a'], accountId: 'dr', id: 'pay1' });
    expect(r.status).toBe(200);
    expect(r.body.cards![0]!.payments).toEqual([{ id: 'pay1', date: expect.any(String), accountId: 'dr', amount: 300 }]);
    expect(r.body.tx.find((t) => t.id === 'a')!.cardPaymentId).toBe('pay1');
    expect(await linked(db)).toEqual({ sep: 'pay1', a: 'pay1' });
    const after = await state(db);
    expect(cardCalc(after, OCT, 'visa').remainder).toBeCloseTo(cardCalc(before, OCT, 'visa').remainder - 300, 6);
    expect(unsettledCardPurchases(after, OCT, 'visa').map((p) => p.tx.id)).toEqual(['b', 'c']);
    expect(dr(after)).toBeCloseTo(dr(before) - 300, 6);
  });

  it('converts purchases in other currencies into the card currency', async () => {
    const { api } = await seeded();
    const r = await api.post<Month>(`${C}/pay-purchases`, { transactionIds: ['b'], accountId: 'dr' });
    expect(r.status).toBe(200);
    expect(r.body.cards![0]!.payments[0]!.amount).toBeCloseTo(587.6, 2);
  });

  it('refuses a sum above what is left and writes nothing', async () => {
    const { api, db } = await seeded();
    // Visa owes 100 + 200 + 587.6 + 5 = 892.6: pay 500 freely, then the 587.6 purchase no longer fits.
    expect((await api.post(`${C}/pay`, { amount: 500, accountId: 'dr' })).status).toBe(200);
    const r = await api.post(`${C}/pay-purchases`, { transactionIds: ['b'], accountId: 'dr' });
    expect([r.status, r.error?.code]).toEqual([400, 'validation']);
    expect(r.error?.message).toContain('left to pay');
    expect(await linked(db)).toEqual({});
    expect((await state(db)).months[OCT]!.cards![0]!.payments).toHaveLength(1);
  });

  it('refuses a purchase that was already paid', async () => {
    const { api } = await seeded();
    expect((await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr' })).status).toBe(200);
    const again = await api.post(`${C}/pay-purchases`, { transactionIds: ['a', 'c'], accountId: 'dr' });
    expect(again.status).toBe(400);
    expect(again.error?.message).toContain('already paid');
  });

  it('refuses purchases of another card, other methods, unknown ids and repeated ids', async () => {
    const { api } = await seeded();
    const other = await api.post(`${C}/pay-purchases`, { transactionIds: ['amex1'], accountId: 'dr' });
    expect([other.status, other.error?.message]).toEqual([400, expect.stringContaining('another card')]);
    const debit = await api.post(`${C}/pay-purchases`, { transactionIds: ['debit'], accountId: 'dr' });
    expect([debit.status, debit.error?.message]).toEqual([400, expect.stringContaining('not a Credit card purchase')]);
    const unknown = await api.post(`${C}/pay-purchases`, { transactionIds: ['a', 'nope'], accountId: 'dr' });
    expect([unknown.status, unknown.error?.message]).toEqual([400, expect.stringContaining('does not exist')]);
    expect((await api.post(`${C}/pay-purchases`, { transactionIds: ['a', 'a'], accountId: 'dr' })).status).toBe(400);
    expect((await api.post(`${C}/pay-purchases`, { transactionIds: [], accountId: 'dr' })).status).toBe(400);
    expect((await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr', amount: 1 })).status).toBe(400);
  });

  it('a closed month answers 409 and an unknown card 404', async () => {
    const { api, db } = await seeded();
    expect((await api.post(`/api/months/2026-09/cards/visa/pay-purchases`, { transactionIds: ['sep'], accountId: 'dr' })).status).toBe(409);
    expect((await api.post(`/api/months/${OCT}/cards/nope/pay-purchases`, { transactionIds: ['a'], accountId: 'dr' })).status).toBe(404);
    expect(await linked(db)).toEqual({});
  });

  it('a gold or unknown account answers 400 and writes neither the payment nor the links', async () => {
    const { api, db } = await seeded();
    await api.post('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100 });
    for (const accountId of ['gold', 'nope']) {
      const r = await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId });
      expect(r.status).toBe(400);
    }
    expect(await linked(db)).toEqual({});
    expect((await state(db)).months[OCT]!.cards).toBeUndefined();
  });

  it('a payment id that already exists answers 409 and links nothing', async () => {
    const { api, db } = await seeded();
    expect((await api.post(`${C}/pay`, { id: 'dup', amount: 10, accountId: 'dr' })).status).toBe(200);
    const r = await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr', id: 'dup' });
    expect(r.status).toBe(409);
    expect(await linked(db)).toEqual({});
  });
});

describe('removing the payment', () => {
  it('frees the purchases it covered, one payment at a time', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr', id: 'p1' });
    await api.post(`${C}/pay-purchases`, { transactionIds: ['c'], accountId: 'dr', id: 'p2' });
    expect(await linked(db)).toEqual({ a: 'p1', c: 'p2' });
    expect((await api.del(`${C}/pay/p1`)).status).toBe(200);
    expect(await linked(db)).toEqual({ c: 'p2' });
    expect((await api.del(`${C}/pay`)).status).toBe(200);
    expect(await linked(db)).toEqual({});
    expect(unsettledCardPurchases(await state(db), OCT, 'visa').map((p) => p.tx.id)).toEqual(['sep', 'a', 'b', 'c']);
  });

  it('an unknown payment answers 404 and frees nothing', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr', id: 'p1' });
    expect((await api.del(`${C}/pay/nope`)).status).toBe(404);
    expect(await linked(db)).toEqual({ a: 'p1' });
  });
});

describe('the link when the purchase or the payment changes', () => {
  it('deleting a settled purchase leaves the payment, and editing its amount does not change the payment', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/pay-purchases`, { transactionIds: ['a', 'c'], accountId: 'dr', id: 'p1' });
    expect((await api.patch('/api/transactions/a', { amount: 999 })).status).toBe(200);
    expect((await state(db)).months[OCT]!.cards![0]!.payments[0]!.amount).toBe(205);
    expect((await api.del('/api/transactions/c')).status).toBeLessThan(300);
    const s = await state(db);
    expect(s.months[OCT]!.cards![0]!.payments.map((p) => p.id)).toEqual(['p1']);
    expect(await linked(db)).toEqual({ a: 'p1' });
  });

  it('a purchase that stops being a purchase of this card is freed', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/pay-purchases`, { transactionIds: ['a', 'c'], accountId: 'dr', id: 'p1' });
    await api.patch('/api/transactions/a', { method: 'Debit card' });
    await api.patch('/api/transactions/c', { cardId: 'amex' });
    expect(await linked(db)).toEqual({});
    // Changing something else keeps the link.
    await api.post(`${C}/pay-purchases`, { transactionIds: ['sep'], accountId: 'dr', id: 'p2' });
    await api.patch('/api/transactions/sep', { notes: 'x', cardId: 'visa' });
    expect(await linked(db)).toEqual({ sep: 'p2' });
  });

  it('replaceAll keeps the link only when the purchase is a card purchase and its payment survives', async () => {
    const { api, db } = await seeded();
    await api.post(`${C}/pay-purchases`, { transactionIds: ['a'], accountId: 'dr', id: 'p1' });
    const s = await state(db);
    await replaceAll(db, FRANK.id, s);
    expect(await linked(db)).toEqual({ a: 'p1' });
    const noPayment = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, cards: undefined } } };
    await replaceAll(db, FRANK.id, noPayment);
    expect(await linked(db)).toEqual({});
  });
});
