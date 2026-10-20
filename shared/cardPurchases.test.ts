// Per-purchase settlement: which Credit-card purchases belong to a card, in which currency, and which are settled.

import { describe, expect, it } from 'vitest';
import { cardCalc, cardPurchases, sumCardPurchases, unsettledCardPurchases } from './calc';
import { seedState } from './seed';
import type { AppState, CreditCard, Transaction } from './types';

const card = (id: string, sort: number, extra: Partial<CreditCard> = {}): CreditCard => ({
  id, name: id, bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort, ...extra,
});

const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});

/** Aug and Sep closed, Oct open (seed), with only the transactions given. */
function stateWith(txs: Transaction[], cards: CreditCard[], payments: Record<string, { id: string; date: string; accountId: string; amount: number }[]> = {}): AppState {
  const seed = seedState();
  const months = Object.fromEntries(
    Object.entries(seed.months).map(([key, m]) => [
      key,
      { ...m, tx: txs.filter((t) => t.monthKey === key), cards: payments[key] ? [{ cardId: 'visa', other: 0, payments: payments[key]! }] : undefined },
    ]),
  );
  return { ...seed, months, cards };
}

describe('cardPurchases', () => {
  const visa = card('visa', 0);
  const amex = card('amex', 1);

  it('matches the purchases of the card, and a purchase with no card goes to the first active one', () => {
    const state = stateWith(
      [
        tx('own', '2026-10', '2026-10-02', 100, { cardId: 'visa' }),
        tx('none', '2026-10', '2026-10-03', 200),
        tx('other', '2026-10', '2026-10-04', 50, { cardId: 'amex' }),
        tx('debit', '2026-10', '2026-10-05', 70, { method: 'Debit card' }),
      ],
      [visa, amex],
    );
    expect(cardPurchases(state, '2026-10', 'visa').map((p) => p.tx.id)).toEqual(['own', 'none']);
    expect(cardPurchases(state, '2026-10', 'amex').map((p) => p.tx.id)).toEqual(['other']);
    // The first active card changes if the first one is off.
    const off = { ...state, cards: [{ ...visa, active: false }, amex] };
    expect(cardPurchases(off, '2026-10', 'amex').map((p) => p.tx.id)).toEqual(['none', 'other']);
    expect(cardPurchases(state, '2026-10', 'nope')).toEqual([]);
  });

  it('takes the months up to the viewed one, oldest first', () => {
    const state = stateWith([tx('sep', '2026-09', '2026-09-20', 10), tx('oct', '2026-10', '2026-10-02', 20)], [visa]);
    expect(cardPurchases(state, '2026-10', 'visa').map((p) => p.tx.id)).toEqual(['sep', 'oct']);
    expect(cardPurchases(state, '2026-09', 'visa').map((p) => p.tx.id)).toEqual(['sep']);
  });

  it('counts each purchase in the card currency exactly as the card total does', () => {
    const state = stateWith([tx('usd', '2026-10', '2026-10-04', 10, { cur: 'USD' }), tx('dop', '2026-10', '2026-10-05', 100)], [visa]);
    const purchases = cardPurchases(state, '2026-10', 'visa');
    expect(purchases[0]!.amount).toBeCloseTo(587.6, 6);
    expect(purchases[1]!.amount).toBe(100);
    expect(sumCardPurchases(purchases)).toBeCloseTo(cardCalc(state, '2026-10', 'visa').charged, 2);
  });

  it('leaves out the settled ones, and a link to a payment that no longer exists counts as unsettled', () => {
    const pay = { id: 'p1', date: '2026-10-09', accountId: 'dr', amount: 100 };
    const state = stateWith(
      [tx('paid', '2026-10', '2026-10-02', 100, { cardPaymentId: 'p1' }), tx('open', '2026-10', '2026-10-03', 30), tx('dangling', '2026-10', '2026-10-04', 5, { cardPaymentId: 'gone' })],
      [visa],
      { '2026-10': [pay] },
    );
    const all = cardPurchases(state, '2026-10', 'visa');
    expect(all.find((p) => p.tx.id === 'paid')!.payment).toEqual({ id: 'p1', date: '2026-10-09', accountId: 'dr', key: '2026-10' });
    expect(unsettledCardPurchases(state, '2026-10', 'visa').map((p) => p.tx.id)).toEqual(['open', 'dangling']);
  });

  it('rounds the sum to cents', () => {
    expect(sumCardPurchases([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
    expect(sumCardPurchases([])).toBe(0);
  });
});
